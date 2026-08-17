/**
 * Content-Security-Policy assembly (IMPROVEMENTS C1).
 *
 * Staged as REPORT-ONLY first, per the roadmap: a wrong CSP breaks the app
 * silently in production, and this one governs every screen. Report-only blocks
 * nothing — it only reports — so the policy could be proven against the real app
 * before anyone considered enforcing it.
 *
 * **ENFORCING since 2026-08-10.** That staging did its job twice over: it caught
 * three prerendered routes carrying no nonce, and then the `next.config.ts`
 * header collision that meant production served 22 script tags and 0 nonces.
 * Both are fixed, and the report-only policy has since run clean — the evidence
 * for flipping it is in IMPROVEMENTS C1, not in this comment.
 *
 * The origins are derived at runtime, not hardcoded: Supabase is 127.0.0.1 on a
 * developer's machine and a *.supabase.co host in production, and Sentry only
 * exists when a DSN is configured.
 */

/** Where browsers post violation reports; exempt from auth in `proxy.ts`. */
export const CSP_REPORT_PATH = "/api/csp-report";

/** Reporting-API group name, tying `report-to` to the Reporting-Endpoints header. */
export const CSP_REPORT_GROUP = "csp-endpoint";

/**
 * The response header the policy is served under — ENFORCING.
 *
 * Defined once and used by both branches of `proxy.ts` on purpose. The two used
 * to carry the header name as separate literals, and that file has already had
 * exactly this bug once: the public `/p/` branch returned before the policy was
 * attached, so the only unauthenticated HTML the app serves was also the only
 * HTML with no `script-src`. One constant means the authenticated and public
 * paths cannot drift into different enforcement modes.
 *
 * To roll back, set this to `"Content-Security-Policy-Report-Only"`. Nothing
 * else changes: the policy string, the nonce and the reporting endpoints are
 * identical either way, so a revert is one word and needs no other edit.
 */
export const CSP_HEADER = "Content-Security-Policy";

export interface CspOptions {
  /** per-request nonce; Next stamps this on its own inline bootstrap scripts */
  nonce: string;
  /** `next dev` compiles with eval, which production never does */
  isDev: boolean;
  /** NEXT_PUBLIC_SUPABASE_URL */
  supabaseUrl?: string;
  /** NEXT_PUBLIC_SENTRY_DSN, when error tracking is switched on */
  sentryDsn?: string;
}

/** Origin (scheme + host + port) of a URL, or undefined if unusable. */
export function originOf(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Websocket origin for a http(s) origin — Supabase Realtime and dev HMR. */
function wsOrigin(origin: string): string {
  return origin.replace(/^http/, "ws");
}

export function buildCsp({ nonce, isDev, supabaseUrl, sentryDsn }: CspOptions): string {
  const supabase = originOf(supabaseUrl);
  const sentry = originOf(sentryDsn);

  const connect = ["'self'"];
  const img = ["'self'", "data:", "blob:"];
  // OpenFreeMap serves the style JSON, vector tiles, glyphs and sprites for the
  // property map (IMPROVEMENTS B5) from this one origin. No account, no key.
  // `worker-src` already allows blob:, which is what MapLibre's workers need.
  const TILES = "https://tiles.openfreemap.org";
  connect.push(TILES);
  img.push(TILES);
  if (supabase) {
    // REST, Auth and Storage all live on the project origin…
    connect.push(supabase, wsOrigin(supabase)); // …plus Realtime over websockets
    // property renditions are served from the public `media` bucket
    img.push(supabase);
  }
  if (sentry) connect.push(sentry);
  if (isDev) connect.push("ws:", "wss:"); // Next HMR

  const script = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  // `next dev` compiles and evaluates modules with eval(); production does not.
  if (isDev) script.push("'unsafe-eval'");

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": script,
    // Tailwind and Radix write inline styles, and Next inlines critical CSS.
    // Nonce-ing styles would mean threading it through every component for a
    // far smaller payoff than script-src — inline STYLE cannot execute code.
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": img,
    "font-src": ["'self'", "data:"],
    "connect-src": connect,
    // no <object>/<embed> anywhere in the app
    "object-src": ["'none'"],
    // stop an injected <base> re-pointing every relative URL
    "base-uri": ["'self'"],
    // forms may only post back to us — server actions included
    "form-action": ["'self'"],
    // already enforced separately in next.config.ts; repeated for completeness
    "frame-ancestors": ["'none'"],
    "frame-src": ["'none'"],
    "worker-src": ["'self'", "blob:"],
  };

  const policy = Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");

  // Without somewhere to report TO, a report-only policy is decorative:
  // violations reach the visitor's console and nobody else. `report-uri` is
  // formally deprecated but is still the only directive every current browser
  // honours; `report-to` is emitted alongside it for those that prefer it (the
  // matching Reporting-Endpoints header is set in proxy.ts).
  return `${policy}; report-uri ${CSP_REPORT_PATH}; report-to ${CSP_REPORT_GROUP}`;
}
