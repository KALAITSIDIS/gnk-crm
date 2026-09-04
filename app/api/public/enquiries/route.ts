import { NextResponse, type NextRequest } from "next/server";
import { createPublicClient } from "@/lib/supabase/public";
import { callerIpHash } from "@/lib/services/caller-ip";
import { enquiryCompleteness, publicEnquirySchema } from "@/lib/validators/public-enquiry";

/**
 * The public enquiry door (WF-4, migration 0084) — the first place anything
 * outside this system can WRITE into it.
 *
 * PUBLIC AND UNAUTHENTICATED BY DESIGN, like the listing feed beside it:
 * `proxy.ts` exempts `/api/public/`. Everything that keeps it safe is one
 * layer down, in SQL — read 0084's header for the reasoning. This handler
 * holds the ANON client, so even rewritten to do whatever it liked it could
 * reach exactly two functions by name and no table at all.
 *
 * WHAT THIS FILE ADDS on top of the function: a useful 400 for whoever is
 * building the site, the honeypot drop, and the rate check BEFORE the write
 * so a flood costs one counter round trip instead of a lead insert.
 */
export const dynamic = "force-dynamic";

/** Submissions per IP per 15 minutes. The feed's budget is 120; this writes. */
const RATE_LIMIT = 5;

const CORS = {
  // A public contact form: any site may post one, exactly as any site may
  // read the feed. There is no session and no cookie here, so there is no
  // cross-site request to forge — the rate limit is what bounds abuse.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

const json = (body: unknown, status: number) =>
  NextResponse.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store" } });

export async function POST(request: NextRequest) {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return json({ error: "Send application/json." }, 415);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "That is not valid JSON." }, 400);
  }

  const parsed = publicEnquirySchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: parsed.error.issues[0]?.message ?? "Invalid enquiry." }, 400);
  }
  const input = parsed.data;

  const incomplete = enquiryCompleteness(input);
  if (incomplete) return json({ error: incomplete }, 400);

  const supabase = createPublicClient();

  // Rate limit BEFORE anything else touches the database, so a flood costs one
  // counter round trip. Its own counter (0084) — a flood here must not spend a
  // buyer's share-link budget or the feed's.
  const overBudget = await supabase.rpc("note_public_enquiry_hit", {
    p_ip_hash: await callerIpHash(),
    p_limit: RATE_LIMIT,
  });
  if (overBudget.data === true) {
    return NextResponse.json(
      { error: "Too many enquiries from this address. Try again shortly." },
      { status: 429, headers: { ...CORS, "Cache-Control": "no-store", "Retry-After": "900" } },
    );
  }

  // The honeypot is checked AFTER the rate limit and answered like a success:
  // a bot that learns which shape gets rejected simply changes shape.
  if (input.website) return json({ accepted: true }, 202);

  const { data, error } = await supabase.rpc("submit_public_enquiry", {
    p_org_slug: input.org,
    p_name: input.name,
    // "" rather than null: these parameters are declared NOT NULL-able in the
    // generated types, and 0084 opens with nullif(btrim(coalesce(…,''),'')) —
    // an empty string IS how you say "absent" to this function
    p_email: input.email ?? "",
    p_phone: input.phone ?? "",
    p_message: input.message ?? "",
    p_property_ref: input.property_reference ?? "",
  });

  if (error) {
    // Never the database's words: they would describe a schema the caller
    // has no business knowing about.
    console.error("[public enquiry] rpc failed:", error.message);
    return json({ error: "Could not accept that enquiry." }, 503);
  }
  if (data !== true) {
    // The function refused. The schema above already caught every shape
    // problem, so what is left is an org slug that does not exist.
    return json({ error: "Unknown `org`." }, 400);
  }

  // 202, not 201: the desk decides what this becomes, and the caller gets no
  // id — there is nothing it could legitimately do with one.
  return json({ accepted: true }, 202);
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: { ...CORS, "Access-Control-Max-Age": "86400" },
  });
}
