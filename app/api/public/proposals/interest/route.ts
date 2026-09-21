import { randomUUID } from "node:crypto";
import { after, NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { callerIpHash } from "@/lib/services/caller-ip";
import { RATE_LIMIT } from "@/lib/services/enquiry-budget";
import { runEnquiryAlertWorker } from "@/lib/services/enquiry-alert-worker";
import { sendEnquiryAck } from "@/lib/services/enquiry-ack";
import { hashShareToken } from "@/lib/services/share-links-token";
import {
  PROPOSAL_INTEREST_ERROR_TEXT,
  interestCompleteness,
  interestProblem,
  proposalInterestSchema,
  type ProposalInterestProblem,
} from "@/lib/validators/proposal-interest";

/**
 * "I'm interested" on a shared proposal (0106, audit 2026-09-21 finding 4):
 * the buyer-facing page at /p/[token] posts here when a visitor asks about
 * ONE property in the selection. Same construction as the website door
 * beside it (app/api/public/enquiries/route.ts): unauthenticated by design
 * (`proxy.ts` exempts `/api/public/`), the service-role client because the
 * function is EXECUTE-granted to service_role alone, and every write goes
 * through that one function — `submit_proposal_interest` resolves the
 * organisation, the proposal and the property from the token's digest,
 * refuses an expired or revoked link and a reference outside it, never
 * attributes the link's contact to whoever is typing, writes the lead, its
 * event, its durable desk-alert row and the assignment to the proposal's
 * author, and answers a replayed key with the same lead.
 *
 * WHAT THIS FILE ADDS: a useful 400, the enquiry door's rate meter BEFORE
 * the write, the honeypot drop, the token hashed here so the database
 * only ever sees a digest, one neutral 404 for every refusal, and — once
 * the visitor has their 202 — the same accelerator and acknowledgement the
 * website door runs. No CORS: the page lives on this origin.
 *
 * EVERY REFUSAL IS A CODE (audit 2026-09-22, finding 2). The body of a
 * non-2xx answer is `{ error, code, field }`: `error` is an English
 * sentence for a caller that is not the page, `code` is the stable word
 * the page translates (lib/services/proposal-interest-copy.ts) and `field`
 * names the control it concerns, or null. The page never shows `error`.
 */
export const dynamic = "force-dynamic";

const json = (body: unknown, status: number, extra: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });

/** A refusal, in the shape the page reads: an English sentence, a code, and the field or null. */
const refuse = (error: string, code: string, status: number, field: ProposalInterestProblem["field"] = null, extra: Record<string, string> = {}) =>
  json({ error, code, field }, status, extra);

export async function POST(request: NextRequest) {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return refuse("Send application/json.", "unsupported_media_type", 415);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse("That is not valid JSON.", "invalid_json", 400);
  }

  const parsed = proposalInterestSchema.safeParse(body);
  if (!parsed.success) {
    const problem = interestProblem(parsed.error.issues);
    return refuse(PROPOSAL_INTEREST_ERROR_TEXT[problem.code], problem.code, 400, problem.field);
  }
  const input = parsed.data;
  const incomplete = interestCompleteness(input);
  if (incomplete) return refuse(PROPOSAL_INTEREST_ERROR_TEXT[incomplete.code], incomplete.code, 400, incomplete.field);

  const supabase = createAdminClient();

  // The enquiry door's own meter (0084): a flood here must cost one counter
  // round trip, and it must not spend a buyer's share-link miss budget.
  const meter = await supabase.rpc("note_public_enquiry_hit", {
    p_ip_hash: await callerIpHash(),
    p_limit: RATE_LIMIT,
  });
  if (meter.data === true) {
    return refuse("Too many enquiries from this address. Try again shortly.", "rate_limited", 429, null, { "Retry-After": "900" });
  }
  if (meter.error) {
    // Fails OPEN, loudly — the same asymmetry as the door: a junk lead is one
    // click to mark, a real buyer refused is gone.
    console.error("[proposal interest] rate counter failed, allowing:", meter.error.message);
  }

  // After the meter, answered like a success: a bot that learns which shape
  // is rejected changes shape.
  if (input.website) return json({ accepted: true }, 202);

  const { data, error } = await supabase.rpc("submit_proposal_interest", {
    p_token_sha256: hashShareToken(input.token),
    p_property_ref: input.property_reference,
    p_name: input.name,
    p_email: input.email ?? "",
    p_phone: input.phone ?? "",
    p_message: input.message ?? "",
    p_idempotency_key: input.idempotency_key,
  });

  if (error) {
    // Never the database's words. Since the desk-alert row is written in the
    // lead's transaction, a failure here rolled the lead back too; 503 tells
    // the page to try once more with the same key.
    console.error("[proposal interest] rpc failed:", error.message);
    return refuse("Could not record your interest. Please try again.", "unavailable", 503);
  }

  // One neutral answer for every refusal — an expired, revoked or unknown
  // link, a reference the proposal does not hold — exactly as the page
  // renders one neutral "no longer available" for every failed resolve.
  const row = (data ?? [])[0];
  if (!row) return refuse("This link is no longer available.", "link_unavailable", 404);

  // A replay: the first post with this key made the lead and its alert row.
  if (row.replayed) return json({ accepted: true }, 202);

  // THE DESK ALERT IS ALREADY A ROW. What runs here, after the 202, is the
  // accelerator — the worker claims that one row and makes the first
  // provider attempt now — and the enquirer's acknowledgement (0098), only
  // when they left an e-mail address. The sweep finishes whatever this misses.
  after(async () => {
    try {
      await runEnquiryAlertWorker(supabase, {
        workerId: `route:${randomUUID()}`,
        leadId: row.lead_id,
        limit: 1,
      });
    } catch (err) {
      console.error("[proposal interest] alert accelerator threw:", err instanceof Error ? err.name : String(err));
    }

    if (input.email) {
      const { data: org } = await supabase.from("organizations").select("name").eq("id", row.lead_org_id).maybeSingle();
      if (org?.name) {
        await sendEnquiryAck({
          name: input.name,
          email: input.email,
          propertyReference: input.property_reference,
          orgName: org.name,
        });
      } else {
        console.warn("[enquiry-ack] SKIPPED — the organisation row could not be read.");
      }
    }
  });

  return json({ accepted: true }, 202);
}
