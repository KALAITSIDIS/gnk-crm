"use server";

import { revalidatePath } from "next/cache";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { certainlyRolledBack } from "@/lib/services/rpc-outcome";
import { sha256Hex } from "@/lib/services/hash";
import { renderSlipPdf } from "@/lib/services/slip-pdf";
import { slipObjectPath } from "@/lib/services/slip-paths";
import { SLIP_GDPR_LINE } from "@/lib/services/viewings";
import { binaryBody } from "@/lib/services/storage-upload";
import { createAdminClient } from "@/lib/supabase/admin";
import { rowsOf } from "@/lib/supabase/rows";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/utils/format";
import { signSlipSchema } from "@/lib/validators/viewings";

export type SlipActionState = { error: string | null; savedAt: number | null };

/**
 * Slip files older than this belong to no live attempt: the sign page bounds
 * the action at 60 s (its `maxDuration`), so anything older was stranded by an
 * attempt that died between its upload and its insert (T-signed-slip-kept).
 * Not exported — a "use server" file exports only async functions.
 */
const STRANDED_SLIP_AFTER_MS = 5 * 60_000;
/** Storage answers an `upsert: false` upload onto a taken path with 400 and statusCode "409". */
const alreadyExists = (e: unknown) => (e as { statusCode?: unknown } | null)?.statusCode === "409";
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function signViewingSlip(
  _prev: SlipActionState,
  formData: FormData,
): Promise<SlipActionState> {
  const parsed = signSlipSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: v } = await supabase
    .from("viewings")
    .select(
      `id, org_id, agent_id, scheduled_at, status,
       properties(reference, address),
       agent:profiles!agent_id(full_name)`,
    )
    .eq("id", d.viewing_id)
    .maybeSingle();
  if (!v) return { error: "Viewing not found", savedAt: null };

  // Only the viewing's agent or an admin may sign (mirrors the RLS insert
  // policy). Guarding here avoids orphaned uploads for unauthorized users.
  if (profile.role !== "admin" && v.agent_id !== profile.id) {
    return { error: "You can only sign slips for your own viewings.", savedAt: null };
  }

  // A slip is commission evidence that the viewing happened — a viewing that
  // was cancelled or a no-show must never acquire one.
  if (v.status === "cancelled" || v.status === "no_show") {
    return {
      error: `This viewing was marked ${v.status.replace("_", "-")} — a slip can only be signed for a viewing that took place.`,
      savedAt: null,
    };
  }

  // One slip per viewing (the unique key is the backstop) — asked as a LIST,
  // through `rowsOf`, by the service role whose Storage calls follow
  // (T-signed-slip-kept). Until 2026-10-13 this was a `maybeSingle` on the
  // session with its error never read: a failed read — or a hollow answer,
  // which a `maybeSingle` cannot tell from "no row" — read as "not signed",
  // and the old pre-clean below then DESTROYED the signed slip's PNG and PDF
  // (measured: every hollow shape and a plain statement timeout).
  const admin = createAdminClient();
  const slipRows = async () =>
    rowsOf(
      await admin
        .from("viewing_slips")
        .select("id, signature_sha256")
        .eq("org_id", v.org_id)
        .eq("viewing_id", d.viewing_id)
        .limit(1),
      "the signed slip",
    );
  let existing: { id: string; signature_sha256: string | null }[];
  try {
    existing = await slipRows();
  } catch (e) {
    return { error: `Could not check whether this viewing is already signed — nothing was changed: ${why(e)}`, savedAt: null };
  }
  if (existing.length > 0) return { error: "This viewing already has a signed slip.", savedAt: null };

  const png = Buffer.from(d.signature_data.replace(/^data:image\/png;base64,/, ""), "base64");
  const sha256 = sha256Hex(png);

  // The agency's name is printed on — and hashed into — the evidence PDF: a
  // read that failed must not sign a slip saying "Agency".
  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", v.org_id)
    .maybeSingle();
  if (orgErr || !org) {
    return { error: "Could not read your organisation — nothing was changed. Try again.", savedAt: null };
  }

  const property = v.properties as { reference: string; address: string | null } | null;
  const agentName = (v.agent as { full_name: string } | null)?.full_name ?? "—";
  const signedAt = new Date();

  // RENDER BEFORE ANYTHING IS STORED (integrations audit 2026-09-15, INT-08).
  // The PNG used to go up first and the PDF was rendered after it: a render or
  // upload failure left the PNG in Storage with no row, and every retry was
  // then refused by Storage ("already exists") for as long as the object
  // lived — a viewing nobody could sign until an administrator deleted the
  // file by hand. Rendering in memory first means the likeliest failure
  // happens while nothing is stored at all.
  //
  // Hashed at signing time and recorded in BOTH the row and the hash-chained
  // event (0026). The signature PNG had this and the PDF did not, so a restored
  // slip PDF could not be proven byte-identical to the one that was signed —
  // found by the 2026-08-05 Storage restore drill.
  let pdf: Buffer;
  try {
    pdf = await renderSlipPdf({
      orgName: org.name,
      agentName,
      signerName: d.signer_name,
      secondAttendeeName: d.second_attendee_name ?? null,
      propertyRef: property?.reference ?? "—",
      propertyAddress: property?.address ?? null,
      viewingWhen: formatDateTime(v.scheduled_at),
      gdprLine: SLIP_GDPR_LINE,
      signatureDataUrl: d.signature_data,
      signedAtLabel: formatDateTime(signedAt),
      sha256,
    });
  } catch (e) {
    return { error: `Could not render slip PDF: ${(e as Error).message}`, savedAt: null };
  }
  // Hash the exact bytes that go to Storage, before the upload — so the
  // recorded value describes what was sent rather than what came back.
  const pdfSha256 = sha256Hex(pdf);

  const bucket = admin.storage.from("signatures");
  const sigPath = slipObjectPath(v.org_id, d.viewing_id, "png");
  const pdfPath = slipObjectPath(v.org_id, d.viewing_id, "pdf");

  // A failure after an upload takes THIS attempt's uploads back out, so the
  // next attempt finds clean paths. Best-effort and never thrown: the error
  // being reported is the one that stopped the signing, not the tidy-up.
  const takeBack = (paths: string[]) =>
    bucket.remove(paths).then(
      () => undefined,
      () => undefined,
    );

  // NOTHING IS REMOVED BEFORE THE UPLOAD (T-signed-slip-kept). `upsert: false`
  // makes creating the PNG this attempt's claim on both paths. The pre-clean
  // that stood here (INT-08, 2026-09-15) removed whatever sat at them on the
  // word of the check above — a hollow check destroyed a signed slip, and a
  // CONCURRENT attempt's honest "not signed yet" destroyed the other's files
  // just uploaded (measured: 12 of 55 natural races, 3 of 3 forced).
  const pngUpload = await bucket.upload(sigPath, binaryBody(png, "image/png"), {
    contentType: "image/png",
    upsert: false,
  });
  if (pngUpload.error) {
    if (!alreadyExists(pngUpload.error)) return { error: pngUpload.error.message, savedAt: null };
    // Taken, while no row pointed at it a moment ago: another attempt in
    // flight, or one that died between its upload and its insert (INT-08's
    // stranded files). Only the second may be cleared — by age, never by
    // assumption — and only while the viewing is still unsigned.
    const listed = await bucket.list(v.org_id, { search: d.viewing_id, limit: 10 });
    if (listed.error || !Array.isArray(listed.data)) {
      return { error: "Could not check this viewing's slip files — nothing was changed. Try again.", savedAt: null };
    }
    const files = listed.data.filter((o) => o.name === `${d.viewing_id}.png` || o.name === `${d.viewing_id}.pdf`);
    if (files.length === 0) {
      // taken a moment ago, gone now: another attempt's files came and went
      return { error: "This viewing's slip files changed while signing — reload the page and try again.", savedAt: null };
    }
    // ANY young file means a live attempt may own the pair — the PNG of one
    // in flight beside a dead attempt's PDF is still that attempt's claim
    const live = files.some((o) => !(Date.now() - Date.parse(o.created_at ?? "") > STRANDED_SLIP_AFTER_MS));
    if (live) {
      return {
        error: "Another signing of this viewing is in progress, or one that did not finish left its files — try again in 5 minutes.",
        savedAt: null,
      };
    }
    let now: unknown[];
    try {
      now = await slipRows();
    } catch (e) {
      return { error: `Could not check whether this viewing is already signed — nothing was changed: ${why(e)}`, savedAt: null };
    }
    if (now.length > 0) return { error: "This viewing already has a signed slip.", savedAt: null };
    // By name, as Storage removes: a third attempt that claimed the path inside
    // this list-to-remove window (two round trips) would lose its PNG — a
    // residual that needs a strand, two concurrent cleaners and a signing at
    // once (BACKLOG; closing it needs per-attempt object names or a DB claim).
    const cleared = await bucket.remove(files.map((o) => `${v.org_id}/${o.name}`));
    if (cleared.error) {
      return { error: `Could not clear the files an unfinished signing left — try again in a few minutes: ${cleared.error.message}`, savedAt: null };
    }
    return {
      error: "An earlier signing that did not finish had left files behind; they have been cleared. Please sign again.",
      savedAt: null,
    };
  }

  // Under the PNG claim no live attempt writes the PDF path — but a LATE write
  // can still land there: an attempt whose PDF upload answered an error while
  // the request was in flight, and which then released its claim. So the PDF
  // is never overwritten blind (an overwrite let that late write replace a
  // later winner's PDF, measured by the T-signed-slip-kept review): a PDF
  // already there is taken out and the upload made once more, `upsert: false`
  // both times — a late writer can only ever be refused.
  const uploadPdf = () =>
    bucket.upload(pdfPath, binaryBody(pdf, "application/pdf"), { contentType: "application/pdf", upsert: false });
  let pdfUpload = await uploadPdf();
  if (pdfUpload.error && alreadyExists(pdfUpload.error)) {
    await takeBack([pdfPath]);
    pdfUpload = await uploadPdf();
  }
  if (pdfUpload.error) {
    await takeBack([sigPath]);
    return { error: pdfUpload.error.message, savedAt: null };
  }

  const geolocation =
    d.lat !== undefined && d.lng !== undefined
      ? `SRID=4326;POINT(${d.lng} ${d.lat})`
      : null;

  const ins = await supabase
    .from("viewing_slips")
    .insert({
      org_id: v.org_id,
      viewing_id: d.viewing_id,
      signer_name: d.signer_name,
      second_attendee_name: d.second_attendee_name ?? null,
      signature_path: sigPath,
      signature_sha256: sha256,
      geolocation,
      pdf_path: pdfPath,
      pdf_sha256: pdfSha256,
      created_by: profile.id,
    })
    .select("id");
  const saved = !ins.error && Array.isArray(ins.data) && ins.data.length === 1;
  if (!saved) {
    // Anything but a clean answer may have COMMITTED — a lost answer, a
    // gateway 5xx, a hollow or falsy answer, even a 23505: under this
    // attempt's PNG claim the row a unique violation meets can be this
    // attempt's OWN, its POST replayed after the first one committed
    // (T-refusal-allowlist's review). So ask before removing: a stranded file
    // is recoverable, a removed one is not.
    let after: { signature_sha256: string | null }[];
    try {
      after = await slipRows();
    } catch (e) {
      return {
        error: `Could not confirm whether the slip was saved — reload the viewing before signing again: ${why(e)}`,
        savedAt: null,
      };
    }
    if (ins.error?.code === "23505" && after[0]?.signature_sha256 !== sha256) {
      // 23505 unique_violation, and the row is not this attempt's → signed
      // between the check and this insert; the two objects are this
      // attempt's own (it holds the PNG claim)
      await takeBack([sigPath, pdfPath]);
      return { error: "This viewing already has a signed slip.", savedAt: null };
    }
    if (after.length === 0) {
      // Not committed — YET. Only a code `certainlyRolledBack` understands
      // (raised before the transaction ran, or while the statement ran) means
      // it rolled back or never ran; a code alone is not that proof — class 08
      // comes from whatever sits in front of Postgres, PGRST000 / 001 are
      // unknown (DECISIONS T-media-insert-outcome, T-refusal-allowlist). Any
      // other failure — such a code, a gateway 5xx, a reset connection, a
      // hollow or falsy answer — may still be on its way: PostgREST finishes a
      // request whose client has gone (measured by the review), and a row
      // committing after its files were taken back points at nothing. Those
      // files are left; the 5-minute stale clearing above frees them only if
      // no row ever appears (statements time out long before).
      const refused = certainlyRolledBack(ins.error?.code);
      if (refused) {
        await takeBack([sigPath, pdfPath]);
        return { error: ins.error!.message || `The slip was not saved (${ins.error!.code}).`, savedAt: null };
      }
      return {
        error: `The slip may not have been saved (HTTP ${ins.status}) — reload the viewing in a few minutes before signing again.`,
        savedAt: null,
      };
    }
    if (after[0]!.signature_sha256 !== sha256) return { error: "This viewing already has a signed slip.", savedAt: null };
    // this attempt's row committed: record it
  }

  await logEvent(supabase, {
    orgId: v.org_id,
    actorId: profile.id,
    entityType: "viewing",
    entityId: d.viewing_id,
    eventType: "viewing_slip_signed",
    // `sha256` is the signature PNG's, kept under that key so existing readers
    // and the 2026-08-05 drill's evidence checks keep working. `pdf_sha256` is
    // additive and is the one that makes the PDF provable.
    payload: {
      sha256,
      pdf_sha256: pdfSha256,
      signer_name: d.signer_name,
      // VIEW-2 (0082): the hash-chained copy is the integrity claim — a
      // column alone is forgeable (0026's principle). Absent key = none named.
      ...(d.second_attendee_name ? { second_attendee: d.second_attendee_name } : {}),
      geotagged: geolocation !== null,
    },
  });

  revalidatePath(`/viewings/${d.viewing_id}/sign`);
  revalidatePath("/viewings");
  return { error: null, savedAt: Date.now() };
}

/**
 * Short-lived signed URL for a slip PDF. The RLS-checked read of the slip
 * gates access (admin or the viewing's agent); the service role then signs the
 * private-bucket URL (doc 04: signatures served via server action only) — for
 * the object named by the ROW's ids, never the stored `pdf_path` text, which a
 * session can set to another organisation's file (see slipObjectPath). The
 * stored path still says whether a PDF was written at all.
 */
export async function getSlipDownloadUrl(
  viewingId: string,
): Promise<{ url: string | null; error: string | null }> {
  const supabase = await createClient();
  const { data: slip } = await supabase
    .from("viewing_slips")
    .select("org_id, viewing_id, pdf_path")
    .eq("viewing_id", viewingId)
    .maybeSingle();
  if (!slip?.pdf_path) return { url: null, error: "No slip found" };

  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from("signatures")
    .createSignedUrl(slipObjectPath(slip.org_id, slip.viewing_id, "pdf"), 120);
  if (error) return { url: null, error: error.message };
  return { url: data.signedUrl, error: null };
}
