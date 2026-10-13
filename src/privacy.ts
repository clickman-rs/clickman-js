export type Scalar = string | number | boolean | null;
export type Json = Scalar | Json[] | { [key: string]: Json };
export type Properties = Record<string, Json>;
export const defaultFragments = [
  "passw",
  "email",
  "secret",
  "token",
  "_key",
  "crypt",
  "salt",
  "certificate",
  "otp",
  "ssn",
  "cvv",
  "cvc",
  "phone",
  "address",
  "first_name",
  "last_name",
  "full_name",
  "birth",
];
const truncate = (value: string) => Array.from(value).slice(0, 1024).join("");
// Unicode mode treats paired surrogates as one code point; only lone halves match.
export const validUnicode = (value: string) => !/[\ud800-\udfff]/u.test(value);
export function flatten(input: Properties): Record<string, Scalar> {
  const output: Record<string, Scalar> = Object.create(null);
  function visit(value: Json, path: string, depth: number) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      depth < 5
    ) {
      for (const [key, child] of Object.entries(value))
        visit(child, path ? `${path}.${key}` : key, depth + 1);
    } else
      output[path] =
        typeof value === "object" && value !== null
          ? truncate(JSON.stringify(value))
          : typeof value === "string"
            ? truncate(value)
            : value;
  }
  // JSON serialization rejects cycles and normalizes non-JSON values before traversal.
  const normalized = JSON.parse(
    JSON.stringify(input, (key, value) => {
      if (
        !validUnicode(key) ||
        (typeof value === "string" && !validUnicode(value))
      )
        throw new Error("Properties must contain valid Unicode strings.");
      return value;
    }),
  ) as Properties;
  if (
    !normalized ||
    typeof normalized !== "object" ||
    Array.isArray(normalized)
  )
    throw new Error("Properties must be a JSON object.");
  for (const [key, value] of Object.entries(normalized)) visit(value, key, 1);
  return output;
}
const alphanumeric = (char: string | undefined) =>
  char !== undefined && /[\p{L}\p{N}]/u.test(char);
function sensitive(text: string) {
  if (/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i.test(text))
    return true;
  for (let start = 0; start < text.length; start++) {
    if (alphanumeric(text[start - 1])) continue;
    if (/[0-9]/.test(text[start])) {
      let end = start,
        digits = "";
      while (end < text.length) {
        if (/[0-9]/.test(text[end])) digits += text[end++];
        else if (/[ -]/.test(text[end]) && /[0-9]/.test(text[end + 1] ?? ""))
          end++;
        else break;
      }
      if (
        digits.length >= 13 &&
        digits.length <= 19 &&
        /^[2-6]/.test(digits) &&
        !alphanumeric(text[end])
      ) {
        const sum = Array.from(digits)
          .reverse()
          .reduce((total, digit, i) => {
            const n = Number(digit);
            const doubled = i % 2 ? n * 2 : n;
            return total + (doubled > 9 ? doubled - 9 : doubled);
          }, 0);
        if (sum % 10 === 0) return true;
      }
    }
    if (text[start] === "+" && /[0-9]/.test(text[start + 1] ?? "")) {
      let cursor = start + 1,
        end = cursor,
        digits = 0;
      while (cursor < text.length) {
        if (/[0-9]/.test(text[cursor])) {
          digits++;
          end = cursor + 1;
        } else if (!/[ .()\-]/.test(text[cursor])) break;
        cursor++;
      }
      if (digits >= 10 && digits <= 15 && !alphanumeric(text[end])) return true;
    }
  }
  return false;
}
export function sanitize(
  input: Record<string, Scalar>,
  fragments = defaultFragments,
) {
  const output: Record<string, Scalar> = Object.create(null);
  for (const [key, value] of Object.entries(input)) {
    const last = key.split(".").at(-1)!.toLowerCase();
    output[key] =
      fragments.some((fragment) => last.includes(fragment.toLowerCase())) ||
      (typeof value === "string" && sensitive(value))
        ? "[FILTERED]"
        : value;
  }
  return output;
}
export function prepared(input: Properties, maximum: number, extra: string[]) {
  const flat = flatten(input);
  const keys = Object.keys(flat);
  if (
    keys.length > maximum ||
    keys.some(
      (key) =>
        !key.length ||
        Array.from(key).length > 128 ||
        /[\u0000-\u001f\u007f-\u009f]/.test(key),
    )
  )
    throw new Error("Too many or invalid property keys.");
  return sanitize(flat, [...defaultFragments, ...extra]);
}
