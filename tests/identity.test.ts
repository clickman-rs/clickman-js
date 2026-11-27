import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClickman, type Clickman, type Options } from "../src";
import { linkOutcome } from "../src/delivery";
import { Queue, uuidv7, type Command } from "../src/store";
import fixture from "../protocol/fixtures/identity.json";

type Case = (typeof fixture.cases)[number];
type Step = Case["steps"][number] & {
  identifyInstallation?: boolean;
  track?: string;
  identify?: string;
  reset?: boolean;
  error?: boolean;
};
type Row = {
  track?: string;
  externalId?: string;
  link?: { anonymousId: string; externalId: string };
};

/**
 * Native-store cases that cannot happen in the browser. A browser client has a
 * visitor from its first event and `reset()` starts the next one at once, so
 * `identifyInstallation` steps are no-ops and the native `*` actor is the
 * current browser visitor.
 */
const nativeOnly: Record<string, string> = {
  "without an installation identity nothing is linked":
    "a browser client always tracks as a visitor, so identify links it",
  "identifying the anonymous actor links nothing":
    "the browser SDK refuses `*` (and visitor IDs) as an account",
};
/** Intentional browser behavior: switching accounts requires `reset()`. */
const browserRefuses: Record<string, { step: number; actor: string }> = {
  "switching accounts without a visitor links nothing": {
    step: 2,
    actor: "user_42",
  },
};

const clients: Clickman[] = [];
function client(fetch: typeof globalThis.fetch, extra: Partial<Options> = {}) {
  const value = createClickman({
    endpoint: "https://analytics.example/prefix",
    writeKey: crypto.randomUUID(),
    consent: true,
    fetch,
    flushIntervalMs: 3600000,
    ...extra,
  });
  clients.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((value) => value.close()));
  vi.useRealTimers();
});

/** The fixture case as the browser sees it: `*` is the visitor that is current at that point. */
function inBrowser(test: Case) {
  const steps: Step[] = test.steps.map((step) => ({ ...step }));
  const queue: Row[] = structuredClone(test.queue);
  let actor = test.actor;
  const refusal = browserRefuses[test.name];
  if (refusal) {
    steps[refusal.step].error = true;
    actor = refusal.actor;
  }
  let visitor = 1;
  let row = 0;
  for (const step of steps) {
    if (step.error) continue;
    if (step.reset) visitor++;
    if (step.track !== undefined && queue[row]?.track === step.track) {
      if (queue[row].externalId === "*")
        queue[row].externalId = `visitor ${visitor}`;
      row++;
    }
    if (
      step.identify !== undefined &&
      queue[row]?.link?.externalId === step.identify
    )
      row++;
  }
  return { steps, queue, actor: actor === "*" ? `visitor ${visitor}` : actor };
}

describe("identity.json cases", () => {
  for (const test of fixture.cases) {
    const skipped = nativeOnly[test.name];
    if (skipped) {
      it.skip(`${test.name} (native only: ${skipped})`, () => {});
      continue;
    }
    it(test.name, async () => {
      const expected = inBrowser(test);
      const requests: {
        path: string;
        body: { batch?: { event: string; externalId: string }[] } & Row["link"];
      }[] = [];
      const value = client(async (url, request) => {
        const path = new URL(String(url)).pathname;
        requests.push({ path, body: JSON.parse(String(request?.body)) });
        return path.endsWith("/v1/identify")
          ? new Response(null, { status: 204 })
          : new Response(
              JSON.stringify({ accepted: 1, duplicates: 0, rejected: [] }),
              { status: 202 },
            );
      });
      for (const [index, step] of expected.steps.entries()) {
        // The browser always has a visitor: there is no installation identity to make.
        if (step.identifyInstallation) continue;
        const action =
          step.track !== undefined
            ? value.track(step.track)
            : step.identify !== undefined
              ? value.identify(step.identify)
              : value.reset();
        if (browserRefuses[test.name]?.step === index)
          await expect(action).rejects.toThrow("reset()");
        else if (step.error) await expect(action).rejects.toThrow();
        else await action;
      }
      // `actor` is what later events carry.
      await value.track("later");
      await value.flush();
      const rows: Row[] = requests.flatMap(({ path, body }) =>
        path.endsWith("/v1/identify")
          ? [
              {
                link: {
                  anonymousId: body.anonymousId!,
                  externalId: body.externalId!,
                },
              },
            ]
          : body.batch!.map((e) => ({
              track: e.event,
              externalId: e.externalId,
            })),
      );
      const visitors = new Map<string, string>();
      const id = (label: string, actual: unknown) => {
        if (!label.startsWith("visitor ")) return label;
        if (!visitors.has(label)) {
          expect(actual).toMatch(
            /^anon:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
          expect([...visitors.values()]).not.toContain(actual);
          visitors.set(label, actual as string);
        }
        return visitors.get(label);
      };
      const wanted = [
        ...expected.queue,
        { track: "later", externalId: expected.actor },
      ].map((row, index) => {
        const actual = rows[index];
        return row.link
          ? {
              link: {
                anonymousId: id(
                  row.link.anonymousId,
                  actual?.link?.anonymousId,
                ),
                externalId: id(row.link.externalId, actual?.link?.externalId),
              },
            }
          : {
              track: row.track,
              externalId: id(row.externalId!, actual?.externalId),
            };
      });
      expect(rows).toEqual(wanted);
    });
  }
});

describe("identity.json takes", () => {
  for (const test of fixture.takes.cases)
    it(test.name, async () => {
      const queue = await Queue.open(crypto.randomUUID(), 10_000, 5_000_000);
      try {
        for (const row of test.rows)
          await queue.append((state): Command =>
            row === "link"
              ? {
                  kind: "identify",
                  anonymousId: state.anonymousId,
                  externalId: "user_42",
                }
              : {
                  kind: "track",
                  event: {
                    type: "track",
                    messageId: uuidv7(),
                    event: "a",
                    externalId: state.externalId,
                    timestamp: new Date().toISOString(),
                    properties: {},
                    context: {},
                  },
                },
          );
        const taken: string[][] = [];
        for (let take = 0; take <= test.rows.length; take++) {
          const { rows } = await queue.take("owner");
          if (!rows.length) break;
          taken.push(
            rows.map(({ command }) =>
              command.kind === "identify" ? "link" : "track",
            ),
          );
          await queue.finish("owner", rows, true, 0);
        }
        expect(taken).toEqual(test.taken);
      } finally {
        queue.db.close();
      }
    });
});

describe("identity.json request", () => {
  it(fixture.request.description, async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 204 }),
    );
    const writeKey = crypto.randomUUID();
    const value = createClickman({
      endpoint: "https://analytics.example/prefix",
      writeKey,
      consent: true,
      fetch,
      flushIntervalMs: 3600000,
    });
    clients.push(value);
    await value.identify(fixture.request.body.externalId);
    await value.flush();
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://analytics.example/prefix/v1/identify");
    expect(request?.method).toBe("POST");
    expect(request?.headers).toEqual({
      authorization: `Bearer ${writeKey}`,
      "content-type": "application/json",
    });
    expect(typeof request?.body).toBe("string");
    const body = JSON.parse(String(request?.body));
    expect(Object.keys(body)).toEqual(Object.keys(fixture.request.body));
    expect(body.externalId).toBe(fixture.request.body.externalId);
    expect(body.anonymousId).toMatch(/^anon:[0-9a-f-]{36}$/);
  });
});

describe("identity.json outcomes", () => {
  for (const test of fixture.outcomes.cases)
    it(`${test.name}: ${test.status} is ${test.outcome}`, async () => {
      expect(linkOutcome(test.status)).toBe(test.outcome);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      let status = test.status;
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        // Status 0 is no response at all.
        if (!status) throw new TypeError("Failed to fetch");
        return new Response(null, { status });
      });
      const onDrop = vi.fn();
      const value = client(fetch, { onDrop, onError: () => {} });
      await value.identify("user_42");
      await value.flush();
      expect(fetch).toHaveBeenCalledOnce();
      // After the longest backoff the next attempt sends a link that was kept.
      status = 204;
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await value.flush();
      expect(fetch).toHaveBeenCalledTimes(test.outcome === "retry" ? 2 : 1);
      expect(onDrop.mock.calls).toEqual(
        test.outcome === "refused" ? [[1, `http_${test.status}`]] : [],
      );
    });
});
