"use server";

import * as Sentry from "@sentry/nextjs";
import { revalidatePath } from "next/cache";
import type { Database } from "@/lib/supabase/database.types";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { changesForChain, isNoteField } from "@/lib/services/event-changes";
import { recomputeDealHealth } from "@/lib/services/health-score";
import { createClient } from "@/lib/supabase/server";
import {
  DECIDED_STATUSES,
  OFFER_TRANSITIONS,
  dealCommissionSchema,
  dealDetailsSchema,
  logDealContactSchema,
  markLostSchema,
  markWonSchema,
  saveOfferSchema,
  unconfirmedCloseText,
  type OfferStatus,
} from "@/lib/validators/deals";
import { cyprusEndOfToday } from "@/lib/validators/reservations";
import { createAdminClient } from "@/lib/supabase/admin";

export type MoveDealResult = { error: string | null };

/**
 * Drag-and-drop stage change (T3.1). Delegates to the move_deal_to_stage RPC
 * (migration 0011) so the deal UPDATE and its stage_changed event commit in
 * one transaction — a move can never land without its event, and an
 * RLS-filtered 0-row update aborts instead of logging a phantom event.
 * Returns a result object, never throws: Next.js strips thrown Server Action
 * messages in production, which would hide the guard texts from the toast.
 */
export async function moveDealToStage(dealId: string, stageId: string): Promise<MoveDealResult> {
  try {
    const supabase = await createClient();
    const { error } = await supabase.rpc("move_deal_to_stage", {
      p_deal_id: dealId,
      p_stage_id: stageId,
    });
    if (error) return { error: error.message };

    await recomputeDealHealth(supabase, dealId);
    revalidatePath("/pipeline");
    return { error: null };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Move failed" };
  }
}

/**
 * `notice`: saved, with a caveat the user must see (the properties/units
 * convention) — a close that was already in place, or a committed Won whose
 * follow-up could not be filed. `alreadyClosed` tells the dialog which, so a
 * repeat is not announced as a fresh success.
 */
export type DealSectionState = {
  error: string | null;
  savedAt: number | null;
  notice?: string | null;
  /** a close that found the deal already in the requested state: nothing was written */
  alreadyClosed?: boolean;
  /**
   * The answer came with a refresh of the deal page (a conflict, a repeat, an
   * unknown result). The page renders the Won/Lost dialogs only while the deal
   * is open, so if it is now closed the dialog is gone — anything said with
   * this answer must outlive it.
   */
  pageRefreshed?: boolean;
};

/**
 * Change-diff equality that treats numeric strings numerically — Postgres
 * numeric comes back as "480000.00" while form input parses to 480000; those
 * are the same value, not a change.
 */
function normEq(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => {
    if (v === undefined || v === null || v === "") return null;
    if (typeof v === "object") return JSON.stringify(v);
    const n = Number(v);
    if (typeof v !== "boolean" && String(v).trim() !== "" && Number.isFinite(n)) return String(n);
    return String(v);
  };
  return norm(a) === norm(b);
}

/** What a deal or offer event may not carry by value: text somebody typed. */
const dealShapeOnly = (field: string) => field === "title" || isNoteField(field);
const offerShapeOnly = (field: string) => field === "terms" || isNoteField(field);

/** Deal detail sections (T3.2): "details" (parties/value/title) and "commission". */
export async function updateDealSection(
  _prev: DealSectionState,
  formData: FormData,
): Promise<DealSectionState> {
  const dealId = formData.get("deal_id");
  const section = formData.get("section");
  if (typeof dealId !== "string" || typeof section !== "string") {
    return { error: "Missing deal or section", savedAt: null };
  }

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: current } = await supabase.from("deals").select("*").eq("id", dealId).maybeSingle();
  if (!current) return { error: "Deal not found", savedAt: null };

  const raw = Object.fromEntries(formData.entries());
  let updates: Database["public"]["Tables"]["deals"]["Update"];
  // health section: event the flag change, not the whole jsonb snapshot
  let changedOverride: Record<string, { from: unknown; to: unknown }> | null = null;

  if (section === "details") {
    const parsed = dealDetailsSchema.safeParse(raw);
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
    }
    const d = parsed.data;
    updates = {
      title: d.title,
      property_id: d.property_id ?? null,
      buyer_contact_id: d.buyer_contact_id ?? null,
      seller_contact_id: d.seller_contact_id ?? null,
      agent_id: d.agent_id ?? null,
      expected_value: d.expected_value ?? null,
    };
  } else if (section === "commission") {
    const parsed = dealCommissionSchema.safeParse(raw);
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
    }
    updates = { commission_split_notes: parsed.data.commission_split_notes || null };
  } else if (section === "health") {
    // Manual health checklist flag (doc 02 §C5: budget confirmed 25).
    // Merged into the health jsonb next to the computed factor snapshot.
    const health = (current.health ?? {}) as Record<string, unknown>;
    const budgetConfirmed = raw.budget_confirmed === "on";
    if ((health.budget_confirmed === true) === budgetConfirmed) {
      return { error: null, savedAt: Date.now() };
    }
    updates = {
      health: JSON.parse(JSON.stringify({ ...health, budget_confirmed: budgetConfirmed })),
    };
    changedOverride = {
      budget_confirmed: { from: health.budget_confirmed === true, to: budgetConfirmed },
    };
  } else {
    return { error: `Unknown section: ${section}`, savedAt: null };
  }

  const changed: Record<string, { from: unknown; to: unknown }> = changedOverride ?? {};
  if (!changedOverride) {
    for (const [key, next] of Object.entries(updates)) {
      const prev = (current as Record<string, unknown>)[key];
      if (!normEq(prev, next)) changed[key] = { from: prev ?? null, to: next ?? null };
    }
    if (Object.keys(changed).length === 0) return { error: null, savedAt: Date.now() };
  }

  // .select() so an RLS-filtered 0-row update surfaces instead of silently
  // logging an "updated" event for a write that never happened.
  const { data: updatedRow, error: updateErr } = await supabase
    .from("deals")
    .update({ ...updates, last_activity_at: new Date().toISOString() })
    .eq("id", dealId)
    .select("id")
    .maybeSingle();
  if (updateErr) return { error: updateErr.message, savedAt: null };
  if (!updatedRow) return { error: "You do not have permission to edit this deal", savedAt: null };

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "deal",
    entityId: dealId,
    eventType: "updated",
    // a deal's title is built from the buyer's name (convertLead) — it and
    // the split notes record shape only (SEC-03)
    payload: JSON.parse(
      JSON.stringify({ section, changed: changesForChain(changed, dealShapeOnly) }),
    ),
  });

  await recomputeDealHealth(supabase, dealId);
  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/pipeline");
  return { error: null, savedAt: Date.now() };
}

export type OfferActionState = { error: string | null; savedAt: number | null };

/**
 * Create a new offer, or edit amount/terms/validity of an open one
 * (submitted/countered). Decided offers are immutable; there is no hard
 * delete — withdraw instead (DECISIONS T3.2, evidence trail).
 */
export async function saveOffer(
  _prev: OfferActionState,
  formData: FormData,
): Promise<OfferActionState> {
  const parsed = saveOfferSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const input = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: deal } = await supabase
    .from("deals")
    .select("id, org_id, status, property_id, buyer_contact_id")
    .eq("id", input.deal_id)
    .maybeSingle();
  if (!deal) return { error: "Deal not found", savedAt: null };
  if (deal.status !== "open") return { error: "Deal is closed — offers are frozen", savedAt: null };

  if (input.offer_id) {
    const { data: offer } = await supabase
      .from("offers")
      .select("*")
      .eq("id", input.offer_id)
      .maybeSingle();
    if (!offer || offer.deal_id !== deal.id) return { error: "Offer not found", savedAt: null };
    if (offer.status !== "submitted" && offer.status !== "countered") {
      return { error: `A ${offer.status} offer can no longer be edited`, savedAt: null };
    }

    const updates = {
      amount: input.amount,
      terms: input.terms ?? null,
      valid_until: input.valid_until ?? null,
      contact_id: input.contact_id ?? null,
    };
    const changed: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, next] of Object.entries(updates)) {
      const prev = (offer as Record<string, unknown>)[key];
      if (!normEq(prev, next)) changed[key] = { from: prev ?? null, to: next ?? null };
    }
    if (Object.keys(changed).length === 0) return { error: null, savedAt: Date.now() };

    const { data: updatedOffer, error: updateErr } = await supabase
      .from("offers")
      .update(updates)
      .eq("id", offer.id)
      .select("id")
      .maybeSingle();
    if (updateErr) return { error: updateErr.message, savedAt: null };
    if (!updatedOffer) {
      return { error: "You do not have permission to edit this offer", savedAt: null };
    }

    await logEvent(supabase, {
      orgId: profile.orgId,
      actorId: profile.id,
      entityType: "offer",
      entityId: offer.id,
      eventType: "updated",
      payload: JSON.parse(
        JSON.stringify({ deal_id: deal.id, changed: changesForChain(changed, offerShapeOnly) }),
      ),
    });
  } else {
    const { data: created, error: insertErr } = await supabase
      .from("offers")
      .insert({
        org_id: deal.org_id,
        deal_id: deal.id,
        property_id: deal.property_id,
        contact_id: input.contact_id ?? deal.buyer_contact_id,
        amount: input.amount,
        terms: input.terms ?? null,
        valid_until: input.valid_until ?? null,
        created_by: profile.id,
      })
      .select("id")
      .single();
    if (insertErr) return { error: insertErr.message, savedAt: null };

    await logEvent(supabase, {
      orgId: profile.orgId,
      actorId: profile.id,
      entityType: "offer",
      entityId: created.id,
      eventType: "created",
      payload: { deal_id: deal.id, amount: input.amount },
    });
  }

  await supabase
    .from("deals")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", deal.id);

  await recomputeDealHealth(supabase, deal.id);
  revalidatePath(`/deals/${deal.id}`);
  revalidatePath("/pipeline");
  return { error: null, savedAt: Date.now() };
}

export type OfferStatusResult = { wonEligible: boolean; error: string | null };

/**
 * Guarded offer status transition. Accepting flags the deal won-eligible
 * (the caller prompts; the guarded Won flow itself lands in T3.4) and is
 * blocked while another accepted offer exists on the deal.
 * Returns a result object, never throws — thrown Server Action messages are
 * stripped in production builds and the guard texts would never reach the UI.
 */
export async function updateOfferStatus(
  offerId: string,
  next: OfferStatus,
): Promise<OfferStatusResult> {
  const fail = (error: string): OfferStatusResult => ({ wonEligible: false, error });
  try {
    const supabase = await createClient();
    const profile = await getCurrentProfile(supabase);

    const { data: offer } = await supabase
      .from("offers")
      .select("id, org_id, deal_id, amount, status")
      .eq("id", offerId)
      .maybeSingle();
    if (!offer) return fail("Offer not found");

    const allowed = OFFER_TRANSITIONS[offer.status as OfferStatus] ?? [];
    if (!allowed.includes(next)) {
      return fail(`Cannot move a ${offer.status} offer to ${next}`);
    }

    if (next === "accepted") {
      const { data: alreadyAccepted } = await supabase
        .from("offers")
        .select("id")
        .eq("deal_id", offer.deal_id)
        .eq("status", "accepted")
        .neq("id", offer.id)
        .limit(1);
      if (alreadyAccepted?.[0]) {
        return fail("This deal already has an accepted offer");
      }
    }

    // .select() so an RLS-filtered 0-row update aborts before the event write.
    const { data: updatedOffer, error: updateErr } = await supabase
      .from("offers")
      .update({
        status: next,
        decided_at: DECIDED_STATUSES.includes(next) ? new Date().toISOString() : null,
      })
      .eq("id", offer.id)
      .select("id")
      .maybeSingle();
    if (updateErr) return fail(updateErr.message);
    if (!updatedOffer) return fail("You do not have permission to update this offer");

    await logEvent(supabase, {
      orgId: offer.org_id,
      actorId: profile.id,
      entityType: "offer",
      entityId: offer.id,
      eventType: "status_changed",
      payload: { deal_id: offer.deal_id, from: offer.status, to: next, amount: offer.amount },
    });

    await supabase
      .from("deals")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", offer.deal_id);

    await recomputeDealHealth(supabase, offer.deal_id);
    revalidatePath(`/deals/${offer.deal_id}`);
    revalidatePath("/pipeline");
    return { wonEligible: next === "accepted", error: null };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Update failed");
  }
}

/**
 * What `close_deal` (migration 0117) answers when it did not raise. `closed`
 * means THIS request committed the transition and its events; the other two
 * mean the deal was already closed when this request got the row lock, and
 * nothing was written.
 */
type CloseDealAnswer = {
  result: "closed" | "already_closed" | "conflict";
  status: "won" | "lost";
  deal_id: string;
  org_id?: string;
  property_id?: string;
  agent_id?: string;
};

type CloseOutcome = "won" | "lost";

function readCloseAnswer(data: unknown): CloseDealAnswer | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const results = ["closed", "already_closed", "conflict"];
  if (typeof d.result !== "string" || !results.includes(d.result)) return null;
  if (d.status !== "won" && d.status !== "lost") return null;
  if (typeof d.deal_id !== "string") return null;
  return d as CloseDealAnswer;
}

const NOTHING_CHANGED = "Could not close the deal — nothing was changed. Try again.";

/**
 * Did this error come from a request whose transaction certainly did NOT
 * commit? A five-character SQLSTATE means PostgreSQL answered and the
 * statement failed — except class 08 (connection exceptions), which can mean
 * the connection dropped around the COMMIT. PGRST1xx-3xx are request-level
 * refusals made before or instead of running the function; PGRST002/003 mean
 * no connection was obtained. Everything else — no code (a network failure,
 * a gateway `{}` or HTML body), PGRST000/001, a status 0 — is unknown.
 */
function certainlyRolledBack(code: string | undefined): boolean {
  if (!code) return false;
  if (/^PGRST[123]\d\d$/.test(code) || code === "PGRST002" || code === "PGRST003") return true;
  return /^[0-9A-Z]{5}$/.test(code) && !code.startsWith("08");
}

/**
 * What went wrong with a close that did not commit — or might have. `unknown`
 * when it might have: the text is then `unconfirmedCloseText` (shared with
 * the dialog, which says the same when the request never comes back at all).
 */
function closeRefusal(
  error: { code?: string; message?: string },
  outcome: CloseOutcome,
): { text: string; unknown: boolean } {
  // P0001 is `raise exception` — close_deal's own sentence (or the 0117 guard's), meant to be read
  if (error.code === "P0001" && error.message) return { text: error.message, unknown: false };
  return certainlyRolledBack(error.code)
    ? { text: NOTHING_CHANGED, unknown: false }
    : { text: unconfirmedCloseText(outcome), unknown: true };
}

const OUTCOME_WORD: Record<CloseOutcome, string> = { won: "won", lost: "lost" };

/** Every page that shows a deal's status or its tasks — after ANY answer, so the screen matches the row. */
function revalidateClosedDeal(dealId: string): void {
  for (const path of [`/deals/${dealId}`, "/pipeline", "/dashboard", "/tasks"]) {
    try {
      revalidatePath(path);
    } catch (e) {
      // the close may already be committed; a stale page must not turn it into an error
      console.error(`[deals] revalidatePath(${path}) failed:`, e instanceof Error ? e.message : e);
    }
  }
}

/**
 * The console line is for the runtime log; Sentry is where a human is paged.
 * SHAPE ONLY — the operation, the step and the error code or name, never a
 * database message (the site-revalidate convention).
 */
function reportDealClose(
  message: string,
  tags: Record<string, string>,
  extra: Record<string, string>,
): void {
  console.error(`${message} (${Object.values(tags).join(", ")}) for deal ${extra.dealId}`);
  try {
    Sentry.captureMessage(message, { level: "error", tags, extra });
  } catch {
    // Sentry is best-effort; the console line stands
  }
}

const errorName = (e: unknown) => (e instanceof Error ? e.name : "threw");

type PromptProblem = "not_raised" | "raised_unlogged";

/**
 * The asks a committed Won raises (DB-01 and its live-hold sibling) and the
 * health recompute. Runs ONLY for the request whose `close_deal` answered
 * `closed` — a double submit, a retry or a competing close gets
 * `already_closed` / `conflict` and never reaches here, so one close raises
 * each prompt once.
 *
 * AFTER the commit, by design: a failed prompt must never roll back the win
 * (DECISIONS T-partials-close). supabase-js RESOLVES a failed request as
 * `{ error }` rather than throwing, so every step reads its `error` and says
 * which of two things it knows: the reminder may NOT exist (a read or the
 * insert failed — the user checks by hand, which is right whether or not one
 * exists), or it was created and only its timeline line failed (an admin
 * completes the record — the NOT_RECORDED_NOTICE convention). Returns the
 * notice for the user, or null.
 *
 * What this does NOT give is exactly-once: a function killed between the
 * commit and these steps (a timeout, a crash) leaves them unraised, and
 * nothing re-raises them — a retry would answer `already_closed`, which
 * deliberately does not re-run them (two requests racing the read-then-insert
 * dedupe below could file a prompt twice), and after such a crash the page no
 * longer offers the Won button anyway. What tells the user to check is the
 * dialog's own message for a request that never came back
 * (`unconfirmedCloseText("won")`, the same text this file returns for an
 * unknown answer), kept on screen until dismissed; a Won `already_closed`
 * (another tab) says it too.
 */
async function raiseWonFollowUps(
  supabase: Awaited<ReturnType<typeof createClient>>,
  closed: CloseDealAnswer,
): Promise<string | null> {
  const dealId = closed.deal_id;
  const orgId = closed.org_id;
  const extra = { dealId, propertyId: closed.property_id ?? "" };
  const problems: { what: string; kind: PromptProblem }[] = [];
  const fail = (step: string, code: string, what: string, kind: PromptProblem) => {
    reportDealClose("[deals] won follow-up failed", { operation: "deals.won_followup", step, code }, extra);
    problems.push({ what, kind });
  };

  if (closed.property_id && orgId) {
    let actorId: string | null = null;
    try {
      actorId = (await getCurrentProfile(supabase)).id;
    } catch (e) {
      fail("profile", errorName(e), "the reminders for the listing", "not_raised");
    }

    let prop: { id: string; reference: string; status: string } | null = null;
    if (actorId) {
      const { data, error } = await supabase
        .from("properties")
        .select("id, reference, status")
        .eq("id", closed.property_id)
        .maybeSingle();
      if (error) fail("property_read", error.code || "read_failed", "the reminders for the listing", "not_raised");
      prop = data;
    }

    // DB-01, the leg that ASKS: a won deal whose linked listing still reads
    // on-market raises a prompt task — never an automatic status flip (the
    // reservation↔status auto-coupling was DECLINED 2026-08-26; "the desk sets
    // the listing status" applies here too). One open task per property+kind.
    if (actorId && prop && ["available", "reserved", "under_offer"].includes(prop.status)) {
      const listing = `the reminder to update ${prop.reference}'s listing status`;
      /*
       * ASKED OF THE DATABASE, NOT OF THE READER. `tasks_select` is scoped to
       * admin, assignee OR creator, so on the caller's client "is a prompt
       * already open on this property?" is answered from the subset THEY can
       * see — and an actor blind to a colleague's prompt raises a second one.
       * `org_id` is explicit because the admin client has no RLS to add it.
       */
      const { data: existing, error: existingErr } = await createAdminClient()
        .from("tasks")
        .select("id")
        .eq("org_id", orgId)
        .eq("property_id", prop.id)
        .eq("kind", "listing_status_check")
        .eq("is_done", false)
        .limit(1);
      if (existingErr) {
        fail("listing_status_check", existingErr.code || "read_failed", listing, "not_raised");
      } else if (!existing?.length) {
        const { data: task, error: taskErr } = await supabase
          .from("tasks")
          .insert({
            org_id: orgId,
            title: `Deal won — update listing status: ${prop.reference}`,
            /*
             * CYPRUS END OF DAY, not the current instant.
             *
             * `overdue` is `due_at < now` (app/(app)/tasks/page.tsx), so a
             * prompt stamped with the moment it was raised renders OVERDUE on
             * the very next paint — the desk sees red for something it has had
             * no chance to do. The convention this repo already states in
             * lib/actions/tasks.ts is end-of-day for exactly that reason: "due
             * today" stays black until the working day actually ends.
             *
             * Today, not tomorrow: updating a listing after a deal is won or a
             * hold converts is same-day work. `raiseOneTask` uses tomorrow
             * because a match alert is not.
             */
            due_at: cyprusEndOfToday().toISOString(),
            assignee_id: closed.agent_id ?? actorId,
            property_id: prop.id,
            deal_id: dealId,
            created_by: actorId,
            kind: "listing_status_check",
          })
          .select("id")
          .single();
        if (taskErr || !task) {
          fail("listing_status_check", taskErr?.code || "insert_failed", listing, "not_raised");
        } else {
          try {
            await logEvent(supabase, {
              orgId,
              actorId,
              entityType: "property",
              entityId: prop.id,
              eventType: "followup_task_created",
              payload: { kind: "listing_status_check", task_id: task.id, deal_id: dealId },
            });
          } catch (e) {
            fail("listing_status_check_event", errorName(e), listing, "raised_unlogged");
          }
        }
      }
    }

    /*
     * THE SIBLING ASK — and NOT nested inside the status guard above.
     *
     * The listing status is one thing a won deal leaves stale; a live hold on
     * the same property is the other, and they are independent. A hold can
     * still be live on a listing someone has already flipped to `sold`, and
     * that hold is exactly as wrong: left alone it runs to expiry and
     * `expire_reservations()` records `release_reason = 'expired automatically'`
     * — the buyer's hold quietly lapsing on a property they bought.
     *
     * A prompt, not a release, for the reason the block above gives: the
     * reservation↔status coupling was DECLINED 2026-08-26, and the decision
     * that declined it set this precedent — "the Won side got a task that
     * ASKS". `raiseLiveHoldCheck` answers `not_needed` when there is no live hold.
     */
    if (actorId && prop) {
      const hold = `the reminder to settle the live hold on ${prop.reference}`;
      try {
        const { raiseLiveHoldCheck } = await import("@/lib/services/followup-tasks");
        const outcome = await raiseLiveHoldCheck(supabase, {
          propertyId: prop.id,
          orgId,
          actorId,
          dealId,
          assigneeId: closed.agent_id ?? actorId,
          propertyReference: prop.reference,
        });
        if (outcome === "not_raised" || outcome === "raised_unlogged") {
          fail("reservation_still_live", outcome, hold, outcome);
        }
      } catch (e) {
        fail("reservation_still_live", errorName(e), hold, "not_raised");
      }
    }
  }

  // derived state, no event, nothing for the user to do: paged, not put to them
  try {
    await recomputeDealHealth(supabase, dealId);
  } catch (e) {
    reportDealClose(
      "[deals] won follow-up failed",
      { operation: "deals.won_followup", step: "health", code: errorName(e) },
      extra,
    );
  }

  if (problems.length === 0) return null;
  const missing = problems.filter((p) => p.kind === "not_raised").map((p) => p.what);
  const unlogged = problems.filter((p) => p.kind === "raised_unlogged").map((p) => p.what);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const sentences: string[] = [];
  if (missing.length > 0) {
    sentences.push(
      `${cap(missing.join(" and "))} may not have been created — check the listing status and any live hold yourself.`,
    );
  }
  if (unlogged.length > 0) {
    const one = unlogged.length === 1;
    sentences.push(
      `${cap(unlogged.join(" and "))} ${one ? "was" : "were"} created, but ${one ? "its timeline entry" : "their timeline entries"} could not be recorded — tell an admin so the record can be completed.`,
    );
  }
  return `Deal marked won. ${sentences.join(" ")}`;
}

/**
 * Close a deal through `close_deal` and turn its answer into the dialog's
 * state. NEVER throws: Next strips thrown Server Action messages in
 * production, and a throw here would put a deal that IS closed behind an error
 * page. What the user is told, by answer:
 *
 * - `closed`            — saved; for Won, plus a notice if a follow-up failed;
 * - `already_closed`    — saved (`alreadyClosed`), with a notice that nothing
 *                         changed (a double submit or a retry of a close that
 *                         already landed);
 * - `conflict`          — an error: the OTHER outcome committed first;
 * - a raised refusal    — its own sentence (P0001);
 * - a database error that certainly rolled back — nothing was changed;
 * - anything else       — we cannot know, and say so.
 *
 * Nothing after a `closed` answer may say "nothing was changed".
 */
async function closeDeal(
  outcome: CloseOutcome,
  args: {
    p_deal_id: string;
    p_final_value?: number;
    p_lost_reason?: string;
    p_override?: boolean;
  },
): Promise<DealSectionState> {
  const extra = { dealId: args.p_deal_id };
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch (e) {
    // no request was made: nothing can have been written
    reportDealClose("[deals] close failed", { operation: "deals.close", code: errorName(e) }, extra);
    return { error: NOTHING_CHANGED, savedAt: null };
  }

  let answer: CloseDealAnswer | null = null;
  let refusal: { text: string; unknown: boolean } | null = null;
  const unknownRefusal = () => ({ text: unconfirmedCloseText(outcome), unknown: true });
  try {
    const { data, error } = await supabase.rpc("close_deal", { p_outcome: outcome, ...args });
    if (error) {
      refusal = closeRefusal(error, outcome);
      // a refusal in the function's own words is the product working; anything
      // else (a deploy-skew PGRST202, a gateway failure) must reach a human
      if (error.code !== "P0001") {
        reportDealClose("[deals] close failed", { operation: "deals.close", code: error.code || "none" }, extra);
      }
    } else {
      answer = readCloseAnswer(data);
      if (!answer) {
        refusal = unknownRefusal();
        reportDealClose("[deals] close failed", { operation: "deals.close", code: "unreadable_answer" }, extra);
      }
    }
  } catch (e) {
    refusal = unknownRefusal();
    reportDealClose("[deals] close failed", { operation: "deals.close", code: errorName(e) }, extra);
  }
  if (refusal !== null || !answer) {
    const r = refusal ?? unknownRefusal();
    if (!r.unknown) return { error: r.text, savedAt: null };
    // the page must show the truth, whichever way an unknown answer went
    revalidateClosedDeal(args.p_deal_id);
    return { error: r.text, savedAt: null, pageRefreshed: true };
  }

  const dealId = answer.deal_id;
  if (answer.result === "conflict") {
    revalidateClosedDeal(dealId);
    return {
      error: `This deal was already marked ${OUTCOME_WORD[answer.status]} — it was not marked ${OUTCOME_WORD[outcome]}.`,
      savedAt: null,
      pageRefreshed: true,
    };
  }
  if (answer.result === "already_closed") {
    revalidateClosedDeal(dealId);
    return {
      error: null,
      savedAt: Date.now(),
      alreadyClosed: true,
      pageRefreshed: true,
      notice:
        `This deal was already marked ${OUTCOME_WORD[outcome]} — nothing was changed.` +
        (outcome === "won"
          ? " If your earlier attempt did not confirm, check the listing status and any live hold yourself."
          : ""),
    };
  }

  let notice: string | null = null;
  if (outcome === "won") {
    try {
      notice = await raiseWonFollowUps(supabase, answer);
    } catch (e) {
      reportDealClose(
        "[deals] won follow-up failed",
        { operation: "deals.won_followup", step: "unexpected", code: errorName(e) },
        extra,
      );
      notice =
        "Deal marked won — but its follow-up reminders could not be completed. " +
        "Check the listing status and any live hold yourself, and tell an admin.";
    }
  }
  revalidateClosedDeal(dealId);
  return { error: null, savedAt: Date.now(), notice };
}

/**
 * Guarded Won flow (T3.4, doc 02 §C5): requires an accepted offer, or an
 * explicit admin override which writes its own `won_override` event; moves the
 * deal into its type's is_won stage; stamps the confirmed price (WF-2). All of
 * it — the rules, the lock, the UPDATE and the events — happens in
 * `close_deal` (0117), in one transaction. What stays here is the form, and
 * the asks a committed Won raises afterwards (raiseWonFollowUps).
 */
export async function markDealWon(
  _prev: DealSectionState,
  formData: FormData,
): Promise<DealSectionState> {
  const parsed = markWonSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const { deal_id: dealId, override, final_value: finalValue } = parsed.data;
  return closeDeal("won", {
    p_deal_id: dealId,
    p_override: override,
    ...(finalValue !== undefined ? { p_final_value: finalValue } : {}),
  });
}

/**
 * Guarded Lost flow (T3.4): a reason is mandatory and lands on the deal ROW
 * (`deals.lost_reason`, which the deal page prints). The event records the act
 * and the lost stage — not the reason, which is typed text that names people,
 * in a chain nothing can erase (SEC-03, DECISIONS T-event-typed-text-shape).
 * `close_deal` (0117) does all of it in one transaction.
 */
export async function markDealLost(
  _prev: DealSectionState,
  formData: FormData,
): Promise<DealSectionState> {
  const parsed = markLostSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const { deal_id: dealId, lost_reason: lostReason } = parsed.data;
  return closeDeal("lost", { p_deal_id: dealId, p_lost_reason: lostReason });
}

/**
 * "I spoke to the buyer" — the only signal that silences a deal_no_contact
 * nudge (migration 0025).
 *
 * Before 0025 the nudge measured silence with `last_activity_at`, which the
 * generic update path above stamps on every field change. Renaming a deal
 * therefore closed the open chase-up and logged it as contact, so a deal could
 * be edited weekly and never actually chased. Contact is now a claim someone
 * makes here, deliberately, and nowhere else.
 *
 * `last_activity_at` is bumped too: talking to the buyer is genuine activity
 * and the health score decays from it (doc 02 §C5). The two columns answer
 * different questions and both are true after this.
 */
export async function logDealContact(
  _prev: DealSectionState,
  formData: FormData,
): Promise<DealSectionState> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const parsed = logDealContactSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const { deal_id: dealId, channel, note } = parsed.data;

  const { data: deal } = await supabase
    .from("deals")
    .select("id, org_id, status")
    .eq("id", dealId)
    .maybeSingle();
  if (!deal) return { error: "Deal not found", savedAt: null };
  if (deal.status !== "open") {
    return { error: `Deal is already ${deal.status}`, savedAt: null };
  }

  const now = new Date().toISOString();
  // .select() so an RLS-filtered 0-row update surfaces instead of logging a
  // contact event for a write that never happened.
  const { data: updated, error: updateErr } = await supabase
    .from("deals")
    .update({ last_contact_at: now, last_activity_at: now })
    .eq("id", dealId)
    .select("id")
    .maybeSingle();
  if (updateErr) return { error: updateErr.message, savedAt: null };
  if (!updated) return { error: "You do not have permission to update this deal", savedAt: null };

  if (note) {
    // The words go to interaction_notes and the chain gets their digest
    // (0094, audit SEC-03): erasure can blank a row, never an event. The
    // database writes the conversation_logged event from the note's insert.
    const { error: noteErr } = await supabase.rpc("log_conversation", {
      p_entity_type: "deal",
      p_entity_id: dealId,
      p_channel: channel,
      p_note: note,
    });
    if (noteErr) return { error: noteErr.message, savedAt: null };
  } else {
    await logEvent(supabase, {
      orgId: deal.org_id,
      actorId: profile.id,
      entityType: "deal",
      entityId: dealId,
      eventType: "conversation_logged",
      payload: { channel },
    });
  }

  await recomputeDealHealth(supabase, dealId);
  revalidatePath(`/deals/${dealId}`);
  revalidatePath("/tasks");
  revalidatePath("/pipeline");
  return { error: null, savedAt: Date.now() };
}
