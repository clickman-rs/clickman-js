import type { Properties } from "./privacy";

export interface Options {
  endpoint: string;
  writeKey: string;
  /** No storage, identification, or tracking occurs until consent is true. */
  consent: boolean;
  context?: Properties;
  filterFragments?: string[];
  maxQueueEvents?: number;
  maxQueueBytes?: number;
  flushIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
  onError?: (error: Error) => void;
  onDrop?: (count: number, reason: string) => void;
}

export const VERSION = "0.1.1";
// Browsers use a signed 32-bit timer delay. Longer delays wrap into a busy loop.
export const MAX_TIMER_DELAY = 2_147_483_647;

function positive(value: number, name: string, integer = false) {
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isInteger(value))
  )
    throw new Error(
      `${name} must be a positive ${integer ? "integer" : "number"}.`,
    );
  return value;
}

export function configuration(options: Options) {
  const base = new URL(options.endpoint);
  if (
    !["https:", "http:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error(
      "Endpoint must be an HTTP(S) base URL without credentials, query or fragment.",
    );
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  if (
    typeof options.writeKey !== "string" ||
    !/^[!-~]+$/.test(options.writeKey)
  )
    throw new Error(
      "A public source write key without whitespace is required.",
    );

  return {
    base,
    writeKey: options.writeKey,
    maxCount: Math.min(
      positive(options.maxQueueEvents ?? 10_000, "maxQueueEvents", true),
      10_000,
    ),
    maxBytes: Math.max(
      64_000,
      Math.min(
        positive(options.maxQueueBytes ?? 5_000_000, "maxQueueBytes", true),
        5_000_000,
      ),
    ),
    flushInterval: positive(
      options.flushIntervalMs ?? 30_000,
      "flushIntervalMs",
    ),
  };
}
