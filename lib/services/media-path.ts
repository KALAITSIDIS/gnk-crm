/**
 * Which storage objects a `property_media` row may name (T-media-path-bound,
 * migration 0148). Every writer — the upload action, the importer and the
 * media scripts — names its objects `properties/<property_id>/…`, so a row's
 * five path columns are trusted as "this listing's files":
 *   - `deleteMediaBulk` removes them AS THE SERVICE ROLE, from the media and
 *     documents buckets;
 *   - the property page signs a private `path_card` for the hour, for every
 *     viewer.
 * Until 0148 the columns were free text a session could write (an admin, a
 * listing manager, the assigned agent), so a planted or edited row could aim
 * either at a signed mandate PDF, a KYC scan or another listing's photograph
 * (audit 2026-10-17 MEDIA-1, RLS-3).
 *
 * THE RULE, the same as 0148's CHECK `property_media_paths_own_property`:
 *   - the path starts with `properties/<property id>/`;
 *   - it is made of the characters the writers generate — letters, digits,
 *     `.`, `_`, `-` and `/` — and nothing else;
 *   - it holds no `..`.
 * The character rule is not tidiness. The signer puts the path in a URL, and
 * a URL parser treats `%2e%2e` (any case) as `..` and `\` as `/`, so
 * `properties/<id>/%2e%2e/%2e%2e/<org>/mandates/x.pdf` passes a prefix test
 * and a `..` test and still names a mandate (media-path-bound.test.ts).
 *
 * The database refuses any other path on write; this copy is what the two
 * service-role readers test a path against before trusting it — for a row
 * written before 0148, and as defence in depth.
 */

/** `properties/`, one segment, `/`, and a name — in the allowed characters (0148's regex, verbatim). */
const PATH_SHAPE = /^properties\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/;

/** The prefix every object of a listing lives under. */
export function ownMediaPrefix(propertyId: string): string {
  return `properties/${propertyId.toLowerCase()}/`;
}

/** True when `path` names an object of THIS listing (the rule above). */
export function isOwnMediaPath(propertyId: string, path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.startsWith(ownMediaPrefix(propertyId)) &&
    PATH_SHAPE.test(path) &&
    !path.includes("..")
  );
}

/**
 * An own name that is a RENDITION, not a photograph's original: the original
 * (`properties/<id>/original/…`) is the upload as it arrived, EXIF and all,
 * kept in the private bucket and never shown. The CHECK cannot tell a
 * rendition column from an original, so a floor-plan row whose `path_card`
 * names a photo's original is valid to the database; the page's signer asks
 * this instead, and signs no original for anyone.
 */
export function isOwnRenditionPath(propertyId: string, path: unknown): path is string {
  return isOwnMediaPath(propertyId, path) && !path.startsWith(`${ownMediaPrefix(propertyId)}original/`);
}
