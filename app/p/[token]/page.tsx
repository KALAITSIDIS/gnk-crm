import { Availability as AvailabilityView } from "@/components/features/share-links/availability";
import { Proposal as ProposalView } from "@/components/features/share-links/proposal";
import {
  isAvailability,
  isWellFormedShareToken,
  type ResolvedShareLink,
} from "@/lib/services/share-links";
import { hashShareToken } from "@/lib/services/share-links-token";
import { createPublicClient } from "@/lib/supabase/public";
import { callerIpHash } from "@/lib/services/caller-ip";

export const dynamic = "force-dynamic";

/**
 * Buyer proposal page (IMPROVEMENTS B3). PUBLIC and unauthenticated by design —
 * doc 01 §4 forbids buyer logins, and §0.1 names the tokenised no-login page as
 * the sanctioned replacement. `proxy.ts` exempts `/p/` from the auth gate.
 *
 * Everything the visitor sees comes from `resolve_share_link`, a
 * security-definer RPC whose SQL enumerates the allowlist (migration 0023).
 * This component cannot widen that boundary — it has an anon client that can
 * reach nothing else.
 */

/**
 * Expired, revoked, unknown and malformed all render THIS — one neutral page,
 * so a prober cannot tell which tokens exist. Same reasoning that makes
 * /api/csp-report always answer 204.
 */
function Unavailable() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-xl font-semibold text-text-1">This link is no longer available</h1>
      <p className="text-sm text-text-2">
        It may have expired or been withdrawn. Please contact your agent for an up-to-date
        selection.
      </p>
    </main>
  );
}

export async function generateMetadata() {
  // Never leak the buyer's name, the agency's client list, or which properties
  // are in the proposal into a link preview or a search index.
  return {
    // Deliberately says less than it could. Metadata is produced WITHOUT
    // resolving the token, so it cannot name the kind even if it wanted to —
    // and "Property proposal" became a half-wrong title the day 0041 added a
    // second kind. A neutral one is both accurate and quieter.
    title: "Property information",
    robots: { index: false, follow: false },
  };
}

export default async function ProposalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = createPublicClient();

  // SEC-04 (0081): an IP hash already over its MISS budget gets refused
  // BEFORE the SECURITY DEFINER resolve — previously the over-budget answer
  // was discarded into a log line and a scanner got a full resolve per
  // probe. The peek is READ-ONLY (the 0023 counter means misses, and only
  // note_share_link_miss may increment it — a legitimate open still never
  // touches the table), and the refusal is the SAME neutral 200 page as
  // every other outcome, so a prober learns nothing from being refused.
  // Strict === true: a transport error fails OPEN, exactly as the feed does.
  const ipHash = await callerIpHash();
  const overBudget = await supabase.rpc("share_link_over_budget", { p_ip_hash: ipHash });
  if (overBudget.data === true) {
    console.warn("[share-link] over-budget probe refused before resolve");
    return <Unavailable />;
  }

  // Reject shapes we never mint before touching the database — a cheap miss
  // costs no round trip, and this is where path-traversal-ish junk dies.
  if (!isWellFormedShareToken(token)) {
    await supabase.rpc("note_share_link_miss", { p_ip_hash: ipHash });
    return <Unavailable />;
  }

  const { data, error } = await supabase.rpc("resolve_share_link", {
    p_token_sha256: hashShareToken(token),
  });

  // A transient RPC failure must not read as "revoked" to the buyer, but it
  // also must not leak that the token was fine — same neutral page, and the
  // error goes to the server log where an operator can see it.
  if (error) {
    console.error("[share-link] resolve failed", error.message);
    return <Unavailable />;
  }

  if (!data) {
    // still increment on the miss — the budget the peek above reads
    const missBudget = await supabase.rpc("note_share_link_miss", { p_ip_hash: ipHash });
    if (missBudget.data) console.warn("[share-link] miss budget exceeded");
    return <Unavailable />;
  }

  // One RPC serves both kinds (0041), so the dispatch happens here rather than
  // in the token: the page cannot know which kind it holds until the resolver
  // says so. Only the availability payload carries `kind`, which is what let
  // the proposal boundary — and the test pinning it — stay untouched.
  const resolved = data as unknown as ResolvedShareLink;
  return isAvailability(resolved) ? (
    <AvailabilityView availability={resolved} />
  ) : (
    <ProposalView proposal={resolved} />
  );
}
