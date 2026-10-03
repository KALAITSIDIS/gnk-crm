import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Storage removal that PROVES it removed.
 *
 * supabase-js reports a missing object as data, not as an error: `remove()`
 * answers with the objects it found, and an object that was never there simply
 * does not appear in the answer. Fifteen call sites across this codebase
 * awaited `remove()` and checked nothing — contact erasure among them, which
 * then wrote a compliance event saying the documents were destroyed
 * (2026-09-06 audit, A04).
 *
 * removeObjectsOrFail: every path must end up ABSENT. Objects the API says it
 * removed are done; any other path is checked with exists() — already gone
 * counts as done, because a re-run after a half-finished erasure must not
 * fail on work that succeeded the first time; still there throws, naming the
 * object.
 *
 * removeObjectsBestEffort: the same check, but a failure is logged and
 * swallowed. For cleanup after a failed insert, where the user's action has
 * already failed for a better reason and an orphaned file is the lesser evil.
 *
 * storage.test.ts forbids `storage.from(...).remove(` anywhere else under
 * lib/ and app/. The choice between the two is made at every site, by name.
 */
export type StorageLike = Pick<SupabaseClient["storage"], "from">;

export async function removeObjectsOrFail(
  storage: StorageLike,
  bucket: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) return;
  const { data, error } = await storage.from(bucket).remove(paths);
  if (error) throw new Error(`storage remove failed (${bucket}): ${error.message}`);
  const removed = new Set((data ?? []).map((o) => o.name));
  for (const path of paths) {
    if (removed.has(path)) continue;
    // Not in the answer: either never there (a re-run) or not removed. Ask.
    // storage-js (2.110.2) answers an ABSENT object `{ data: false, error:
    // <its 400 / 404> }` and THROWS on anything else — measured against the
    // local stack 2026-10-03 (T-erasure-lifecycle-guard). Until then this read
    // the attached error as "could not confirm", so every re-run after a
    // half-finished removal failed for good, and so did a row naming an object
    // that was never there.
    let answer: { data: boolean | null; error: { message: string } | null };
    try {
      answer = await storage.from(bucket).exists(path);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new Error(`storage could not confirm removal of ${bucket}/${path}: ${why}`);
    }
    if (answer.data === false) continue;
    if (answer.error) {
      throw new Error(`storage could not confirm removal of ${bucket}/${path}: ${answer.error.message}`);
    }
    if (answer.data) throw new Error(`storage object survived removal: ${bucket}/${path}`);
  }
}

export async function removeObjectsBestEffort(
  storage: StorageLike,
  bucket: string,
  paths: string[],
  context: string,
): Promise<void> {
  try {
    await removeObjectsOrFail(storage, bucket, paths);
  } catch (e) {
    console.error(`[storage] ${context}:`, e instanceof Error ? e.message : e);
  }
}
