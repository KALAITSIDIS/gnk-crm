/**
 * A listing's page on the public website, for a portal's "visit the agent's
 * website" link (Kyero <url><en>…</en></url>).
 *
 * The CRM does not know where the website lives until it is told:
 * PUBLIC_SITE_URL (docs/10_INFRASTRUCTURE.md), e.g. https://gnk-web.vercel.app.
 * Unset, or not an absolute https origin, and no URL is emitted — a portal
 * link to a guessed address would be an invented fact. The path is gnk-web's
 * listing route, `/properties/<reference>`, which exists for every listing a
 * portal can receive: "on a portal" ⊆ "on the site" (0095, portals.test.ts).
 */
export function publicSiteOrigin(env: { PUBLIC_SITE_URL?: string } = { PUBLIC_SITE_URL: process.env.PUBLIC_SITE_URL }): string | null {
  const raw = env.PUBLIC_SITE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash || url.username || url.password) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/** `https://site/properties/PAF0001`, or null when the site's address is not configured. */
export function publicListingUrl(
  reference: string,
  env: { PUBLIC_SITE_URL?: string } = { PUBLIC_SITE_URL: process.env.PUBLIC_SITE_URL },
): string | null {
  const origin = publicSiteOrigin(env);
  return origin ? `${origin}/properties/${encodeURIComponent(reference)}` : null;
}
