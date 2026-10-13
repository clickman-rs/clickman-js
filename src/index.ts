import { Queue, uuidv7, fresh } from "./store";
import { prepared, validUnicode, type Properties } from "./privacy";
import {
  configuration,
  MAX_TIMER_DELAY,
  VERSION,
  type Options,
} from "./configuration";
import { deliveryOutcome, retryAfter, requestBody } from "./delivery";
export type { Properties, Json, Scalar } from "./privacy";
export type { Options } from "./configuration";
export { deliveryOutcome, retryAfter } from "./delivery";
function text(value: string, max: number) {
  if (
    typeof value !== "string" ||
    !value.length ||
    !validUnicode(value) ||
    Array.from(value).length > max ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
    throw new Error("Invalid event or identity.");
  return value;
}
export function createClickman(options: Options) {
  const { base, writeKey, maxCount, maxBytes, flushInterval } =
    configuration(options);
  let consent = options.consent === true;
  let consentGeneration = 0;
  let queue: Promise<Queue> | null = null;
  let closed = false;
  let inflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lifetime = new AbortController();
  const owner = uuidv7();
  const report = (cause: unknown) => {
    const error =
      cause instanceof Error ? cause : new Error("Analytics operation failed.");
    try {
      options.onError?.(error);
    } catch {
      /* Host diagnostics must not alter delivery. */
    }
  };
  const dropped = (count: number, reason: string) => {
    try {
      if (count) options.onDrop?.(count, reason);
    } catch {
      /* Host diagnostics are isolated. */
    }
  };
  const live = () => {
    if (closed) throw new Error("Clickman has been closed.");
    lifetime.signal.throwIfAborted();
  };
  const storage = () => {
    live();
    if (!queue)
      queue = (async () => {
        if (typeof indexedDB === "undefined")
          throw new Error(
            "Clickman needs browser IndexedDB. Initialize it after mounting the application.",
          );
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`${base.href}\n${writeKey}`),
        );
        const scope = Array.from(new Uint8Array(digest), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        return Queue.open(scope, maxCount, maxBytes);
      })().catch((error) => {
        queue = null;
        throw error;
      });
    return queue;
  };
  const schedule = (delay = flushInterval) => {
    if (closed || !consent) return;
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        void flush().catch(report);
      },
      Math.min(MAX_TIMER_DELAY, Math.max(delay, 20)),
    );
  };
  async function flush() {
    live();
    if (!consent) return;
    if (inflight) return inflight;
    const generation = consentGeneration;
    inflight = (async () => {
      const store = await storage();
      for (
        let run = 0;
        run < 20 && !closed && consent && generation === consentGeneration;
        run++
      ) {
        const taken = await store.take(owner);
        if (closed || !consent || generation !== consentGeneration) {
          await store.release(owner);
          schedule(20);
          return;
        }
        dropped(taken.dropped, "queue_expired");
        if (!taken.rows.length) {
          schedule(taken.wait || undefined);
          return;
        }
        const first = taken.rows[0].command;
        const { path, body } = requestBody(taken.rows);
        try {
          const signal = AbortSignal.any([
            lifetime.signal,
            AbortSignal.timeout(25000),
          ]);
          const response = await (options.fetch ?? fetch)(new URL(path, base), {
            method: "POST",
            credentials: "omit",
            redirect: "error",
            headers: {
              authorization: `Bearer ${writeKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
            signal,
          });
          // Identify validation errors are permanent; batch handling follows v1 fixtures.
          const outcome =
            first.kind === "identify" && response.status === 422
              ? "refused"
              : deliveryOutcome(response.status);
          const wait = await store.finish(
            owner,
            taken.rows,
            outcome !== "retry",
            retryAfter(response.headers.get("retry-after")),
          );
          if (outcome === "refused")
            dropped(taken.rows.length, `http_${response.status}`);
          if (outcome === "delivered" && first.kind === "track") {
            const ack = (await response.json().catch(() => null)) as {
              rejected?: unknown[];
            } | null;
            if (Array.isArray(ack?.rejected))
              dropped(ack.rejected.length, "server_rejected");
          }
          if (outcome === "retry") {
            schedule(wait);
            return;
          }
        } catch (error) {
          if (closed) {
            await store.release(owner);
            return;
          }
          const wait = await store.finish(owner, taken.rows, false, 0);
          report(error);
          schedule(wait);
          return;
        }
      }
      schedule(20);
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }
  async function track(
    event: string,
    properties: Properties = {},
    context: Properties = {},
  ) {
    live();
    if (!consent) return null;
    text(event, 200);
    const fragments = options.filterFragments ?? [];
    const eventProperties = prepared(properties, 128, fragments);
    const eventContext = prepared(
      {
        ...options.context,
        ...context,
        library: { name: "clickman-js", version: VERSION },
        device: { type: "web" },
      },
      64,
      fragments,
    );
    const store = await storage();
    live();
    if (!consent) return null;
    const messageId = uuidv7();
    const result = await store.append((state) => ({
      kind: "track",
      event: {
        type: "track",
        messageId,
        event,
        externalId: state.externalId,
        timestamp: new Date().toISOString(),
        properties: eventProperties,
        context: eventContext,
      },
    }));
    dropped(result.dropped, "queue_capacity");
    schedule(result.count >= 20 ? 20 : undefined);
    return messageId;
  }
  async function identify(externalId: string) {
    live();
    if (!consent) return false;
    text(externalId, 256);
    if (externalId === "*" || externalId.startsWith("anon:"))
      throw new Error("Use an opaque user ID, not an email or anonymous ID.");
    const store = await storage();
    live();
    if (!consent) return false;
    const result = await store.append((state) => {
      if (state.externalId === externalId) return null;
      if (
        state.externalId !== state.anonymousId &&
        state.externalId !== externalId
      )
        throw new Error("Call reset() before identifying another user.");
      state.externalId = externalId;
      return { kind: "identify", anonymousId: state.anonymousId, externalId };
    });
    dropped(result.dropped, "queue_capacity");
    schedule(20);
    return true;
  }
  async function reset() {
    live();
    if (!consent) return;
    const store = await storage();
    await store.change(async (state) => {
      const identity = fresh();
      state.anonymousId = identity.anonymousId;
      state.externalId = identity.externalId;
    });
  }
  async function setConsent(value: boolean) {
    live();
    consent = value === true;
    clearTimeout(timer);
    if (!consent) {
      consentGeneration++;
      if (queue) await (await queue).clear();
    } else schedule(20);
  }
  async function page(
    url: string = globalThis.location?.href ?? "",
    properties: Properties = {},
  ) {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    parsed.username = "";
    parsed.password = "";
    return track("page_view", {
      ...properties,
      url: parsed.href,
      path: parsed.pathname,
    });
  }
  const onOnline = () => {
    if (consent && !closed) void flush().catch(report);
  };
  const onHidden = () => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    )
      onOnline();
  };
  globalThis.addEventListener?.("online", onOnline);
  globalThis.addEventListener?.("pagehide", onOnline);
  globalThis.document?.addEventListener("visibilitychange", onHidden);
  schedule();
  async function close() {
    if (closed) return;
    closed = true;
    lifetime.abort();
    clearTimeout(timer);
    globalThis.removeEventListener?.("online", onOnline);
    globalThis.removeEventListener?.("pagehide", onOnline);
    globalThis.document?.removeEventListener("visibilitychange", onHidden);
    await inflight?.catch(() => undefined);
    if (queue) {
      const store = await queue.catch(() => null);
      if (store) {
        await store.release(owner);
        store.db.close();
      }
    }
  }
  return { track, identify, reset, flush, page, setConsent, close };
}
export type Clickman = ReturnType<typeof createClickman>;
/** Opt-in helper for SPA navigation; call the returned function on unmount. */
export function trackNavigation(client: Clickman) {
  if (typeof window === "undefined") return () => {};
  let last = "";
  const poll = () => {
    const url = new URL(location.href);
    const path = `${url.origin}${url.pathname}`;
    if (last !== path) {
      last = path;
      void client.page(path).catch(() => undefined);
    }
  };
  poll();
  const timer = setInterval(poll, 500);
  window.addEventListener("popstate", poll);
  return () => {
    clearInterval(timer);
    window.removeEventListener("popstate", poll);
  };
}
