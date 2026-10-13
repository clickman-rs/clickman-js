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
