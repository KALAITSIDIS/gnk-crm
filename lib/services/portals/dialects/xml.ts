/**
 * The only place a portal feed touches angle brackets. Every dialect builds
 * its document through `tag()`, so escaping cannot be forgotten in one of
 * fifty fields, and a listing whose title contains "<" cannot break a feed
 * that a portal then silently drops.
 */
export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';

// XML 1.0 forbids C0 controls except tab, LF, CR.
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function escapeXml(value: string): string {
  return value
    .replace(FORBIDDEN, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

type Scalar = string | number | boolean;

/**
 * `tag("beds", 3)` → `<beds>3</beds>`; an array is already-rendered children
 * and is NOT escaped; `null`/`undefined` renders nothing so an optional field
 * is one line at the call site, not an `if`.
 */
export function tag(
  name: string,
  value: Scalar | readonly string[] | null | undefined,
  attrs: Record<string, Scalar | null | undefined> = {},
): string {
  if (value === null || value === undefined) return "";
  const attrText = Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join("");
  const inner = Array.isArray(value) ? value.join("") : escapeXml(String(value));
  return `<${name}${attrText}>${inner}</${name}>`;
}
