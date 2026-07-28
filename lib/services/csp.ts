/**
 * Content-Security-Policy assembly (IMPROVEMENTS C1).
 *
 * Staged as REPORT-ONLY first, per the roadmap: a wrong CSP breaks the app
 * silently in production, and this one governs every screen. Report-only blocks
 * nothing — it only reports — so the policy can be proven against the real app
 * before anyone considers enforcing it.
 *
 * The origins are derived at runtime, not hardcoded: Supabase is 127.0.0.1 on a
 * developer's machine and a *.supabase.co host in production, and Sentry only
 * exists when a DSN is configured.
 */

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

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}
