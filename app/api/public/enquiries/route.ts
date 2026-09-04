import { after, NextResponse, type NextRequest } from "next/server";
import { createPublicClient } from "@/lib/supabase/public";
import { callerIpHash, hashIp } from "@/lib/services/caller-ip";
import { enquiryCompleteness, publicEnquirySchema } from "@/lib/validators/public-enquiry";
import { sendEnquiryAlert } from "@/lib/services/enquiry-alert";

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

/** Submissions per VISITOR per 15 minutes. The feed's budget is 120; this writes. */
const RATE_LIMIT = 5;

/**
 * Submissions per 15 minutes from one CALLER, when that caller speaks for many
 * visitors — the marketing site posts server-to-server, so every enquiry it
 * forwards arrives from one address.
 *
 * WHY BOTH. Metering only the transport address made five the budget for the
 * entire internet: the sixth genuine buyer in any quarter of an hour was
 * refused with "Too many enquiries from this address" — an address that was
 * not theirs — and a shell loop could hold the firm's only inbound channel
 * shut for free. Metering only the forwarded address would be worse: anyone
 * can send a header. So the forwarded address gets the tight per-person
 * budget, and the address the packets actually came from still gets a ceiling.
 * Forging the header buys a fresh personal budget, never an escape from this
 * one.
 */
const ORIGIN_RATE_LIMIT = 60;

/**
 * Set by our own marketing site, which posts on a visitor's behalf. Trusted
 * only to make the limit STRICTER for that visitor, never to lift it — see
 * ORIGIN_RATE_LIMIT.
 */
const VISITOR_IP_HEADER = "x-gnk-visitor-ip";

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
  const transportHash = await callerIpHash();
  const forwarded = request.headers.get(VISITOR_IP_HEADER)?.split(",")[0]?.trim();
  // No header means the caller IS the visitor (a browser posting directly), and
  // the transport address is already the right thing to meter.
  const visitorHash = forwarded ? hashIp(forwarded) : transportHash;

  const tooMany = () =>
    NextResponse.json(
      { error: "Too many enquiries from this address. Try again shortly." },
      { status: 429, headers: { ...CORS, "Cache-Control": "no-store", "Retry-After": "900" } },
    );

  const perVisitor = await supabase.rpc("note_public_enquiry_hit", {
    p_ip_hash: visitorHash,
    p_limit: RATE_LIMIT,
  });
  if (perVisitor.data === true) return tooMany();
  // DELIBERATELY FAILS OPEN, and says so. If the counter itself errors we let
  // the enquiry through rather than answer 429, because the two outcomes are
  // not symmetric: a junk lead is marked spam in one click, while a real buyer
  // told "too many enquiries" — which would also be a lie about why — is gone.
  // Logged at error level so a counter that has stopped working is visible
  // rather than silently permissive, which was the actual defect here.
  if (perVisitor.error) {
    console.error("[public enquiry] rate counter failed, allowing:", perVisitor.error.message);
  }

  // Only when someone claimed to speak for a visitor. Without this guard the
  // same hash would be counted twice per request and halve the real budget.
  if (forwarded) {
    const perOrigin = await supabase.rpc("note_public_enquiry_hit", {
      p_ip_hash: transportHash,
      p_limit: ORIGIN_RATE_LIMIT,
    });
    if (perOrigin.data === true) return tooMany();
    if (perOrigin.error) {
      console.error("[public enquiry] origin counter failed, allowing:", perOrigin.error.message);
    }
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

  // The desk is told AFTER the response goes out. `after()` runs once the
  // visitor already has their 202, so a slow mail provider never delays the
  // thank-you — and a failed send can never turn a saved enquiry into an
  // error, which is the whole reason the alert lives here and not inside the
  // database function.
  after(async () => {
    await sendEnquiryAlert({
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      message: input.message ?? null,
      propertyReference: input.property_reference ?? null,
    });
  });

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
