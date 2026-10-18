import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Recording that a portal pulled (0150 record_portal_pull), after the response.
 *
 * WHO MAY WRITE IT (0150, portal integrations audit 2026-10-18). Until 0150 the
 * note was anon-callable, so anyone holding the feed URL — or a copy of the
 * stored digest — could write any user-agent and any count straight over
 * PostgREST, keeping "last pulled" fresh over a dead integration. The record
 * is now service_role only, and this module is its one caller: the route has
 * already proven the token by answering the request, and it hands the token
 * over so the function finds the connection the same way the readers do.
 *
 * EVERY OUTCOME IS RECORDED, failures too. A 503 used to record nothing so
 * the timestamp would freeze — but a frozen timestamp reads the same as a
 * portal that stopped asking. Now `last_pulled_at` means "last asked",
 * `last_pull_outcome` says what it got, a failure keeps the last good count,
 * and portal_pull_log keeps the runs for the settings page.
 *
 * A failed record never fails the feed: the portal already has its bytes.
 * The admin client is built INSIDE the try, so a missing service key
 * (supabase-js throws "supabaseKey is required") costs a warning, never a
 * 500; a legacy key only reports itself (key-health.ts) and its 401 is
 * swallowed like any other database error. Outside a
 * request scope `after()` throws and the record runs inline instead — the
 * site-revalidate.ts shape. Neither the token nor anything derived from it is
 * logged.
 */
export type PullOutcome = "served" | "disabled" | "failed";

/** Codes the settings page words (lib/services/portals/pull-health.ts). Lowercase, ≤ 40 chars — 0150's CHECK. */
export type PullReason =
  | "connection_malformed"
  | "supplement_failed"
  | "supplement_malformed"
  | "supplement_incomplete"
  | "selection_too_large"
  | "settings_invalid"
  | "listings_failed"
  | "listings_incomplete"
  | "truncated"
  | "render_failed";

export interface PullRecord {
  /** the token from the URL — record_portal_pull hashes it, as the readers do */
  token: string;
  userAgent: string;
  outcome: PullOutcome;
  /** listings in the document served; null when nothing was served */
  served: number | null;
  /** selected listings the portal could see (selection ∩ on the website); null when unknown */
  selected: number | null;
  /** of those, how many the portal's requirements kept out; null when unknown */
  excluded: number | null;
  reason: PullReason | null;
  /** small, id-free facts: exclusions by reason, missing references, the revision source */
  detail: Record<string, number | string>;
  portalId: string;
}

type AdminClient = SupabaseClient<Database>;

export async function recordPortalPull(
  makeClient: () => AdminClient,
  r: PullRecord,
): Promise<"recorded" | "failed"> {
  try {
    const admin = makeClient();
    const { error } = await admin.rpc("record_portal_pull", {
      p_token: r.token,
      p_ua: r.userAgent,
      p_outcome: r.outcome,
      // the generated types call a defaultless int `number`; null is what 0150 stores for "unknown"
      p_served: r.served as number,
      p_selected: r.selected as number,
      p_excluded: r.excluded as number,
      p_reason: r.reason as string,
      p_detail: r.detail,
    });
    if (error) {
      console.warn(
        `[portal-feed] ${r.portalId}: record_portal_pull failed — ${error.message || `code ${error.code || "?"}`}`,
      );
      return "failed";
    }
    return "recorded";
  } catch (e) {
    console.warn(
      `[portal-feed] ${r.portalId}: record_portal_pull threw — ${e instanceof Error ? e.message : String(e)}`,
    );
    return "failed";
  }
}

/** Schedule the record after the response; inline when there is no request scope. Never throws. */
export function recordPortalPullAfter(makeClient: () => AdminClient, r: PullRecord): void {
  try {
    after(() => recordPortalPull(makeClient, r));
  } catch {
    void recordPortalPull(makeClient, r);
  }
}
