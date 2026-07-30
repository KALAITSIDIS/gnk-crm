import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { Proposal as ProposalView } from "@/components/features/share-links/proposal";
import {
  hashShareToken,
  isWellFormedShareToken,
  type Proposal,
} from "@/lib/services/share-links";
import { createPublicClient } from "@/lib/supabase/public";

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

/** A visitor's IP is never stored; only a salted hash, for the miss counter. */
async function callerIpHash(): Promise<string> {
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "unknown";
  return createHash("sha256")
    .update(`${ip}:${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

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
    title: "Property proposal",
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

  // Reject shapes we never mint before touching the database — a cheap miss
  // costs no round trip, and this is where path-traversal-ish junk dies.
  if (!isWellFormedShareToken(token)) {
    await supabase.rpc("note_share_link_miss", { p_ip_hash: await callerIpHash() });
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
    const overBudget = await supabase.rpc("note_share_link_miss", {
      p_ip_hash: await callerIpHash(),
    });
    if (overBudget.data) console.warn("[share-link] miss budget exceeded");
    return <Unavailable />;
  }

  return <ProposalView proposal={data as unknown as Proposal} />;
}
