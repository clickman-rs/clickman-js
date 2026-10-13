import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createClickman,
  deliveryOutcome,
  retryAfter,
  type Clickman,
} from "../src";
import { flatten, sanitize } from "../src/privacy";
import flattenFixture from "../protocol/fixtures/flatten.json";
import sanitizeFixture from "../protocol/fixtures/sanitize.json";
import outcomeFixture from "../protocol/fixtures/outcomes.json";
import { openDB } from "idb";
import { Queue } from "../src/store";

const clients: Clickman[] = [];
const success = () =>
  new Response(JSON.stringify({ accepted: 1, duplicates: 0, rejected: [] }), {
    status: 202,
  });
function client(
  fetch = vi.fn<typeof globalThis.fetch>(async () => success()),
  writeKey = crypto.randomUUID(),
  extra = {},
) {
  const value = createClickman({
    endpoint: "https://analytics.example/prefix",
    writeKey,
    consent: true,
    fetch,
    flushIntervalMs: 3600000,
    ...extra,
  });
  clients.push(value);
  return { value, fetch, writeKey };
}
function holdNextBatch() {
  const original = Queue.prototype.take;
  let resume!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const taken = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(Queue.prototype, "take").mockImplementationOnce(
    async function (owner) {
      const batch = await original.call(this, owner);
      entered();
      await held;
      return batch;
    },
  );
  return { taken, resume };
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("canonical wire fixtures", () => {
  for (const test of flattenFixture.cases)
    it(test.name, () => expect(flatten(test.input)).toEqual(test.output));
  for (const test of sanitizeFixture.cases)
    it(test.name, () => expect(sanitize(test.input)).toEqual(test.output));
  for (const test of outcomeFixture.cases)
    it(test.name, () =>
      expect(deliveryOutcome(test.status)).toBe(test.outcome),
    );
  it("supports seconds and HTTP date Retry-After", () => {
    expect(retryAfter("30", 0)).toBe(30000);
    expect(retryAfter("Thu, 01 Jan 1970 00:01:00 GMT", 0)).toBe(60000);
    expect(retryAfter("invalid")).toBe(0);
    expect(retryAfter("-3000", 0)).toBe(0);
    expect(retryAfter("12.5", 0)).toBe(0);
    expect(retryAfter("2010-01-01", 0)).toBe(0);
  });
});
describe("durable delivery", () => {
  it.each([
    ["event", (value: Clickman) => value.track("broken\ud800")],
    ["identity", (value: Clickman) => value.identify("broken\udfff")],
    [
      "property",
      (value: Clickman) => value.track("invalid", { label: "\ud800" }),
    ],
    [
      "context",
      (value: Clickman) => value.track("invalid", {}, { label: "\udfff" }),
    ],
    [
      "array property",
      (value: Clickman) => value.track("invalid", { labels: ["\ud800"] }),
    ],
    [
      "nested property",
      (value: Clickman) =>
        value.track("invalid", { nested: { label: "\udfff" } }),
    ],
    ["key", (value: Clickman) => value.track("invalid", { "\ud800": "value" })],
  ])(
    "rejects unpaired UTF-16 in %s without poisoning valid events",
    async (_name, invalid) => {
      const { value, fetch } = client();
      await value.track("before", { label: "🙂" });
      await expect(invalid(value)).rejects.toThrow();
      await value.track("after🌱", { label: "💚" });
      await value.flush();
      expect(fetch).toHaveBeenCalledOnce();
      const events = JSON.parse(String(fetch.mock.calls[0][1]?.body)).batch;
      expect(events.map((event: { event: string }) => event.event)).toEqual([
        "before",
        "after🌱",
      ]);
      expect(
        events.map(
          (event: { properties: { label: string } }) => event.properties.label,
        ),
      ).toEqual(["🙂", "💚"]);
    },
  );
  it("does not begin a request when consent is revoked while taking a batch", async () => {
    const held = holdNextBatch();
    const { value, fetch } = client();
    await value.track("queued");
    const pending = value.flush();
    await held.taken;
    await value.setConsent(false);
    held.resume();
    await pending;
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not send a cleared batch when consent is granted again before take resumes", async () => {
    const held = holdNextBatch();
    const { value, fetch } = client();
    await value.track("cleared");
    const pending = value.flush();
    await held.taken;
    await value.setConsent(false);
    await value.setConsent(true);
    held.resume();
    await pending;
    expect(fetch).not.toHaveBeenCalled();
    await value.track("after-regrant");
    await value.flush();
    expect(fetch).toHaveBeenCalledOnce();
    expect(
      JSON.parse(String(fetch.mock.calls[0][1]?.body)).batch.map(
        (event: { event: string }) => event.event,
      ),
    ).toEqual(["after-regrant"]);
  });
  it("expires data while a long Retry-After is still waiting", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const onDrop = vi.fn();
    const { value, fetch } = client(
      vi.fn(
        async () =>
          new Response("", {
            status: 429,
            headers: { "retry-after": `${60 * 86400}` },
          }),
      ),
      undefined,
      { onDrop },
    );
    await value.track("expired");
    await value.flush();
    vi.setSystemTime(Date.now() + 31 * 86400000);
    await value.flush();
    expect(fetch).toHaveBeenCalledOnce();
    expect(onDrop).toHaveBeenCalledWith(1, "queue_expired");
  });
  it("upgrades the first browser queue format without changing event IDs or identity", async () => {
    const writeKey = crypto.randomUUID();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `https://analytics.example/prefix/\n${writeKey}`,
      ),
    );
    const scope = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const legacy = await openDB(`clickman-v1-${scope}`, 1, {
      upgrade(database) {
        database.createObjectStore("entries", {
          keyPath: "id",
          autoIncrement: true,
        });
        database.createObjectStore("meta");
      },
    });
    const command = {
      kind: "track",
      event: {
        type: "track",
        messageId: crypto.randomUUID(),
        event: "before-upgrade",
        externalId: "existing-user",
        timestamp: new Date().toISOString(),
        properties: {},
        context: {},
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(command)).length;
    await legacy.add("entries", { created: Date.now(), bytes, command });
    await legacy.put(
      "meta",
      {
        anonymousId: `anon:${crypto.randomUUID()}`,
        externalId: "existing-user",
        count: 1,
        bytes,
        leaseUntil: 0,
        failures: 0,
        nextAttempt: 0,
      },
      "state",
    );
    legacy.close();

    const { value, fetch } = client(undefined, writeKey);
    await value.track("after-upgrade");
    await value.flush();
    const events = JSON.parse(String(fetch.mock.calls[0][1]?.body)).batch;
    expect(events.map((event: { event: string }) => event.event)).toEqual([
      "before-upgrade",
      "after-upgrade",
    ]);
    expect(events[0].messageId).toBe(command.event.messageId);
    expect(events[1].externalId).toBe("existing-user");
  });
  it("keeps the queue and transport bound to the source selected at initialization", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => success());
    const options = {
      endpoint: "https://analytics.example/prefix",
      writeKey: "original-source",
      consent: true,
      fetch,
      flushIntervalMs: 3600000,
    };
    const value = createClickman(options);
    clients.push(value);
    await value.track("view");
    options.writeKey = "other-source";
    await value.flush();
    expect(fetch.mock.calls[0][1]?.headers).toMatchObject({
      authorization: "Bearer original-source",
    });
  });
  it("does not acknowledge an event that cannot fit beside pending identity links", async () => {
    const { value, fetch } = client(undefined, undefined, {
      maxQueueEvents: 1,
    });
    await value.identify("user-42");
    await expect(value.track("cannot-fit")).rejects.toThrow("capacity");
    await value.flush();
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0][0])).toContain("/identify");
  });
  it("identifying the same account is idempotent even while offline", async () => {
    const { value, fetch } = client(undefined, undefined, {
      maxQueueEvents: 1,
    });
    await value.identify("user-42");
    await expect(value.identify("user-42")).resolves.toBe(true);
    await expect(value.identify("user-42")).resolves.toBe(true);
    await value.flush();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("expires rows regardless of insertion order after a device-clock correction", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const now = Date.now();
    const onDrop = vi.fn();
    const { value, fetch } = client(undefined, undefined, { onDrop });
    await value.track("fresh");
    vi.setSystemTime(now - 31 * 86400000);
    await value.track("expired");
    vi.setSystemTime(now);
    await value.flush();
    expect(
      JSON.parse(String(fetch.mock.calls[0][1]?.body)).batch.map(
        (event: { event: string }) => event.event,
      ),
    ).toEqual(["fresh"]);
    expect(onDrop).toHaveBeenCalledWith(1, "queue_expired");
  });
  it("reports expiration even when no events remain to send", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const onDrop = vi.fn();
    const { value, fetch } = client(undefined, undefined, { onDrop });
    await value.track("expired");
    vi.setSystemTime(Date.now() + 31 * 86400000);
    await value.flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(onDrop).toHaveBeenCalledWith(1, "queue_expired");
  });
  it("bounds browser timers while keeping a long Retry-After durable", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const { value, fetch } = client(
      vi.fn(
        async () =>
          new Response("", {
            status: 429,
            headers: { "retry-after": "2147483648" },
          }),
      ),
    );
    await value.track("view");
    await value.flush();
    expect(timeout.mock.calls.at(-1)?.[1]).toBeLessThanOrEqual(2147483647);
    vi.setSystemTime(Date.now() + 2147483647);
    await value.flush();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("survives reload with stable IDs, filters before persistence, and preserves endpoint prefixes", async () => {
    const first = client();
    const id = await first.value.track("view", {
      email: "person@example.com",
      nested: { label: "hello" },
    });
    await first.value.close();
    const next = client(undefined, first.writeKey);
    await next.value.flush();
    expect(next.fetch).toHaveBeenCalledOnce();
    const [url, request] = next.fetch.mock.calls[0];
    expect(String(url)).toBe("https://analytics.example/prefix/v1/batch");
    expect(request?.credentials).toBe("omit");
    const event = JSON.parse(String(request?.body)).batch[0];
    expect(event.messageId).toBe(id);
    expect(event.externalId).toMatch(/^anon:/);
    expect(event.properties).toEqual({
      email: "[FILTERED]",
      "nested.label": "hello",
    });
    await next.value.flush();
    expect(next.fetch).toHaveBeenCalledOnce();
  });
  it("keeps 401 and 429 batches and shares Retry-After across reloads", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const first = client(
      vi.fn(
        async () =>
          new Response("", { status: 429, headers: { "retry-after": "30" } }),
      ),
    );
    const id = await first.value.track("view");
    await first.value.flush();
    await first.value.flush();
    expect(first.fetch).toHaveBeenCalledOnce();
    await first.value.close();
    const next = client(undefined, first.writeKey);
    await next.value.flush();
    expect(next.fetch).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 31000);
    await next.value.flush();
    expect(
      JSON.parse(String(next.fetch.mock.calls[0][1]?.body)).batch[0].messageId,
    ).toBe(id);
    const unauthorized = client(
      vi.fn(async () => new Response("", { status: 401 })),
    );
    await unauthorized.value.track("view");
    await unauthorized.value.flush();
    await unauthorized.value.flush();
    expect(unauthorized.fetch).toHaveBeenCalledOnce();
  });
  it("refuses malformed batches once and reports individual rejections", async () => {
    const onDrop = vi.fn();
    const refused = client(
      vi.fn(async () => new Response("", { status: 400 })),
      undefined,
      { onDrop },
    );
    await refused.value.track("view");
    await refused.value.flush();
    await refused.value.flush();
    expect(refused.fetch).toHaveBeenCalledOnce();
    expect(onDrop).toHaveBeenCalledWith(1, "http_400");
    const partial = client(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              accepted: 0,
              rejected: [{ index: 0, reason: "invalid_event" }],
            }),
            { status: 202 },
          ),
      ),
      undefined,
      { onDrop },
    );
    await partial.value.track("view");
    await partial.value.flush();
    expect(onDrop).toHaveBeenCalledWith(1, "server_rejected");
  });
  it("delivers anonymous events then the durable link then user events", async () => {
    const { value, fetch } = client();
    await value.track("view");
    await value.identify("user-42");
    await value.track("purchase");
    await value.flush();
    const requests = fetch.mock.calls.map(([url, request]) => ({
      url: String(url),
      body: JSON.parse(String(request?.body)),
    }));
    expect(requests.map((r) => r.url.split("/").at(-1))).toEqual([
      "batch",
      "identify",
      "batch",
    ]);
    expect(requests[1].body.anonymousId).toBe(
      requests[0].body.batch[0].externalId,
    );
    expect(requests[2].body.batch[0].externalId).toBe("user-42");
    await expect(value.identify("other")).rejects.toThrow("reset");
    await value.reset();
    await value.track("view");
    await value.flush();
    const anonymous = JSON.parse(String(fetch.mock.calls[3][1]?.body)).batch[0]
      .externalId;
    expect(anonymous).not.toBe(requests[1].body.anonymousId);
  });
  it("does not lose pending links under bounded queue pressure", async () => {
    const { value, fetch } = client(undefined, undefined, {
      maxQueueEvents: 2,
    });
    await value.identify("user-42");
    await value.track("first");
    await value.track("latest");
    await value.flush();
    expect(String(fetch.mock.calls[0][0])).toContain("/identify");
    expect(
      JSON.parse(String(fetch.mock.calls[1][1]?.body)).batch.map(
        (e: { event: string }) => e.event,
      ),
    ).toEqual(["latest"]);
  });
  it("coordinates two instances with an IndexedDB lease", async () => {
    let release: (() => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return success();
    });
    const first = client(fetch);
    const second = client(fetch, first.writeKey);
    await first.value.track("view");
    const pending = first.value.flush();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await second.value.flush();
    expect(fetch).toHaveBeenCalledOnce();
    release!();
    await pending;
    await second.value.flush();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("never stores without consent and revocation clears queued data", async () => {
    const { value, fetch } = client(undefined, undefined, { consent: false });
    expect(await value.track("view")).toBeNull();
    expect(await value.identify("user-42")).toBe(false);
    await value.flush();
    expect(fetch).not.toHaveBeenCalled();
    await value.setConsent(true);
    await value.track("queued");
    await value.setConsent(false);
    await value.setConsent(true);
    await value.flush();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires literal true when changing consent through the plain-script API", async () => {
    for (const invalid of ["false", "true", 1, new Boolean(true)]) {
      const { value, fetch } = client();
      await value.track("queued-before-revocation");
      await value.setConsent(invalid as unknown as boolean);
      expect(await value.track("must-not-be-collected")).toBeNull();
      await value.setConsent(true);
      await value.flush();
      expect(fetch).not.toHaveBeenCalled();
    }
  });
  it("strips query and hash from opt-in page events and validates input", async () => {
    const { value, fetch } = client();
    await value.page(
      "https://site.example/checkout?email=secret@example.com#token",
    );
    await value.flush();
    expect(
      JSON.parse(String(fetch.mock.calls[0][1]?.body)).batch[0].properties.url,
    ).toBe("https://site.example/checkout");
    await expect(value.track("bad\nname")).rejects.toThrow();
    await expect(value.identify("*")).rejects.toThrow();
    await value.close();
    await expect(value.track("view")).rejects.toThrow("closed");
  });
});
describe("configuration", () => {
  for (const extra of [
    { maxQueueEvents: NaN },
    { maxQueueEvents: 0 },
    { maxQueueEvents: 1.5 },
    { maxQueueBytes: Infinity },
    { maxQueueBytes: -1 },
    { flushIntervalMs: NaN },
    { flushIntervalMs: 0 },
  ]) {
    it(`rejects invalid limits ${JSON.stringify(extra)}`, () => {
      expect(() => client(undefined, undefined, extra)).toThrow("positive");
    });
  }
});
