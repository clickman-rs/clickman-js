import { validUnicode } from "./privacy";

/** The type of a catalog property. */
export type PropertyType = "string" | "integer" | "number" | "boolean";
/** A property value on the wire. Optional properties are left out, never `null`. */
export type PropertyValue = string | number | boolean;

/** A property of `catalog.json`. A `string` has exactly one of `values` and `text`. */
export interface CatalogProperty {
  name: string;
  description: string;
  type: PropertyType;
  values?: string[];
  text?: true;
  required: boolean;
}
/** An event of `catalog.json`. */
export interface CatalogEvent {
  name: string;
  description: string;
  properties: CatalogProperty[];
}
/** The catalog of a source (`protocol/fixtures/catalog.json`). */
export interface Catalog {
  version: 1;
  events: CatalogEvent[];
}

/** The catalog reasons of `protocol/fixtures/catalog.json` that a declaration can break. */
export type CatalogErrorReason =
  | "malformed_catalog"
  | "invalid_name"
  | "duplicate_name"
  | "missing_description"
  | "invalid_description"
  | "invalid_type"
  | "undeclared_text"
  | "invalid_values"
  | "standard_event";

/** Thrown by `defineEvents` and `catalog` for a declaration the server would refuse. */
export class CatalogError extends Error {
  readonly reason: CatalogErrorReason;
  constructor(reason: CatalogErrorReason, message: string) {
    super(`${message} (${reason})`);
    this.name = "CatalogError";
    this.reason = reason;
  }
}

/**
 * A declared property. `Value` is the type a tracked event takes, `Required`
 * whether every event carries it.
 */
export interface Property<Value = unknown, Required extends boolean = boolean> {
  readonly type: PropertyType;
  readonly description: string;
  readonly required: Required;
  /** The only strings the property takes, as declared. */
  readonly values?: readonly string[];
  /** A free-text string. */
  readonly text?: true;
  /** The same property, left out of an event when absent. */
  optional(): Property<Value, false>;
  /** Type-level only: never present at runtime. */
  readonly "~value"?: Value;
}
export type PropertyDeclarations = { readonly [name: string]: Property };

/** A declared event: what it means and the properties it carries. */
export interface EventDeclaration<
  P extends PropertyDeclarations = PropertyDeclarations,
> {
  readonly description: string;
  readonly properties: P;
}

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type ValueOf<T> = T extends Property<infer Value> ? Value : never;
/** The properties of a typed event, keyed and valued as declared. */
export type EventInput<P extends PropertyDeclarations> = Simplify<
  {
    [K in keyof P as P[K] extends Property<unknown, true> ? K : never]: ValueOf<
      P[K]
    >;
  } & {
    [
      K in keyof P as P[K] extends Property<unknown, true> ? never : K
    ]?: ValueOf<P[K]>;
  }
>;

/** An event built from a declaration, ready for `track`. */
export interface TypedEvent {
  /** The catalog name, as sent on the wire. */
  readonly event: string;
  /** Catalog names and values; absent optional properties are left out. */
  readonly properties: { readonly [name: string]: PropertyValue };
}

/** Builds a typed event; it can be called without arguments when no property is required. */
export interface EventDefinition<
  P extends PropertyDeclarations = PropertyDeclarations,
> {
  (
    ...properties: [keyof P] extends [never]
      ? [properties?: { readonly [name: string]: never }]
      : {} extends EventInput<P>
        ? [properties?: EventInput<P>]
        : [properties: EventInput<P>]
  ): TypedEvent;
  /** The catalog name. */
  readonly event: string;
  /** The catalog description, on one line. */
  readonly description: string;
  readonly properties: P;
}
export type EventDeclarations = {
  readonly [name: string]: EventDeclaration<any>;
};
export type DefinedEvents<D extends EventDeclarations> = {
  readonly [K in keyof D]: EventDefinition<D[K]["properties"]>;
};

/** Events the SDKs record themselves (`protocol/standard-events.json`). */
export const STANDARD_EVENTS: readonly string[] = Object.freeze([
  "app_installed",
  "app_updated",
  "app_opened",
  "app_backgrounded",
  "page_view",
]);
const TYPES: readonly string[] = ["string", "integer", "number", "boolean"];
const NAME = /^[a-z][a-z0-9_]*$/;
const LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/;
const CONTROL = /\p{Cc}/u;
const length = (value: string) => Array.from(value).length;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const entries = new WeakMap<object, CatalogEvent>();
const built = new WeakSet<object>();

type Mode = "boundary" | "lower" | "upper";
/**
 * The snake case form of a declared name or value. Words split at every
 * character that is not a letter or digit, before an uppercase letter that
 * follows a lowercase one (digits may sit between them) and before the last
 * capital of an uppercase run followed by a lowercase letter; words are
 * lowercased and joined with `_`. `ExportCompleted`, `exportCompleted` and
 * `EXPORT_COMPLETED` all become `export_completed`, `HTTPStatus` becomes
 * `http_status` and `mp3Export` becomes `mp3_export`.
 */
export function snakeCase(name: string) {
  const isLower = (c: string) => /\p{Lowercase}/u.test(c);
  const isUpper = (c: string) => /\p{Uppercase}/u.test(c);
  const words: string[] = [];
  for (const part of name.split(/[^\p{Alphabetic}\p{N}]+/u)) {
    const chars = Array.from(part);
    let start = 0;
    let mode: Mode = "boundary";
    for (let index = 0; index < chars.length; index++) {
      const char = chars[index];
      const next = chars[index + 1];
      if (next === undefined) {
        words.push(chars.slice(start).join(""));
        break;
      }
      const nextMode: Mode = isLower(char)
        ? "lower"
        : isUpper(char)
          ? "upper"
          : mode;
      if (nextMode === "lower" && isUpper(next)) {
        words.push(chars.slice(start, index + 1).join(""));
        start = index + 1;
        mode = "boundary";
      } else if (mode === "upper" && isUpper(char) && isLower(next)) {
        words.push(chars.slice(start, index).join(""));
        start = index;
        mode = "boundary";
      } else mode = nextMode;
    }
  }
  return words.map((word) => word.toLowerCase()).join("_");
}

/** A description on one line: every line trimmed, blank lines dropped, the rest joined with single spaces. */
export function oneLine(description: string) {
  return description
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function described(value: unknown, what: string) {
  const line = typeof value === "string" ? oneLine(value) : "";
  if (!line)
    throw new CatalogError(
      "missing_description",
      `${what} needs a description.`,
    );
  if (length(line) > 1000 || !validUnicode(line) || CONTROL.test(line))
    throw new CatalogError(
      "invalid_description",
      `${what} needs a description of 1-1,000 valid Unicode characters without control characters.`,
    );
  return line;
}

function named(declared: string, max: number, what: string) {
  const name = snakeCase(declared);
  if (!NAME.test(name) || name.length > max)
    throw new CatalogError(
      "invalid_name",
      `${what} ${JSON.stringify(declared)} must become a snake case name of at most ${max} characters, got ${JSON.stringify(name)}.`,
    );
  return name;
}

function declare<Value>(
  type: PropertyType,
  description: string,
  kind: { values: readonly string[] } | { text: true } | {},
): Property<Value, true> {
  const make = (required: boolean): Property<Value, any> =>
    Object.freeze({
      type,
      description,
      required,
      ...kind,
      optional: () => make(false),
    });
  return make(true);
}

/** A free-text string. Declare free text explicitly: it can carry personal data. */
export function text(description: string): Property<string, true> {
  return declare("string", description, { text: true });
}
/** A string that takes only the given values, sent in snake case. */
export function oneOf<const Values extends readonly [string, ...string[]]>(
  values: Values,
  description: string,
): Property<Values[number], true> {
  // A non-array from plain JavaScript is kept as is and refused by defineEvents.
  return declare("string", description, {
    values: Array.isArray(values) ? Object.freeze([...values]) : values,
  });
}
/** A safe integer. */
export function integer(description: string): Property<number, true> {
  return declare("integer", description, {});
}
/** A finite number. */
export function number(description: string): Property<number, true> {
  return declare("number", description, {});
}
export function boolean(description: string): Property<boolean, true> {
  return declare("boolean", description, {});
}
/** An event with what it means and the properties it carries. */
export function event(description: string): EventDeclaration<{}>;
export function event<P extends PropertyDeclarations>(
  description: string,
  properties: P,
): EventDeclaration<P>;
export function event(
  description: string,
  properties: PropertyDeclarations = {},
): EventDeclaration {
  return Object.freeze({ description, properties });
}

interface Field {
  key: string;
  catalog: CatalogProperty;
  convert: (value: unknown) => PropertyValue;
}

function field(key: string, declaration: unknown, event: string): Field {
  const what = `Property ${key} of event ${event}`;
  if (!isObject(declaration))
    throw new CatalogError(
      "malformed_catalog",
      `${what} must be declared with text, oneOf, integer, number or boolean.`,
    );
  const name = named(key, 128, `Property of event ${event}`);
  const { type, required, values } = declaration;
  if (typeof type !== "string" || !TYPES.includes(type))
    throw new CatalogError("invalid_type", `${what} has an unknown type.`);
  if (typeof required !== "boolean")
    throw new CatalogError(
      "malformed_catalog",
      `${what} must say whether it is required.`,
    );
  const description = described(declaration.description, what);
  const text = declaration.text !== undefined;
  const listed = values !== undefined;
  if (type !== "string" && (text || listed))
    throw new CatalogError(
      "invalid_values",
      `${what} is not a string and takes no values.`,
    );
  if (type === "string" && text && listed)
    throw new CatalogError(
      "invalid_values",
      `${what} is either free text or takes values, not both.`,
    );
  if (type === "string" && !text && !listed)
    throw new CatalogError(
      "undeclared_text",
      `${what} must be declared with text or oneOf.`,
    );
  if (text && declaration.text !== true)
    throw new CatalogError(
      "malformed_catalog",
      `${what} must declare text as true.`,
    );
  const allowed = new Map<unknown, string>();
  if (listed) {
    if (!Array.isArray(values) || values.length < 1 || values.length > 100)
      throw new CatalogError("invalid_values", `${what} needs 1-100 values.`);
    for (const value of values) {
      const wire = typeof value === "string" ? snakeCase(value) : "";
      if (
        !wire ||
        length(wire) > 1024 ||
        allowed.has(value) ||
        [...allowed.values()].includes(wire)
      )
        throw new CatalogError(
          "invalid_values",
          `${what} needs distinct values of 1-1,024 characters in snake case, got ${JSON.stringify(value)}.`,
        );
      allowed.set(value, wire);
    }
  }
  const catalog: CatalogProperty = {
    name,
    description,
    type: type as PropertyType,
    ...(listed && { values: [...allowed.values()] }),
    ...(text && { text: true as const }),
    required,
  };
  const wrong = (expected: string): never => {
    throw new TypeError(`${what} must be ${expected}.`);
  };
  const convert = (value: unknown): PropertyValue => {
    switch (type) {
      case "integer":
        return Number.isSafeInteger(value)
          ? (value as number)
          : wrong("a safe integer");
      case "number":
        return typeof value === "number" && Number.isFinite(value)
          ? value
          : wrong("a finite number");
      case "boolean":
        return typeof value === "boolean" ? value : wrong("a boolean");
      default:
        if (text) return typeof value === "string" ? value : wrong("a string");
        return (
          allowed.get(value) ??
          wrong(
            `one of ${[...allowed.keys()].map((v) => JSON.stringify(v)).join(", ")}`,
          )
        );
    }
  };
  return { key, catalog, convert };
}

function definition(key: string, declaration: unknown): EventDefinition {
  if (!isObject(declaration) || !isObject(declaration.properties))
    throw new CatalogError(
      "malformed_catalog",
      `Event ${key} must be declared with event(description, properties).`,
    );
  const name = named(key, 200, "Event");
  if (STANDARD_EVENTS.includes(name))
    throw new CatalogError(
      "standard_event",
      `Event ${name} is recorded by the SDK and cannot be declared.`,
    );
  const description = described(declaration.description, `Event ${name}`);
  const declared = Object.entries(declaration.properties);
  if (declared.length > 128)
    throw new CatalogError(
      "malformed_catalog",
      `Event ${name} declares more than 128 properties.`,
    );
  const fields = declared.map(([fieldKey, property]) =>
    field(fieldKey, property, name),
  );
  const names = new Set<string>();
  for (const { key: fieldKey, catalog } of fields) {
    if (names.has(catalog.name))
      throw new CatalogError(
        "duplicate_name",
        `Property ${fieldKey} of event ${name} repeats the name ${catalog.name}.`,
      );
    names.add(catalog.name);
  }
  const byKey = new Map(fields.map((entry) => [entry.key, entry]));
  const build = (input: unknown = {}): TypedEvent => {
    if (!isObject(input))
      throw new TypeError(`The properties of event ${name} must be an object.`);
    for (const fieldKey of Object.keys(input))
      if (!byKey.has(fieldKey))
        throw new TypeError(
          `Event ${name} does not declare the property ${fieldKey}.`,
        );
    const properties: Record<string, PropertyValue> = {};
    for (const { key: fieldKey, catalog, convert } of fields) {
      const value = Object.hasOwn(input, fieldKey)
        ? input[fieldKey]
        : undefined;
      if (value === undefined) {
        if (catalog.required)
          throw new TypeError(
            `Event ${name} requires the property ${fieldKey}.`,
          );
        continue;
      }
      properties[catalog.name] = convert(value);
    }
    const typed = Object.freeze({
      event: name,
      properties: Object.freeze(properties),
    });
    built.add(typed);
    return typed;
  };
  Object.defineProperties(build, {
    event: { value: name, enumerable: true },
    description: { value: description, enumerable: true },
    properties: { value: declaration.properties, enumerable: true },
  });
  entries.set(build, {
    name,
    description,
    properties: fields.map(({ catalog }) => catalog),
  });
  return Object.freeze(build) as unknown as EventDefinition;
}

/**
 * Turns event declarations into typed event builders. Keys are event names and
 * property keys are property names, both converted to snake case with
 * `snakeCase`; so are the values of `oneOf`. Throws a `CatalogError` for a
 * declaration the server would refuse.
 */
export function defineEvents<D extends EventDeclarations>(
  declarations: D,
): DefinedEvents<D> {
  if (!isObject(declarations))
    throw new CatalogError(
      "malformed_catalog",
      "Declare events as an object of event declarations.",
    );
  const events: Record<string, EventDefinition> = {};
  const names = new Set<string>();
  for (const [key, declaration] of Object.entries(declarations)) {
    const defined = definition(key, declaration);
    if (names.has(defined.event))
      throw new CatalogError(
        "duplicate_name",
        `Event ${key} repeats the name ${defined.event}.`,
      );
    names.add(defined.event);
    Object.defineProperty(events, key, { value: defined, enumerable: true });
  }
  if (names.size > 1000)
    throw new CatalogError(
      "malformed_catalog",
      "A catalog declares at most 1,000 events.",
    );
  return Object.freeze(events) as DefinedEvents<D>;
}

/**
 * The catalog JSON of defined events, in declaration order. Events from
 * several `defineEvents` calls can be merged: `catalog({ ...editor, ...export })`.
 */
export function catalog(events: {
  readonly [key: string]: EventDefinition<any>;
}): Catalog {
  if (!isObject(events))
    throw new CatalogError(
      "malformed_catalog",
      "Pass the events returned by defineEvents.",
    );
  const list: CatalogEvent[] = [];
  const names = new Set<string>();
  for (const defined of Object.values(events)) {
    const entry = entries.get(defined as object);
    if (!entry)
      throw new CatalogError(
        "malformed_catalog",
        "Pass the events returned by defineEvents.",
      );
    if (names.has(entry.name))
      throw new CatalogError(
        "duplicate_name",
        `Event ${entry.name} is declared twice.`,
      );
    names.add(entry.name);
    list.push(entry);
  }
  if (list.length > 1000)
    throw new CatalogError(
      "malformed_catalog",
      "A catalog declares at most 1,000 events.",
    );
  return { version: 1, events: JSON.parse(JSON.stringify(list)) };
}

/** Whether a value is an event built by a `defineEvents` definition. */
export function isTypedEvent(value: unknown): value is TypedEvent {
  return typeof value === "object" && value !== null && built.has(value);
}
