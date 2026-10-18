/**
 * WHERE A PORTAL'S FEED URL POINTS (portal integrations audit 2026-10-18,
 * finding 8).
 *
 * The settings card used to build the URL from `window.location.origin`, so a
 * URL issued on a Vercel preview, a branch alias or a deployment's own
 * *.vercel.app host pointed there — a host that is protected, renamed or
 * deleted later — and the desk would hand it to a production portal. The
 * URL's origin is now decided HERE, on the server, from configuration:
 *
 *   1. NEXT_PUBLIC_APP_URL — the CRM's canonical address, the one the alert
 *      e-mails already link to (enquiry-alert.ts, lead-escalation.ts);
 *   2. else VERCEL_PROJECT_PRODUCTION_URL — Vercel's own name for the
 *      project's production domain, set on every deployment, previews too;
 *   3. else null: a local `next dev` with neither set. The card then says the
 *      URL is local and must not be given to a portal.
 *
 * A value that is not an absolute https origin (http only for localhost) is
 * IGNORED rather than trusted: a typo must not mint URLs to nowhere.
 *
 * AND WHERE ONE MAY BE ISSUED. A preview deployment never touches a portal
 * connection (feedTokenIssuance below): whatever database it talks to, a URL
 * born there is a URL nobody approved for production, the token is shown
 * once, and a Regenerate there would kill production's URL if the database
 * is shared.
 */

/** The variables this module reads — read by name, so tests/unit/env-names-documented.test.ts sees them. */
export interface FeedEnv {
  NEXT_PUBLIC_APP_URL?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
  VERCEL_ENV?: string;
}

const runtimeEnv = (): FeedEnv => ({
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  VERCEL_ENV: process.env.VERCEL_ENV,
});

function originOf(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    return null;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username || url.password) {
    return null;
  }
  return url.origin;
}

/** The origin every feed URL is built on, or null when this deployment has none configured. */
export function portalFeedOrigin(env: FeedEnv = runtimeEnv()): string | null {
  return originOf(env.NEXT_PUBLIC_APP_URL) ?? originOf(env.VERCEL_PROJECT_PRODUCTION_URL);
}

/** The full feed URL for a portal and a token, or null when there is no canonical origin. */
export function portalFeedUrl(portalId: string, token: string, env: FeedEnv = runtimeEnv()): string | null {
  const origin = portalFeedOrigin(env);
  return origin ? `${origin}/api/portals/${portalId}/${token}` : null;
}

/**
 * Whether this deployment may manage portal connections at all — mint,
 * rotate, toggle or save their settings: production, or a local `next dev`
 * (VERCEL_ENV unset). A preview may do none of it, so it can neither issue a
 * URL nor rotate production's when it shares production's database.
 */
export function feedTokenIssuance(env: FeedEnv = runtimeEnv()): { allowed: true } | { allowed: false; reason: string } {
  if (env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "development") {
    const where = portalFeedOrigin(env);
    return {
      allowed: false,
      reason: `Feed URLs are issued on the production CRM only${where ? ` (${where})` : ""} — this is a preview deployment.`,
    };
  }
  return { allowed: true };
}

/** What kind of deployment this is, for the settings page's banner. */
export function deploymentKind(env: FeedEnv = runtimeEnv()): "production" | "preview" | "local" {
  if (env.VERCEL_ENV === "production") return "production";
  if (env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "development") return "preview";
  return "local";
}
