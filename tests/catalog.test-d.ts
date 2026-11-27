import { describe, expectTypeOf, it } from "vitest";
import {
  boolean,
  catalog,
  createClickman,
  defineEvents,
  event,
  integer,
  number,
  oneOf,
  text,
  type Catalog,
  type EventInput,
  type TypedEvent,
} from "../src";

const events = defineEvents({
  export_completed: event(
    "Export wrote every file and they are ready to use.",
    {
      format: oneOf(["wav", "flac"], "File format of the export."),
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
  project_created: event("A new empty project was created."),
});
const clickman = createClickman({
  endpoint: "https://analytics.example",
  writeKey: "web",
  consent: false,
});

describe("typed events", () => {
  it("infers literal values, required and optional properties", () => {
    expectTypeOf<
      EventInput<typeof events.export_completed.properties>
    >().toEqualTypeOf<{
      format: "wav" | "flac";
      tracks: number;
      durationSeconds?: number;
      normalized?: boolean;
      title?: string;
    }>();
    expectTypeOf(
      events.export_completed({ format: "wav", tracks: 1 }),
    ).toEqualTypeOf<TypedEvent>();
    expectTypeOf(catalog(events)).toEqualTypeOf<Catalog>();
  });
  it("accepts typed events and keeps the string track", () => {
    expectTypeOf(
      clickman.track(events.project_created()),
    ).resolves.toEqualTypeOf<string | null>();
    expectTypeOf(
      clickman.track(events.project_created(), { screen: "start" }),
    ).resolves.toEqualTypeOf<string | null>();
    expectTypeOf(
      clickman.track("legacy", { any: "thing" }, { screen: "start" }),
    ).resolves.toEqualTypeOf<string | null>();
  });
  it("requires descriptions", () => {
    // @ts-expect-error A property needs a description.
    text();
    // @ts-expect-error A property needs a description.
    integer();
    // @ts-expect-error A property needs a description.
    oneOf(["wav", "flac"]);
    // @ts-expect-error An event needs a description.
    event();
    // @ts-expect-error An event needs a description before its properties.
    event({ format: text("File format.") });
  });
  it("refuses wrong values", () => {
    // @ts-expect-error mp3 is not a declared format.
    events.export_completed({ format: "mp3", tracks: 1 });
    // @ts-expect-error tracks is a number.
    events.export_completed({ format: "wav", tracks: "1" });
    // @ts-expect-error Optional properties are left out, never null.
    events.export_completed({ format: "wav", tracks: 1, title: null });
    // @ts-expect-error Values need at least one entry.
    oneOf([], "No values.");
  });
  it("refuses missing required and undeclared properties", () => {
    // @ts-expect-error tracks is required.
    events.export_completed({ format: "wav" });
    // @ts-expect-error format and tracks are required.
    events.export_completed();
    // @ts-expect-error codec is not declared.
    events.export_completed({ format: "wav", tracks: 1, codec: "pcm" });
    // @ts-expect-error project_created declares no properties.
    events.project_created({ format: "wav" });
  });
  it("refuses an undeclared event or a hand-made event", () => {
    // @ts-expect-error export_started is not declared.
    events.export_started();
    // @ts-expect-error A typed event takes context, not properties and context.
    clickman.track(events.project_created(), {}, {});
  });
});
