import { after, NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { callerIpHash } from "@/lib/services/caller-ip";
import { budgetsFor } from "@/lib/services/enquiry-budget";
import { isTrustedForwarderLoudly } from "@/lib/services/forwarder";
import { enquiryCompleteness, publicEnquirySchema } from "@/lib/validators/public-enquiry";
import { sendEnquiryAlert } from "@/lib/services/enquiry-alert";
import { recordEnquiryAlert } from "@/lib/services/enquiry-alert-event";
import { sendEnquiryAck } from "@/lib/services/enquiry-ack";

/**
 * The public enquiry door (WF-4, migration 0084) — the first place anything
 * outside this system can WRITE into it.
 *
 * PUBLIC AND UNAUTHENTICATED BY DESIGN, like the listing feed beside it:
 * `proxy.ts` exempts `/api/public/`. The function it calls validates on its
 * own terms — read 0084's header for the reasoning.
 *
 * THIS HANDLER IS THE ONLY DOOR, AND SINCE 0087 THE DATABASE SAYS SO. The two
 * functions are EXECUTE-granted to service_role alone, so this file calls
 * them with the server-only admin client. That client bypasses RLS, which is
 * exactly why this file must stay as small as it is: every write still goes
 * through submit_public_enquiry, and nothing here touches a table. Until 0087
 * the publishable key could reach the same two functions from anywhere and
 * skip every control below — counter, honeypot, e-mail format, desk alert —
 * one silent lead and one permanent event per call (the 2026-09-06 audit's
 * A01; docs/AUDIT_2026-09-06_RESPONSE.md, Now #2).
 *
 * WHAT THIS FILE ADDS on top of the function: a useful 400 for whoever is
 * building the site, the honeypot drop, and the rate check BEFORE the write
 * so a flood costs one counter round trip instead of a lead insert.
 */
export const dynamic = "force-dynamic";

/**
 * Set by our own marketing site, which posts on a visitor's behalf. Honoured
 * only when the site has proved it is the sender (the key below), and then
 * only to make the limit STRICTER for that visitor, never to lift it — the
 * reasoning, the two limits and the no-double-count rule all live in
 * lib/services/enquiry-budget.ts, where they can be tested.
 */
const VISITOR_IP_HEADER = "x-gnk-visitor-ip";

/**
 * The site's proof: a static shared secret, `ENQUIRY_FORWARD_KEY` here and
 * `CRM_FORWARD_KEY` there, compared in constant time (lib/services/forwarder.ts).
 * It decides ONE thing — whether the visitor header is believed. Without it,
 * or with the wrong one, the caller is metered as itself; the door stays open.
 */
const FORWARD_KEY_HEADER = "x-gnk-forward-key";

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

  // Service role, deliberately: see the header. Nothing below reads a table.
  const supabase = createAdminClient();

  // Rate limit BEFORE anything else touches the database, so a flood costs one
  // counter round trip. Its own counter (0084) — a flood here must not spend a
  // buyer's share-link budget or the feed's.
  const budgets = budgetsFor(
    await callerIpHash(),
    request.headers.get(VISITOR_IP_HEADER),
    isTrustedForwarderLoudly(request.headers.get(FORWARD_KEY_HEADER), process.env.ENQUIRY_FORWARD_KEY),
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
    p_idempotency_key: input.idempotency_key ?? "",
    // 0098: the site's brief and provenance, already cleaned by the schema;
    // null, not {}, when the caller sent none — the function reads it as absent
    p_meta: input.meta ?? null,
  });

  if (error) {
    // Never the database's words: they would describe a schema the caller
    // has no business knowing about.
    console.error("[public enquiry] rpc failed:", error.message);
    return json({ error: "Could not accept that enquiry." }, 503);
  }
  // 0096: the function answers one row — the lead it made or replayed — and
  // a refusal is zero rows. The schema above already caught every shape
  // problem, so what is left is an org slug that does not exist.
  const row = (data ?? [])[0];
  if (!row) return json({ error: "Unknown `org`." }, 400);

  // A replay (0096): the first post with this key already made the lead and
  // told the desk. Accepted again, and nothing more happens — a second alert
  // would be exactly the duplicate the key exists to prevent.
  if (row.replayed) return json({ accepted: true }, 202);

  // The desk is told AFTER the response goes out. `after()` runs once the
  // visitor already has their 202, so a slow mail provider never delays the
  // thank-you — and a failed send can never turn a saved enquiry into an
  // error, which is the whole reason the alert lives here and not inside the
  // database function.
  after(async () => {
    const outcome = await sendEnquiryAlert({
      name: input.name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      message: input.message ?? null,
      propertyReference: input.property_reference ?? null,
      meta: input.meta ?? null,
    });
    // …and the outcome goes on the lead's timeline (INT-01). Until 0096 the
    // word came back here and was dropped, so a failed or skipped alert was
    // a console line and nothing else, and the lead sat in the inbox with
    // its response clock running and nobody told.
    await recordEnquiryAlert(supabase, {
      orgId: row.lead_org_id,
      leadId: row.lead_id,
      outcome,
    });

    // 0098 (audit LR-06): the enquirer is acknowledged too — once per fresh
    // enquiry (a replay and a honeypot hit return above), from the firm's own
    // address, only when they left one. The firm's name comes from the org
    // row the door named; without it the acknowledgement is skipped rather
    // than signed by a literal.
    if (input.email) {
      const { data: org } = await supabase
        .from("organizations")
        .select("name")
        .eq("id", row.lead_org_id)
        .maybeSingle();
      if (org?.name) {
        await sendEnquiryAck({
          name: input.name,
          email: input.email,
          propertyReference: input.property_reference ?? null,
          orgName: org.name,
        });
      } else {
        console.warn("[enquiry-ack] SKIPPED — the organisation row could not be read.");
      }
    }
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
