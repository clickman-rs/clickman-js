import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boolean,
  catalog,
  CatalogError,
  createClickman,
  defineEvents,
  event,
  integer,
  number,
  oneOf,
  text,
  type Clickman,
  type Property,
} from "../src";
import { oneLine, snakeCase, STANDARD_EVENTS } from "../src/catalog";
import fixture from "../protocol/fixtures/catalog.json";
import standardEvents from "../protocol/standard-events.json";

// The reference events of catalog.json, declared as an application would:
// the event description over two lines, the `mode` description padded.
const events = defineEvents({
  ExportCompleted: event(
    `Export wrote every file
     and they are ready to use.`,
    {
      format: oneOf(["wav", "flac"], "File format of the export."),
      mode: oneOf(
        ["fullMix", "perTrack"],
        "  Whether one mix or one file per track was written.  ",
      ),
      tracks: integer("How many tracks the export contains."),
      durationSeconds: number(
        "Length of the exported audio in seconds.",
      ).optional(),
      normalized: boolean(
        "Whether loudness normalization was applied.",
      ).optional(),
      title: text("Title the user gave the export.").optional(),
    },
  ),
  ProjectCreated: event("A new empty project was created."),
});

type Declaration = (typeof fixture.declarations)[number];
/** Maps the language-neutral fixture types onto the builders. */
function declared({ type, description }: Declaration["properties"][number]) {
  const values = /^\w+: (.+)$/.exec(type)?.[1].split(" | ");
  if (values) return oneOf(values as [string, ...string[]], description);
  const builders: Record<string, (description: string) => Property> = {
    "unsigned integer": integer,
    "floating point": number,
    boolean,
    "free text": text,
  };
  if (!builders[type]) throw new Error(`Unknown fixture type ${type}`);
  return builders[type](description);
}

const clients: Clickman[] = [];
function client() {
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(
        JSON.stringify({ accepted: 1, duplicates: 0, rejected: [] }),
        {
          status: 202,
        },
      ),
  );
  const value = createClickman({
    endpoint: "https://analytics.example",
    writeKey: crypto.randomUUID(),
    consent: true,
    fetch,
    flushIntervalMs: 3600000,
  });
  clients.push(value);
  const sent = () =>
    fetch.mock.calls.flatMap(
      ([, request]) => JSON.parse(String(request?.body)).batch,
    );
  return { value, fetch, sent };
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((value) => value.close()));
});

function sampleEvent({
  event: name,
  ...properties
}: (typeof fixture.samples)[number]["value"]) {
  return events[name as keyof typeof events](properties as never);
}

describe("catalog.json", () => {
  it("exports the declared reference events exactly", () => {
    expect(catalog(events)).toStrictEqual(fixture.catalog);
  });
  it("declares the fixture declarations, property by property", () => {
    expect(Object.keys(events)).toEqual(
      fixture.declarations.map((d) => d.event),
    );
    for (const declaration of fixture.declarations) {
      const defined = events[declaration.event as keyof typeof events];
      expect(defined.description).toBe(
        oneLine(declaration.description.join("\n")),
      );
      const properties: Record<string, Property> = defined.properties;
      expect(Object.keys(properties)).toEqual(
        declaration.properties.map((p) => p.field),
      );
      for (const property of declaration.properties) {
        const actual = properties[property.field];
        const expected = declared(property);
        expect(actual.description).toBe(property.description);
        expect(actual.required).toBe(property.required);
        expect([actual.type, actual.values, actual.text]).toEqual([
          expected.type,
          expected.values,
          expected.text,
        ]);
      }
    }
  });
  it("exports the same catalog when declared from the fixture lines", () => {
    const generic = defineEvents(
      Object.fromEntries(
        fixture.declarations.map((declaration) => [
          declaration.event,
          event(
            declaration.description.join("\n"),
            Object.fromEntries(
              declaration.properties.map((property) => [
                property.field,
                property.required
                  ? declared(property)
                  : declared(property).optional(),
              ]),
            ),
          ),
        ]),
      ),
    );
    expect(catalog(generic)).toStrictEqual(fixture.catalog);
  });
  for (const sample of fixture.samples) {
    it(`builds ${sample.name}`, () => {
      expect(sampleEvent(sample.value)).toStrictEqual({
        event: sample.event,
        properties: sample.properties,
      });
    });
    it(`tracks ${sample.name}`, async () => {
      const { value, sent } = client();
      await value.track(sampleEvent(sample.value));
      await value.flush();
      const [tracked] = sent();
      expect(sent()).toHaveLength(1);
      expect(tracked.event).toBe(sample.event);
      expect(tracked.properties).toStrictEqual(sample.properties);
    });
  }
  it("tracks typed events with context next to string events", async () => {
    const { value, sent } = client();
    await value.track(events.ProjectCreated(), { screen: "start" });
    await value.track(
      "legacy_event",
      { anything: "goes" },
      { screen: "legacy" },
    );
    await value.flush();
    const [typed, legacy] = sent();
    expect([typed.event, typed.properties, typed.context.screen]).toEqual([
      "project_created",
      {},
      "start",
    ]);
    expect([legacy.event, legacy.properties, legacy.context.screen]).toEqual([
      "legacy_event",
      { anything: "goes" },
      "legacy",
    ]);
  });
  it("keeps the privacy filter on free text", async () => {
    const { value, sent } = client();
    await value.track(
      events.ExportCompleted({
        format: "wav",
        mode: "fullMix",
        tracks: 1,
        title: "for person@example.com",
      }),
    );
    await value.flush();
    expect(sent()[0].properties.title).toBe("[FILTERED]");
  });
});

describe("declarations", () => {
  it.each([
    ["ExportCompleted", "export_completed"],
    ["exportCompleted", "export_completed"],
    ["EXPORT_COMPLETED", "export_completed"],
    ["export_completed", "export_completed"],
    ["fullMix", "full_mix"],
    ["durationSeconds", "duration_seconds"],
    ["HTTPStatus", "http_status"],
    ["mp3Export", "mp3_export"],
    ["track2Name", "track2_name"],
    ["export-completed now", "export_completed_now"],
  ])("converts %s to %s", (declared, name) => {
    expect(snakeCase(declared)).toBe(name);
  });
  it("joins description lines with single spaces and trims them", () => {
    expect(
      oneLine("  Export wrote\r\n   every file\n\n  and they are ready. "),
    ).toBe("Export wrote every file and they are ready.");
    expect(defineEvents({ a: event("One\nTwo.") }).a.description).toBe(
      "One Two.",
    );
  });
  it("reserves the standard events", () => {
    expect(STANDARD_EVENTS).toEqual(standardEvents.events.map((e) => e.name));
    for (const name of ["AppOpened", "page_view", "APP_INSTALLED"])
      expect(() => defineEvents({ [name]: event("Mine.") })).toThrow(
        expect.objectContaining({ reason: "standard_event" }),
      );
  });
  const property = (extra: object) => ({
    type: "string",
    description: "B.",
    required: true,
    optional() {
      return this;
    },
    ...extra,
  });
  it.each([
    [
      "an event without a description",
      () => ({ a: event(" \n ") }),
      "missing_description",
    ],
    [
      "a property without a description",
      () => ({ a: event("A.", { b: text("") }) }),
      "missing_description",
    ],
    [
      "a description over 1,000 characters",
      () => ({ a: event("x".repeat(1001)) }),
      "invalid_description",
    ],
    [
      "a description with a control character",
      () => ({ a: event("A new\tproject.") }),
      "invalid_description",
    ],
    [
      "a property description with a NUL",
      () => ({ a: event("A.", { b: text("B\u0000.") }) }),
      "invalid_description",
    ],
    [
      "a name that cannot become snake case",
      () => ({ "1st": event("A.") }),
      "invalid_name",
    ],
    [
      "a name with other letters",
      () => ({ экспорт: event("A.") }),
      "invalid_name",
    ],
    [
      "an event name over 200 characters",
      () => ({ ["a".repeat(201)]: event("A.") }),
      "invalid_name",
    ],
    [
      "a property name over 128 characters",
      () => ({ a: event("A.", { ["b".repeat(129)]: text("B.") }) }),
      "invalid_name",
    ],
    [
      "two events with one name",
      () => ({ exportCompleted: event("A."), export_completed: event("B.") }),
      "duplicate_name",
    ],
    [
      "two properties with one name",
      () => ({
        a: event("A.", {
          trackCount: integer("B."),
          TRACK_COUNT: integer("C."),
        }),
      }),
      "duplicate_name",
    ],
    [
      "repeated values",
      () => ({ a: event("A.", { b: oneOf(["fullMix", "full_mix"], "B.") }) }),
      "invalid_values",
    ],
    [
      "more than 100 values",
      () => ({
        a: event("A.", {
          b: oneOf(
            Array.from({ length: 101 }, (_, i) => `v${i}`) as [string],
            "B.",
          ),
        }),
      }),
      "invalid_values",
    ],
    [
      "a value without letters or digits",
      () => ({ a: event("A.", { b: oneOf(["-"], "B.") }) }),
      "invalid_values",
    ],
    [
      "a string that is neither values nor text",
      () => ({ a: event("A.", { b: property({}) as never }) }),
      "undeclared_text",
    ],
    [
      "a string with both values and text",
      () => ({
        a: event("A.", { b: property({ values: ["x"], text: true }) as never }),
      }),
      "invalid_values",
    ],
    [
      "values on a number",
      () => ({
        a: event("A.", {
          b: property({ type: "integer", values: ["1"] }) as never,
        }),
      }),
      "invalid_values",
    ],
    [
      "an unknown type",
      () => ({ a: event("A.", { b: property({ type: "date" }) as never }) }),
      "invalid_type",
    ],
    [
      "a property without required",
      () => ({
        a: event("A.", {
          b: property({ required: undefined, text: true }) as never,
        }),
      }),
      "malformed_catalog",
    ],
    [
      "more than 128 properties",
      () => ({
        a: event(
          "A.",
          Object.fromEntries(
            Array.from({ length: 129 }, (_, i) => [`p${i}`, text("P.")]),
          ),
        ),
      }),
      "malformed_catalog",
    ],
  ])("refuses %s", (_name, declarations, reason) => {
    let error: unknown;
    try {
      defineEvents(declarations());
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(CatalogError);
    expect((error as CatalogError).reason).toBe(reason);
  });
  it("refuses more than 1,000 events in a catalog", () => {
    const declarations = (offset: number) =>
      defineEvents(
        Object.fromEntries(
          Array.from({ length: 500 }, (_, i) => [
            `e${offset + i}`,
            event("E."),
          ]),
        ),
      );
    const merged = { ...declarations(0), ...declarations(500) };
    expect(catalog(merged).events).toHaveLength(1000);
    expect(() =>
      catalog({ ...merged, ...defineEvents({ last: event("L.") }) }),
    ).toThrow(expect.objectContaining({ reason: "malformed_catalog" }));
    expect(() =>
      catalog({
        a: defineEvents({ a: event("A.") }).a,
        b: defineEvents({ a: event("B.") }).a,
      }),
    ).toThrow(expect.objectContaining({ reason: "duplicate_name" }));
  });
  it("exports a copy that callers cannot change", () => {
    const first = catalog(events);
    first.events[0].properties.length = 0;
    expect(catalog(events)).toStrictEqual(fixture.catalog);
  });
});

describe("typed events", () => {
  const valid = { format: "wav", mode: "fullMix", tracks: 1 } as const;
  it.each([
    ["an undeclared value", { ...valid, format: "mp3" }],
    ["an already converted value", { ...valid, mode: "full_mix" }],
    ["a fractional integer", { ...valid, tracks: 1.5 }],
    ["an unsafe integer", { ...valid, tracks: 2 ** 53 }],
    ["a string number", { ...valid, tracks: "1" }],
    ["an infinite number", { ...valid, durationSeconds: Infinity }],
    ["a string boolean", { ...valid, normalized: "true" }],
    ["text that is not a string", { ...valid, title: 42 }],
    ["null for an optional property", { ...valid, title: null }],
    ["a missing required property", { format: "wav", mode: "fullMix" }],
    ["an undeclared property", { ...valid, codec: "pcm" }],
    ["a converted property name", { ...valid, duration_seconds: 1 }],
  ])("refuses %s", (_name, properties) => {
    expect(() => events.ExportCompleted(properties as never)).toThrow(
      TypeError,
    );
  });
  it("leaves undefined optional properties out", () => {
    expect(
      events.ExportCompleted({ ...valid, title: undefined }),
    ).toStrictEqual({
      event: "export_completed",
      properties: { format: "wav", mode: "full_mix", tracks: 1 },
    });
  });
  it("refuses objects that were not built from a declaration", async () => {
    const { value, fetch } = client();
    await expect(
      value.track({ event: "export_completed", properties: {} } as never),
    ).rejects.toThrow("defineEvents");
    await value.flush();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses values from plain JavaScript that skip the builders", () => {
    expect(() =>
      defineEvents({ a: { description: "A.", properties: [] } as never }),
    ).toThrow(expect.objectContaining({ reason: "malformed_catalog" }));
    expect(() => catalog({ a: (() => ({})) as never })).toThrow(
      expect.objectContaining({ reason: "malformed_catalog" }),
    );
  });
});
