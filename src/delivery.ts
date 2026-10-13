import type { Entry } from "./store";

export function deliveryOutcome(status: number) {
  return status >= 200 && status < 300
    ? "delivered"
    : [400, 413, 415].includes(status)
      ? "refused"
      : "retry";
}

export function retryAfter(value: string | null, now = Date.now()) {
  if (!value) return 0;
  const text = value.trim();
  const seconds = /^\d+$/.test(text) ? Number(text) : NaN;
  // HTTP dates start with a weekday. Date.parse also accepts unrelated numeric
  // strings (negative years, fractions, ISO dates), which can pause retries for years.
  if (
    !Number.isFinite(seconds) &&
    !/^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)[, ]/i.test(
      text,
    )
  )
    return 0;
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(text) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

/** A take contains one identity link or a contiguous batch of track commands. */
export function requestBody(rows: Entry[]) {
  const first = rows[0].command;
  if (first.kind === "identify")
    return {
      path: "v1/identify",
      body: { anonymousId: first.anonymousId, externalId: first.externalId },
    };

  const batch = rows.map(({ command }) => {
    if (command.kind !== "track")
      throw new Error("An identity link cannot be included in an event batch.");
    return command.event;
  });
  return {
    path: "v1/batch",
    body: { sentAt: new Date().toISOString(), batch },
  };
}
