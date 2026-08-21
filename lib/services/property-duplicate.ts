/**
 * Spotting a property that already exists (BACKLOG audit finding 13).
 *
 * Contacts block duplicates live on `phone_e164`, which a unique index makes
 * safe. Properties have no equivalent, so the same villa entered twice yields
 * two references, two mandates and two photo sets — and BOTH burn a
 * `reference_counters` value that can never be reissued.
 *
 * WARN, NEVER BLOCK. Two genuinely different units share a building, and a
 * guard that refuses them is a guard people learn to work around. This produces
 * a link to what already exists and leaves the decision with the person.
 *
 * Pure and tested because address matching is judgement encoded as code: too
 * loose and every flat in a block is a "duplicate", too tight and it never
 * fires at all.
 */

/** Street-type words that carry no distinguishing information in Cyprus. */
const NOISE = new Set([
  "street",
  "str",
  "st",
  "avenue",
  "ave",
  "av",
  "road",
  "rd",
  "leoforos",
  "odos",
]);

/**
 * Reduce an address to what actually identifies it.
 *
 * Lowercase, strip punctuation, drop street-type words and collapse whitespace,
 * so "12, Poseidonos Avenue" and "12 poseidonos ave." are the same address —
 * which they are. The house number is KEPT and is usually the whole signal:
 * dropping it would make every address on a street match every other one.
 */
export function normaliseAddress(address: string): string {
  return address
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !NOISE.has(word))
    .join(" ")
    .trim();
}

export interface DuplicateCandidate {
  id: string;
  reference: string;
  address: string | null;
  title: { en?: string } | null;
  status: string;
}

export interface PropertyDuplicateMatch {
  id: string;
  reference: string;
  label: string;
  status: string;
}

/**
 * The first candidate whose address means the same thing.
 *
 * Exact match after normalisation, deliberately — not fuzzy. A trigram
 * similarity threshold is a number nobody can defend later ("why 0.6?"), and
 * near-misses on a street name would flag neighbours as duplicates. Normalised
 * equality is explainable in one sentence: same district, same address once
 * punctuation and street-type words are set aside.
 *
 * Candidates are expected to be pre-filtered to one district by the caller —
 * two identical addresses in different districts are different places.
 */
export function findAddressMatch(
  candidates: DuplicateCandidate[],
  address: string,
): PropertyDuplicateMatch | null {
  const target = normaliseAddress(address);
  if (target.length < 3) return null; // "12" alone is not evidence of anything

  for (const c of candidates) {
    if (!c.address) continue;
    if (normaliseAddress(c.address) !== target) continue;
    return {
      id: c.id,
      reference: c.reference,
      label: c.title?.en?.trim() || c.address,
      status: c.status,
    };
  }
  return null;
}
