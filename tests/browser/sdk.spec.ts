import { test, expect } from "@playwright/test";
test("real IndexedDB survives offline reload and delivers an identity link through the fetch transport", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const key = crypto.randomUUID();
  const id = await page.evaluate(async (writeKey) => {
    const { createClickman } = await import("/clickman.js");
    const client = createClickman({
      endpoint: `${location.origin}/prefix`,
      writeKey,
      consent: true,
    });
    const id = await client.track("view", { email: "private@example.com" });
    await client.close();
    return id;
  }, key);
  await page.reload();
  await page.evaluate(async (writeKey) => {
    const { createClickman } = await import("/clickman.js");
    const client = createClickman({
      endpoint: `${location.origin}/prefix`,
      writeKey,
      consent: true,
    });
    await client.identify("browser-user");
    await client.track("purchase");
    await client.flush();
    await client.close();
  }, key);
  const rows = await (await request.get("/requests")).json();
  expect(rows.slice(-3).map((r: { path: string }) => r.path)).toEqual([
    "/prefix/v1/batch",
    "/prefix/v1/identify",
    "/prefix/v1/batch",
  ]);
  expect(rows.at(-3).body.batch[0].messageId).toBe(id);
  expect(rows.at(-3).body.batch[0].properties.email).toBe("[FILTERED]");
  expect(rows.at(-1).body.batch[0].externalId).toBe("browser-user");
});
test("standalone script build exposes the same API without collecting before consent", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.addScriptTag({ url: "/clickman.global.js" });
  const before = (await (await request.get("/requests")).json()).length;
  const result = await page.evaluate(async () => {
    const client = (
      window as unknown as { Clickman: typeof import("../../src") }
    ).Clickman.createClickman({
      endpoint: `${location.origin}/prefix`,
      writeKey: "no-consent",
      consent: false,
    });
    const result = await client.track("should-not-exist");
    await client.flush();
    await client.close();
    return result;
  });
  expect(result).toBeNull();
  expect((await (await request.get("/requests")).json()).length).toBe(before);
});
test("typed events from the ESM build reach the batch endpoint in catalog names", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const exported = await page.evaluate(async (writeKey) => {
    const {
      createClickman,
      defineEvents,
      event,
      oneOf,
      integer,
      text,
      catalog,
    } = await import("/clickman.js");
    const events = defineEvents({
      ExportCompleted: event("Export wrote every file.", {
        mode: oneOf(["fullMix", "perTrack"], "One mix or one file per track."),
        trackCount: integer("How many tracks the export contains."),
        title: text("Title the user gave the export.").optional(),
      }),
    });
    const client = createClickman({
      endpoint: `${location.origin}/prefix`,
      writeKey,
      consent: true,
    });
    await client.track(
      events.ExportCompleted({ mode: "perTrack", trackCount: 2 }),
    );
    await client.flush();
    await client.close();
    return catalog(events);
  }, crypto.randomUUID());
  expect(exported.events.map((e: { name: string }) => e.name)).toEqual([
    "export_completed",
  ]);
  const rows = await (await request.get("/requests")).json();
  const [tracked] = rows.at(-1).body.batch;
  expect(tracked.event).toBe("export_completed");
  expect(tracked.properties).toEqual({ mode: "per_track", track_count: 2 });
});
