/**
 * Normalising CSP violation reports (IMPROVEMENTS C1).
 *
 * The report-only policy shipped without anywhere to send its reports, which
 * made it decorative: violations surfaced in each visitor's browser console and
 * nowhere the operator could ever see them. Since the whole point of the
 * report-only stage is to gather evidence before enforcing, that gap had to be
 * closed.
 *
 * Browsers send two different shapes for the same event:
 *   - `report-uri`  → Content-Type: application/csp-report, a single object
 *                     under a `csp-report` key, hyphen-cased.
 *   - `report-to`   → Content-Type: application/reports+json, an ARRAY of
 *                     envelopes with camelCased bodies.
 * Both are accepted; the payload is untrusted input from the public internet,
 * so everything is treated as optional and nothing is echoed back.
 */

export interface CspViolation {
  /** e.g. "script-src" */
  directive: string;
  /** e.g. "eval", "inline", or an origin */
  blockedUri: string;
  /** PATH only — the query string is dropped so filters never reach the log */
  documentPath: string;
  sourceFile?: string;
  lineNumber?: number;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Keep the path, drop the query — a report URL can carry search filters.
 * Only http(s) is reduced to a pathname: `new URL()` happily parses
 * `about:blank` and reports its pathname as "blank", which is worse than
 * useless in a log line.
 */
function pathOf(value: unknown): string {
  const raw = str(value);
  if (!raw) return "unknown";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.pathname : raw;
  } catch {
    return raw.split("?")[0];
  }
}

type Dict = Record<string, unknown>;

const asDict = (v: unknown): Dict | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : null;

/**
 * Parse whatever the browser posted into zero or more violations. Returns []
 * for anything unrecognised rather than throwing — this endpoint is public and
 * must never 500 on malformed input.
 */
export function parseCspReport(body: unknown): CspViolation[] {
  // report-to: an array of envelopes
  if (Array.isArray(body)) {
    return body
      .map((entry): CspViolation | null => {
        const env = asDict(entry);
        if (!env) return null;
        if (str(env.type) && str(env.type) !== "csp-violation") return null;
        const b = asDict(env.body);
        if (!b) return null;
        const directive = str(b.effectiveDirective) ?? str(b.violatedDirective);
        if (!directive) return null;
        return {
          directive,
          blockedUri: str(b.blockedURL) ?? "unknown",
          documentPath: pathOf(b.documentURL ?? env.url),
          sourceFile: str(b.sourceFile),
          lineNumber: num(b.lineNumber),
        };
      })
      .filter((v): v is CspViolation => v !== null);
  }

  // report-uri: { "csp-report": { ... } }
  const outer = asDict(body);
  const r = outer && asDict(outer["csp-report"]);
  if (!r) return [];
  const directive = str(r["effective-directive"]) ?? str(r["violated-directive"]);
  if (!directive) return [];
  return [
    {
      directive,
      blockedUri: str(r["blocked-uri"]) ?? "unknown",
      documentPath: pathOf(r["document-uri"]),
      sourceFile: str(r["source-file"]),
      lineNumber: num(r["line-number"]),
    },
  ];
}

/**
 * Identity of a violation for de-duplication. The operator needs the DISTINCT
 * set of things the policy would block, not one line per page view — a common
 * violation would otherwise flood the logs and drown the rare, interesting one.
 */
export function violationKey(v: CspViolation): string {
  return `${v.directive}|${v.blockedUri}|${v.sourceFile ?? ""}`;
}
