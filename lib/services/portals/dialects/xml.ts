/**
 * The only place a portal feed touches angle brackets. Every dialect builds
 * its document through `tag()`, so escaping cannot be forgotten in one of
 * fifty fields, and a listing whose title contains "<" cannot break a feed
 * that a portal then silently drops.
 *
 * Trust boundary: element names and attribute KEYS are code literals written
 * in a dialect file, never listing data, and are not escaped. Values are.
 *
 * Contract of `tag()`:
 *  - `null`, `undefined` and the empty (or whitespace-only) string render
 *    NOTHING, so an optional or blank field is one line at the call site, not
 *    an `if`; `0` renders.
 *  - a number must be finite: NaN or ±Infinity is a programming error and
 *    throws rather than reaching a public feed as text.
 *  - booleans are not accepted: every portal spells yes/no differently, so a
 *    dialect states its own spelling as a string at the call site.
 *  - an array is already-rendered children; null/undefined/"" entries are
 *    dropped and the rest joined WITHOUT escaping.
 */
export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';

// XML 1.0 forbids C0 controls except tab, LF, CR, and the non-characters
// U+FFFE/U+FFFF; a lone surrogate half cannot be encoded as UTF-8 at all.
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function escapeXml(value: string): string {
  return value
    .replace(FORBIDDEN, "")
    .replace(LONE_SURROGATE, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

type Scalar = string | number;
type Child = string | null | undefined;

function renderScalar(name: string, value: Scalar): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`xml tag <${name}>: non-finite number ${value}`);
    return String(value);
  }
  return value.trim() === "" ? null : escapeXml(value);
}

export function tag(
  name: string,
  value: Scalar | readonly Child[] | null | undefined,
  attrs: Record<string, Scalar | null | undefined> = {},
): string {
  if (value === null || value === undefined) return "";
  const attrText = Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => ` ${k}="${renderScalar(`${name} @${k}`, v as Scalar) ?? ""}"`)
    .join("");
  const inner = Array.isArray(value)
    ? (value as readonly Child[]).filter((c): c is string => typeof c === "string" && c !== "").join("")
    : renderScalar(name, value as Scalar);
  if (inner === null) return "";
  return `<${name}${attrText}>${inner}</${name}>`;
}
