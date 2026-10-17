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

/**
 * The directives a policy can name (CSP Level 3, plus the fetch directives
 * browsers still report). A report naming anything else groups as "other":
 * the endpoint is public, so a directive is caller-written text, and a
 * fingerprint or a message built from it would let any caller mint a Sentry
 * issue and choose its title (NOTIF-1, six-phase audit 2026-10-17).
 */
const KNOWN_DIRECTIVES: ReadonlySet<string> = new Set([
  "default-src",
  "script-src",
  "script-src-elem",
  "script-src-attr",
  "style-src",
  "style-src-elem",
  "style-src-attr",
  "img-src",
  "font-src",
  "connect-src",
  "media-src",
  "object-src",
  "frame-src",
  "child-src",
  "worker-src",
  "manifest-src",
  "prefetch-src",
  "fenced-frame-src",
  "base-uri",
  "form-action",
  "frame-ancestors",
  "navigate-to",
  "sandbox",
  "require-trusted-types-for",
  "trusted-types",
  "upgrade-insecure-requests",
  "block-all-mixed-content",
  "webrtc",
]);

/**
 * The fixed part of a violation's Sentry fingerprint: its directive NAME when
 * the policy could have that directive, else "other". An older browser's
 * `violated-directive` carries the source expression too ("script-src 'self'
 * …"), so the name is the first token, lowercased.
 */
export function directiveFamily(directive: string): string {
  const name = directive.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return KNOWN_DIRECTIVES.has(name) ? name : "other";
}

/**
 * A report's first this-many violations are looked at; a browser's batch is
 * ~24 (csp.spec.ts). The parse itself walks the whole body, which the route's
 * 128 KB cap bounds.
 */
export const MAX_VIOLATIONS_PER_REPORT = 50;
/** New violations reported per request, at most. */
export const MAX_NEW_PER_REQUEST = 3;
/** The per-instance token bucket: this many events at once … */
export const REPORT_BUCKET_CAPACITY = 10;
/** … refilled one token per this many milliseconds (ten an hour). */
export const REPORT_BUCKET_REFILL_MS = 6 * 60_000;
/** Distinct violations remembered per instance (reported, and logged); the oldest is forgotten first. */
export const MAX_SEEN = 200;

/**
 * What one serverless instance may report, and has reported (NOTIF-1).
 *
 * Until 2026-10-17 the route sent one Sentry event per distinct violation
 * key with no cap per request or per window — about eighty crafted requests
 * made 5,000 events — and cleared its dedupe set whole at 200 entries, so a
 * run of fresh keys also re-reported every key already seen. Now:
 *   - at most MAX_NEW_PER_REQUEST new violations per request;
 *   - a token bucket per instance (REPORT_BUCKET_CAPACITY, one back every
 *     REPORT_BUCKET_REFILL_MS) bounds a run of requests;
 *   - a violation held back is NOT remembered as reported, so a later
 *     request reports it;
 *   - THE LOG IS NOT RATIONED: every violation this instance has not logged
 *     yet is logged once, reported or held back. stdout is the sink that
 *     works without a DSN (the route's header), so the Sentry budget must not
 *     decide what reaches it; a request still logs at most
 *     MAX_VIOLATIONS_PER_REPORT lines;
 *   - both sets forget their OLDEST key when full, never all of them.
 *
 * In memory and per instance, deliberately (the route's header): a flood
 * guard, not a store. A cold start begins with a full bucket and empty sets.
 */
export class CspReportLimiter {
  private readonly reported = new Set<string>();
  private readonly logged = new Set<string>();
  private tokens = REPORT_BUCKET_CAPACITY;
  private refilledAt: number;

  constructor(private readonly now: () => number = Date.now) {
    this.refilledAt = now();
  }

  /**
   * `log`: the violations to write to the log now (each once per instance).
   * `report`: those to send to Sentry now. `heldBack`: how many new ones
   * Sentry's budget held back this time.
   */
  admit(violations: readonly CspViolation[]): { log: CspViolation[]; report: CspViolation[]; heldBack: number } {
    this.refill();
    const log: CspViolation[] = [];
    const report: CspViolation[] = [];
    const held = new Set<string>();
    for (const v of violations) {
      const key = violationKey(v);
      if (!this.logged.has(key)) {
        remember(this.logged, key);
        log.push(v);
      }
      if (this.reported.has(key) || held.has(key)) continue;
      if (report.length >= MAX_NEW_PER_REQUEST || this.tokens < 1) {
        held.add(key);
        continue;
      }
      this.tokens -= 1;
      remember(this.reported, key);
      report.push(v);
    }
    return { log, report, heldBack: held.size };
  }

  private refill(): void {
    const t = this.now();
    // A full bucket earns nothing while it waits: its clock starts when the
    // first token is spent, so a burst is never REPORT_BUCKET_CAPACITY plus
    // one already earned.
    if (this.tokens >= REPORT_BUCKET_CAPACITY) {
      this.refilledAt = t;
      return;
    }
    const earned = Math.floor((t - this.refilledAt) / REPORT_BUCKET_REFILL_MS);
    if (earned <= 0) return;
    this.tokens = Math.min(REPORT_BUCKET_CAPACITY, this.tokens + earned);
    // a partial bucket keeps the remainder towards its next token
    this.refilledAt = this.tokens === REPORT_BUCKET_CAPACITY ? t : this.refilledAt + earned * REPORT_BUCKET_REFILL_MS;
  }

}

/** Add a key to a bounded set, forgetting its OLDEST key first when full. */
function remember(set: Set<string>, key: string): void {
  if (set.size >= MAX_SEEN) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(key);
}
