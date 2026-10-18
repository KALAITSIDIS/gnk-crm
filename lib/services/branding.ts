import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Which branding files exist (T5.4: fixed paths in the public `media`
 * bucket — DECISIONS T5.4; org-scoped paths wait on multi-org, BACKLOG).
 *
 * ONE READER for the two pages that ask: Settings → Organization (the
 * upload form's "current" preview) and the Settings overview (A07,
 * activation readiness). Before, the organization page listed the folder
 * itself and read a failed listing as `[]` — "Not uploaded yet." under a
 * logo that was there. A failed listing is now its own answer, and each
 * page says "could not check" instead of "absent": the silent empty is the
 * reassuring direction and the wrong one.
 *
 * THE PATHS ARE THE WRITER'S. `uploadBranding` (lib/actions/settings.ts
 * BRANDING_PATHS) writes them and the photo pipeline (lib/actions/media.ts
 * WATERMARK_PATH) reads the watermark; branding.test.ts holds the three
 * spellings together.
 *
 * Service role only: the caller is an admin-gated settings page, and the
 * listing is limited to this one folder.
 */
export const BRANDING_BUCKET = "media";
export const BRANDING_FOLDER = "branding";
export const BRANDING_FILES = { logo: "logo.png", watermark: "watermark.png" } as const;
export type BrandingKind = keyof typeof BRANDING_FILES;

export type BrandingListing =
  /** each uploaded kind with its file's `updated_at` ("" when storage gave none) */
  | { ok: true; files: Partial<Record<BrandingKind, string>> }
  | { ok: false };

/**
 * What each file DOES today, in the words both settings pages print (A07).
 * The organization page's hint used to promise the logo was "used on
 * documents and reports"; nothing reads branding/logo.png but that page and
 * its upload action. The watermark is read once per upload of a PHOTO of a
 * public or partner listing (lib/actions/media.ts, shouldWatermark) — floor
 * plans never carry it, and nothing re-processes an earlier photo (BACKLOG).
 */
export const BRANDING_USE: Record<BrandingKind, string> = {
  logo: "Kept for documents — no document or report prints it yet.",
  watermark:
    "Added to photos of public and partner listings as they are uploaded; photos uploaded earlier are not re-processed.",
};

const KINDS = Object.keys(BRANDING_FILES) as BrandingKind[];

/** NEVER throws: a failure is `{ ok: false }`, logged by error name or message only. */
export async function readBrandingFiles(admin: SupabaseClient<Database>): Promise<BrandingListing> {
  try {
    const { data, error } = await admin.storage.from(BRANDING_BUCKET).list(BRANDING_FOLDER);
    if (error || !Array.isArray(data)) {
      console.warn(`[branding] listing failed: ${error?.message || "the answer held no file list"}`);
      return { ok: false };
    }
    const files: Partial<Record<BrandingKind, string>> = {};
    for (const kind of KINDS) {
      const row = data.find((f) => f?.name === BRANDING_FILES[kind]);
      if (row) files[kind] = row.updated_at ?? "";
    }
    return { ok: true, files };
  } catch (err) {
    console.warn(`[branding] listing threw: ${err instanceof Error ? err.name : "unknown"}`);
    return { ok: false };
  }
}

/** The public URL of an uploaded branding file, cache-busted by its own `updated_at`. */
export function brandingPublicUrl(admin: SupabaseClient<Database>, kind: BrandingKind, updatedAt: string): string {
  return (
    admin.storage.from(BRANDING_BUCKET).getPublicUrl(`${BRANDING_FOLDER}/${BRANDING_FILES[kind]}`).data.publicUrl +
    `?v=${encodeURIComponent(updatedAt)}`
  );
}
