import { after, NextResponse, type NextRequest } from "next/server";
import { createPublicClient } from "@/lib/supabase/public";
import { callerIpHash } from "@/lib/services/caller-ip";
import { budgetsFor } from "@/lib/services/enquiry-budget";
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

/**
 * Set by our own marketing site, which posts on a visitor's behalf. Trusted
 * only to make the limit STRICTER for that visitor, never to lift it — the
 * reasoning, the two limits and the no-double-count rule all live in
 * lib/services/enquiry-budget.ts, where they can be tested.
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
  const budgets = budgetsFor(
    await callerIpHash(),
    request.headers.get(VISITOR_IP_HEADER),
  );
  for (const b of budgets) {
    const check = await supabase.rpc("note_public_enquiry_hit", {
      p_ip_hash: b.hash,
      p_limit: b.limit,
    });
    if (check.data === true) {
      return NextResponse.json(
        { error: "Too many enquiries from this address. Try again shortly." },
        { status: 429, headers: { ...CORS, "Cache-Control": "no-store", "Retry-After": "900" } },
      );
    }
    // DELIBERATELY FAILS OPEN, and says so. If the counter itself errors we let
    // the enquiry through rather than answer 429, because the two outcomes are
    // not symmetric: a junk lead is marked spam in one click, while a real
    // buyer told "too many enquiries" — which would also be a lie about why —
    // is gone. Logged at error level so a counter that has stopped working is
    // visible rather than silently permissive, which was the actual defect.
    if (check.error) {
      console.error("[public enquiry] rate counter failed, allowing:", check.error.message);
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
