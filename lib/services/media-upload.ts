import * as Sentry from "@sentry/nextjs";
import type { CurrentProfile } from "@/lib/services/auth";
import { removeObjectsOrFail, type StorageLike } from "@/lib/services/storage";

/**
 * One property-media upload ATTEMPT: who may start it, the objects it writes,
 * and how it is taken back when it does not commit (DECISIONS
 * T-media-upload-authz).
 *
 * WHY THIS EXISTS. Until 2026-10-06 `uploadPropertyMedia` took an org-wide
 * property READ as permission to upload, processed the image and wrote five
 * objects with the service role, and only then let the `property_media` insert
 * — the one session-authorised write — say no. A same-organisation agent who
 * may see a listing but not add to it therefore drove privileged work on it.
 * An upload that failed part-way left its successful siblings behind;
 * `Promise.all` stopped waiting at the first thrown upload, so a slow sibling
 * could land after the action had answered; and any insert error, a lost
 * response included, deleted the objects even when the row behind that lost
 * response had committed.
 *
 * STORAGE AND POSTGRES SHARE NO TRANSACTION. Nothing here is a rollback: a
 * failed attempt is COMPENSATED by removing what it wrote, that removal is
 * verified (removeObjectsOrFail), and an unverified one is reported rather
 * than claimed. A process that dies between the uploads and the insert leaves
 * objects with no row; they are findable because every object of an attempt
 * carries the attempt's id, which is also the row id it would have had (see
 * the reconciliation note in DECISIONS T-media-upload-authz).
 */

type UploadProfile = Pick<CurrentProfile, "id" | "orgId" | "role">;

/**
 * The `property_media_insert` policy (0002, restated by 0100), said once in
 * the application: the listing is in the caller's organisation, and the caller
 * is an admin or a listing manager, or the agent the listing is assigned to.
 * Every other role (agent not assigned, the portal roles) may not.
 *
 * It is checked BEFORE anything privileged runs, so a caller the policy would
 * refuse never reaches the service role. It does not replace the policy: the
 * insert still runs on the caller's session, and RLS has the last word (a
 * reassignment between this check and the insert is refused there).
 * supabase/tests/media-upload-authz.test.ts holds this function and the
 * policy to the same answer for every role.
 */
export function mayInsertPropertyMedia(
  profile: UploadProfile,
  property: { org_id: string; assigned_agent_id: string | null },
): boolean {
  if (property.org_id !== profile.orgId) return false;
  if (profile.role === "admin" || profile.role === "listing_manager") return true;
  return profile.role === "agent" && property.assigned_agent_id === profile.id;
}

export interface AttemptObject {
  bucket: string;
  path: string;
  body: Blob;
  contentType: string;
}

export interface PutResult {
  /** every object whose upload did not answer success */
  failed: { path: string; reason: string }[];
  /** paths the store refused because an object was ALREADY there — not ours to remove */
  foreign: Set<string>;
}

const isAlreadyThere = (error: unknown): boolean => {
  const e = error as { status?: unknown; statusCode?: unknown } | null;
  return String(e?.status ?? "") === "409" || String(e?.statusCode ?? "") === "409";
};

/**
 * Upload every object of one attempt and wait for EVERY request to settle —
 * answered, refused or thrown — before returning, so nothing of this attempt
 * is still in flight when a cleanup runs. `upsert` stays at its default
 * (false): an attempt never overwrites an object that is already there.
 */
export async function putAttemptObjects(storage: StorageLike, objects: AttemptObject[]): Promise<PutResult> {
  const answers = await Promise.all(
    objects.map(async (o) => {
      try {
        const { error } = await storage
          .from(o.bucket)
          .upload(o.path, o.body, { contentType: o.contentType });
        if (!error) return null;
        return { path: o.path, reason: error.message, foreign: isAlreadyThere(error) };
      } catch (e) {
        return { path: o.path, reason: e instanceof Error ? e.message : String(e), foreign: false };
      }
    }),
  );
  const failed = answers.filter((a): a is NonNullable<typeof a> => a !== null);
  return {
    failed: failed.map(({ path, reason }) => ({ path, reason })),
    foreign: new Set(failed.filter((f) => f.foreign).map((f) => f.path)),
  };
}

/**
 * Remove every object this attempt may have written, and say whether that is
 * VERIFIED. "May have": an upload that errored or threw can still have stored
 * its object (the answer, not the write, was lost), so every attempted path is
 * removed, not only the ones that answered success; an absent object counts as
 * removed, which also makes a repeat harmless. The only paths left alone are
 * those the store refused because something was already there.
 *
 * Paths are the server's own (`properties/<id>/…<attempt id>…`), never the
 * client's, so this can only ever reach the attempt that built them.
 */
export async function discardAttemptObjects(
  storage: StorageLike,
  objects: AttemptObject[],
  foreign: Set<string>,
  context: { propertyId: string; attemptId: string; why: string },
): Promise<boolean> {
  const byBucket = new Map<string, string[]>();
  for (const o of objects) {
    if (foreign.has(o.path)) continue;
    byBucket.set(o.bucket, [...(byBucket.get(o.bucket) ?? []), o.path]);
  }
  const unverified: string[] = [];
  for (const [bucket, paths] of byBucket) {
    try {
      await removeObjectsOrFail(storage, bucket, paths);
    } catch {
      unverified.push(...paths.map((p) => `${bucket}/${p}`));
    }
  }
  if (unverified.length === 0) return true;
  reportMediaUpload("[media upload] cleanup could not be verified", "cleanup", {
    ...context,
    paths: unverified,
  });
  return false;
}

/**
 * Did a refused `property_media` insert DEFINITELY not commit?
 *
 * PostgREST answers a statement it ran and refused with a code: a SQLSTATE
 * (42501 RLS, 23xxx constraints, 57014 timeout) or a PGRST code for a request
 * it never executed. postgrest-js resolves a network failure — the request
 * may or may not have reached the database — as an error with `code: ""`
 * (measured, 2.110.2; see site-revalidate.ts), and a gateway page arrives with
 * no code at all. Only a coded error is a definite rejection; anything else
 * may sit in front of a committed row. POSTs are never retried by
 * postgrest-js, so a duplicate-key answer cannot be our own retry.
 */
export function insertDefinitelyRefused(error: { code?: string | null } | null): boolean {
  return Boolean(error?.code);
}

/**
 * Report an upload anomaly where a human is paged (the site-revalidate and
 * enquiry-alert shape): the console line for the runtime log, Sentry for the
 * alert. Opaque ids and server-built paths only — never a database or storage
 * message, which can carry a value, and never the uploader's file name.
 */
export function reportMediaUpload(
  message: string,
  operation: string,
  extra: Record<string, unknown>,
): void {
  console.error(message, JSON.stringify(extra));
  try {
    Sentry.captureMessage(message, { level: "error", tags: { operation: `media_upload.${operation}` }, extra });
  } catch {
    // Sentry is best-effort; the console line stands.
  }
}
