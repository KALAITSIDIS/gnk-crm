/**
 * One id of each shape that reaches the app — what every id check must accept
 * (T-malformed-ids review).
 *
 * Postgres' uuid ignores the RFC 4122 version and variant bits, and so does
 * `isGuid` (z.guid(), lib/validators/ids.ts). The strict z.uuid() refuses the
 * last two below — the hosted organisation's id and every seed and fixture id
 * — which is the failure DECISIONS T3.2 forbids. A test that proves "a
 * well-formed id still goes through" with an RFC v4 id alone cannot tell the
 * two checks apart, so a call site that slipped to z.uuid() would stay green:
 * loop the good path over all of these instead.
 * lib/validators/ids.test.ts pins that each one still means what it says here.
 */
export const GUID_SHAPES = [
  // RFC 4122 v4: what gen_random_uuid() hands out
  "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c01",
  // the hosted organisation's id: version 0, which z.uuid() refuses
  "00000000-0000-0000-0000-000000000001",
  // a seed or fixture id: variant 0, which z.uuid() refuses
  "11111111-1111-1111-1111-111111111111",
] as const;
