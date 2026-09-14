import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Noting that a portal pulled (0095 note_portal_pull), after the response.
 * A failed note never fails the feed; outside a request scope `after()`
 * throws, and the note runs inline instead — the site-revalidate.ts shape.
 *
 * Its own module rather than a closure in the route so the two things worth
 * proving are reachable from a test: that a note which fails is swallowed,
 * and that the inline fallback actually runs when there is no request scope.
 * The token is passed but never logged — a log line is not the place for the
 * one string that opens the feed.
 */
export interface PullNote {
  token: string;
  userAgent: string;
  count: number;
  portalId: string;
}

export async function notePortalPull(
  supabase: SupabaseClient<Database>,
  n: PullNote,
): Promise<"noted" | "failed"> {
  try {
    const { error } = await supabase.rpc("note_portal_pull", {
      p_token: n.token,
      p_ua: n.userAgent,
      p_count: n.count,
    });
    if (error) {
      console.warn(`[portal-feed] ${n.portalId}: note_portal_pull failed — ${error.message}`);
      return "failed";
    }
    return "noted";
  } catch (e) {
    console.warn(
      `[portal-feed] ${n.portalId}: note_portal_pull threw — ${e instanceof Error ? e.message : String(e)}`,
    );
    return "failed";
  }
}

/** Schedule the note after the response; inline when there is no request scope. Never throws. */
export function notePortalPullAfter(supabase: SupabaseClient<Database>, n: PullNote): void {
  try {
    after(() => notePortalPull(supabase, n));
  } catch {
    void notePortalPull(supabase, n);
  }
}
