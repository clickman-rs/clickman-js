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
  });
});
describe("durable delivery", () => {
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
