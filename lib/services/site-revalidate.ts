import * as Sentry from "@sentry/nextjs";
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Telling the marketing site that a listing changed (audit REL-01).
 *
 * The site is ISR: a page is rebuilt from the feed when it is next requested
 * after it has gone stale. Until 2026-09-13 "stale" was governed by time alone
 * — sixty seconds, then a ceiling that Next defaults to a YEAR — so on a quiet
 * day the home page was measured serving a render five days old, and a
 * withdrawn listing stayed visible until a visitor happened by. The site now
 * bounds the ceiling to an hour and exposes a revalidate door; this is the
 * hand that knocks on it after a write that can change a listing's public
 * face (visibility, status, price, copy, photographs).
 *
 * THREE RULES, in order of importance:
 *
 *  1. A failed knock must never fail the write that caused it. Everything
 *     here catches; the caller gets a word, never an exception.
 *  2. The knock runs AFTER the response, in Next's `after()`, so a slow site
 *     never delays the desk. Outside a request scope (a unit test, a script)
 *     `after()` throws, and the knock is sent inline instead.
 *  3. Unconfigured is loud, once: the site then refreshes on its timers
 *     alone, which is the weaker system wearing the stronger one's promise.
 *
 * The key opens nothing: a holder can make the site re-read a public feed a
 * little sooner. It is `SITE_REVALIDATE_KEY` on both projects, set through
 * the Vercel CLI, and it never appears in a log line here.
 */
export const REVALIDATE_KEY_HEADER = "x-gnk-revalidate-key";

/**
 * Long enough for a cold site function that first reads the feed before it
 * answers (gnk-web's door waits up to eight seconds for that read, then
 * rebuilds; T-unit-site-revalidate) — so a knock the site carried out is not
 * logged here as failed. Never noticed: the knock runs after the response.
 */
const TIMEOUT_MS = 10_000;

let warnedUnset = false;

/** Test seam: the once-per-instance latch. */
export function resetSiteRevalidateLatch(): void {
  warnedUnset = false;
}

export type SiteRevalidateOutcome = "sent" | "skipped" | "failed";

/**
 * A bulk change — many units' prices or layouts at once (applyPriceUplift,
 * applyUnitType). The site rebuilds the home page, the list and EVERY listing
 * page, each on its own next visit, from ONE request (gnk-web
 * lib/revalidate.ts readKnock; T-unit-site-revalidate). Chosen over sending
 * the affected references in batches: no read of which units are public, no
 * page of references to drop at a batch boundary, no unit the site does not
 * show ever named to it, and the "Other properties" cards every listing page
 * carries are refreshed with the rest. The cost is that unaffected pages are
 * rebuilt too, lazily, from the same public feed — the work the site's
 * sixty-second timer already does under traffic, after an act the desk does
 * a few times a month.
 */
export const EVERY_LISTING = { scope: "listings" } as const;

/**
 * What a knock names: one listing by reference, EVERY_LISTING, or null for
 * only the home page and the list.
 */
export type SiteTarget = string | null | typeof EVERY_LISTING;

/**
 * The reference shape the site will take as a path (gnk-web lib/revalidate.ts
 * REFERENCE) — it refuses anything else with a 400 and rebuilds NOTHING. A
 * unit's reference ends in a label the desk typed (a block, a unit number), so
 * one can fall outside it ("PAF0007-b 2"); that knock is widened to every
 * listing page, which reaches the same page by route, rather than lost.
 */
const SITE_REFERENCE = /^[A-Z0-9][A-Z0-9-]{0,39}$/;

function bodyOf(target: SiteTarget): Record<string, string> {
  if (!target) return {};
  if (typeof target !== "string") return { scope: target.scope };
  return SITE_REFERENCE.test(target) ? { reference: target } : { scope: EVERY_LISTING.scope };
}

function described(target: SiteTarget): string {
  if (!target) return "the list";
  return typeof target === "string" ? target : "every listing";
}

/**
 * One knock. `target` names the listing whose page moved, EVERY_LISTING for a
 * bulk change, or null when only the home page and the list can have changed.
 */
export async function notifySite(target: SiteTarget): Promise<SiteRevalidateOutcome> {
  const url = process.env.SITE_REVALIDATE_URL;
  const key = process.env.SITE_REVALIDATE_KEY;
  if (!url || !key) {
    if (!warnedUnset) {
      warnedUnset = true;
      console.warn(
        "[site-revalidate] SKIPPED — set SITE_REVALIDATE_URL and SITE_REVALIDATE_KEY in the Vercel " +
          "environment to arm it. The site refreshes on its own timers meanwhile (an hour at most).",
      );
    }
    return "skipped";
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", [REVALIDATE_KEY_HEADER]: key },
      body: JSON.stringify(bodyOf(target)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error(
        `[site-revalidate] the site answered ${res.status} for ${described(target)} — it will refresh on its timers`,
      );
      return "failed";
    }
    return "sent";
  } catch (err) {
    console.error(
      "[site-revalidate] knock failed:",
      err instanceof Error ? err.message : String(err),
    );
    return "failed";
  }
}

/**
 * Knock after the response has gone out. Never throws, never awaited by the
 * caller — the write is already committed and the desk is already answered.
 *
 * Call it STRAIGHT AFTER the commit is confirmed, before any follow-up step
 * (a timeline line, a task, an alert, a page refresh): Next runs an `after()`
 * callback even when the action throws later, so a follow-up that fails
 * cannot swallow the knock — but only if the knock was scheduled first.
 */
export function notifySiteAfter(target: SiteTarget): void {
  const knock = () =>
    notifySite(target).then(
      () => undefined,
      () => undefined,
    );
  try {
    after(knock);
  } catch {
    // no request scope (unit test, script): send it inline, fire-and-forget
    void knock();
  }
}

/**
 * For writes that do not already hold the row: the media actions know a
 * property id and nothing else. Reads through the caller's own client — a
 * listing the caller may edit is a listing the caller may read.
 *
 * A lookup that FAILS is reported, not swallowed. supabase-js RESOLVES a
 * database error — and, with throwOnError off, a network failure too — as
 * `{ data: null, error }`; it does not throw. Until 2026-09-21 this read
 * `data` alone, so a refused or failed lookup was indistinguishable from a
 * private listing: no knock, no line, and the site kept an old render for up
 * to an hour with nothing anywhere saying why. Both shapes now reach Sentry
 * with the operation and the error CODE — never the message, which can carry
 * a column value or a SQL fragment — and the helper still returns normally:
 * the write it follows is already committed (rule 1), and the site refreshes
 * on its timers as it does after any failed knock. No row is not a failure:
 * the listing is gone, or is not the caller's to read, and either way there
 * is nothing to tell the site.
 */
export async function notifySiteIfPublic(
  supabase: SupabaseClient<Database>,
  propertyId: string,
): Promise<void> {
  let listing: { reference: string; visibility: string } | null;
  try {
    const { data, error } = await supabase
      .from("properties")
      .select("reference, visibility")
      .eq("id", propertyId)
      .maybeSingle();
    if (error) {
      reportLookupFailure(propertyId, error.code || "unknown");
      return;
    }
    listing = data;
  } catch (err) {
    reportLookupFailure(propertyId, err instanceof Error ? err.name : "threw");
    return;
  }
  if (listing?.visibility === "public") notifySiteAfter(listing.reference);
}

/**
 * The console line is for the runtime log; Sentry is where a human is paged
 * (the enquiry-alert shape). SHAPE ONLY: the operation, the code and the
 * property id — an opaque uuid — never the database's message.
 */
function reportLookupFailure(propertyId: string, code: string): void {
  console.error(
    `[site-revalidate] could not read listing ${propertyId} to notify the site (${code}) — it will refresh on its timers`,
  );
  try {
    Sentry.captureMessage("[site-revalidate] listing lookup failed", {
      level: "error",
      tags: { operation: "properties.lookup", code },
      extra: { propertyId },
    });
  } catch {
    // Sentry is best-effort; the write is already committed and the console line stands.
  }
}
