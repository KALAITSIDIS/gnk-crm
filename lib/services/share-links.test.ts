import { describe, expect, it } from "vitest";
import { generateShareToken, hashShareToken } from "./share-links-token";
import {
  AVAILABILITY_STATUS_ORDER,
  DEFAULT_EXPIRY_DAYS,
  daysUntilExpiry,
  expiryFromNow,
  groupUnitsByPhase,
  isAvailability,
  isWellFormedShareToken,
  shareLinkPath,
  shareLinkState,
  statusSummary,
  withheldCount,
  type Availability,
  type AvailabilityUnit,
  type Proposal,
} from "./share-links";
import { PROPERTY_STATUSES } from "@/lib/validators/properties";

describe("share token", () => {
  it("is URL-safe and long enough to be unguessable", () => {
    const token = generateShareToken();
    // 32 bytes base64url = 43 chars, no padding
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // `+` and `/` would be mangled when pasted into WhatsApp
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toContain("=");
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 500 }, generateShareToken));
    expect(seen.size).toBe(500);
  });

  it("hashes deterministically, and the hash is not the token", () => {
    const token = generateShareToken();
    expect(hashShareToken(token)).toBe(hashShareToken(token));
    expect(hashShareToken(token)).toHaveLength(64);
    expect(hashShareToken(token)).not.toContain(token);
    expect(hashShareToken("a")).not.toBe(hashShareToken("b"));
  });

  /**
   * The app hashes in Node; the database looks the link up by that hash
   * (`resolve_share_link`). If the two ever disagreed, every live link would
   * silently stop resolving — so this pins the exact digest, verified to be
   * byte-identical to Postgres's
   * `encode(digest('opensesame','sha256'),'hex')`.
   */
  it("pins the SHA-256 vector Postgres also produces", () => {
    expect(hashShareToken("opensesame")).toBe(
      "d9fb92e3bbe65be1f1aad4a82eef4567f7a1ebe2cd110c8049b9698be7a70c88",
    );
  });

  it("rejects shapes we never mint, before any database round trip", () => {
    expect(isWellFormedShareToken(generateShareToken())).toBe(true);
    expect(isWellFormedShareToken("")).toBe(false);
    expect(isWellFormedShareToken("short")).toBe(false);
    expect(isWellFormedShareToken("a".repeat(44))).toBe(false);
    expect(isWellFormedShareToken("has spaces in it aaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(isWellFormedShareToken("../../etc/passwd")).toBe(false);
    expect(isWellFormedShareToken("a".repeat(42) + "+")).toBe(false);
  });
});

describe("shareLinkState", () => {
  const now = new Date("2026-07-29T12:00:00Z");

  it("is live while unexpired and unrevoked", () => {
    expect(shareLinkState({ expires_at: "2026-08-12T12:00:00Z", revoked_at: null }, now)).toBe(
      "live",
    );
  });

  it("is expired once the moment passes", () => {
    expect(shareLinkState({ expires_at: "2026-07-29T11:59:59Z", revoked_at: null }, now)).toBe(
      "expired",
    );
  });

  it("reports revoked even when also expired — the agent's action is the fact worth showing", () => {
    expect(
      shareLinkState(
        { expires_at: "2026-07-01T12:00:00Z", revoked_at: "2026-07-02T12:00:00Z" },
        now,
      ),
    ).toBe("revoked");
  });
});

describe("expiry helpers", () => {
  const now = new Date("2026-07-29T12:00:00Z");

  it("defaults to a viewing-decision cycle", () => {
    expect(DEFAULT_EXPIRY_DAYS).toBe(14);
    expect(expiryFromNow(DEFAULT_EXPIRY_DAYS, now).toISOString()).toBe("2026-08-12T12:00:00.000Z");
  });

  it("counts remaining days, never negative", () => {
    expect(daysUntilExpiry("2026-08-12T12:00:00Z", now)).toBe(14);
    expect(daysUntilExpiry("2026-07-29T13:00:00Z", now)).toBe(1);
    expect(daysUntilExpiry("2026-07-01T12:00:00Z", now)).toBe(0);
  });
});

describe("withheldCount", () => {
  const base: Proposal = {
    title: null,
    message: null,
    locale: "en",
    expires_at: "2026-08-12T12:00:00Z",
    property_count: 3,
    properties: [],
    agent: null,
    org: null,
  };

  it("reports how many curated properties are no longer shown", () => {
    // a property archived after the link was made drops out of the payload
    expect(withheldCount({ ...base, properties: [{} as never] })).toBe(2);
  });

  it("is zero when everything still resolves, and never negative", () => {
    expect(withheldCount({ ...base, properties: [{}, {}, {}] as never[] })).toBe(0);
    expect(withheldCount({ ...base, properties: [{}, {}, {}, {}] as never[] })).toBe(0);
  });
});

describe("shareLinkPath", () => {
  it("is the public route, outside the authenticated shell", () => {
    expect(shareLinkPath("abc")).toBe("/p/abc");
  });
});

/* ------------------------------------------------------------------ */
/* Availability links (migration 0041)                                  */
/* ------------------------------------------------------------------ */

function unit(over: Partial<AvailabilityUnit> = {}): AvailabilityUnit {
  return {
    reference: "PAF0002-A101",
    unit_number: "101",
    block: "A",
    floor_number: 1,
    property_type: "apartment",
    bedrooms: 2,
    bathrooms: 1,
    covered_area_sqm: 85,
    veranda_sqm: 20,
    status: "available",
    price: 255000,
    phase_reference: null,
    ...over,
  };
}

function availability(over: Partial<Availability> = {}): Availability {
  return {
    kind: "availability",
    title: null,
    message: null,
    locale: "en",
    expires_at: new Date().toISOString(),
    project: {
      reference: "PAF0002",
      kind: "project",
      title: null,
      short_description: null,
      public_description: null,
      property_type: "apartment",
      currency: "EUR",
      energy_class: null,
      features: [],
      delivery_date: null,
      construction_status: null,
      district: null,
      area: null,
    },
    phases: [],
    units: [],
    unit_count: 0,
    available_count: 0,
    unpriced_count: 0,
    price_source: "live",
    price_list: null,
    agent: null,
    org: null,
    ...over,
  };
}

describe("isAvailability", () => {
  it("discriminates on the key only the availability payload carries", () => {
    expect(isAvailability(availability())).toBe(true);
  });

  /**
   * The proposal payload has NO `kind`, on purpose: 0041 left it untouched so
   * that RLS test 25, which pins its exact key set, kept proving the old
   * exposure boundary. If a future change adds `kind` to it, this fails first.
   */
  it("treats a payload without `kind` as a proposal", () => {
    const proposal: Proposal = {
      title: null,
      message: null,
      locale: "en",
      expires_at: new Date().toISOString(),
      property_count: 0,
      properties: [],
      agent: null,
      org: null,
    };
    expect(isAvailability(proposal)).toBe(false);
    expect(Object.keys(proposal)).not.toContain("kind");
  });
});

describe("AVAILABILITY_STATUS_ORDER", () => {
  /**
   * The literal is duplicated rather than imported, to keep zod out of the
   * public page's bundle. A duplicate can drift, so this is the guard — the
   * same one `UNIT_PARENT_SELECT` carries for the same reason.
   */
  it("covers every property status except draft, which the resolver never emits", () => {
    expect([...AVAILABILITY_STATUS_ORDER].sort()).toEqual(
      PROPERTY_STATUSES.filter((s) => s !== "draft")
        .map((s) => s as string)
        .sort(),
    );
  });
});

describe("groupUnitsByPhase", () => {
  it("keeps a flat project flat", () => {
    const groups = groupUnitsByPhase(
      availability({ units: [unit(), unit({ reference: "PAF0002-A102" })] }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].phase).toBeNull();
    expect(groups[0].units).toHaveLength(2);
  });

  /**
   * THE TRAP THIS FEATURE TURNS ON. A phased project's units hang off the
   * PHASE, so the resolver walks descendants and tags each unit with its
   * phase; the page must then group them, because a phase's delivery date is
   * its own and a flat table would merge two different handovers.
   */
  it("groups by phase, direct units first, and carries each phase's own delivery date", () => {
    const groups = groupUnitsByPhase(
      availability({
        phases: [
          {
            reference: "PAF0002-P2",
            title: "Phase 2",
            status: "available",
            delivery_date: "2029-09-30",
            construction_status: "foundations",
          },
          {
            reference: "PAF0002-P1",
            title: "Phase 1",
            status: "available",
            delivery_date: "2028-03-31",
            construction_status: "structure",
          },
        ],
        units: [
          unit({ reference: "PAF0002-P2-B201", phase_reference: "PAF0002-P2" }),
          unit({ reference: "PAF0002-A101", phase_reference: null }),
          unit({ reference: "PAF0002-P1-A101", phase_reference: "PAF0002-P1" }),
          unit({
            reference: "PAF0002-P1-A102",
            phase_reference: "PAF0002-P1",
            status: "sold",
          }),
        ],
      }),
    );

    expect(groups.map((g) => g.phase?.reference ?? null)).toEqual([
      null,
      "PAF0002-P1",
      "PAF0002-P2",
    ]);
    expect(groups[1].phase?.delivery_date).toBe("2028-03-31");
    expect(groups[2].phase?.delivery_date).toBe("2029-09-30");
    // the sold unit is shown but does not count as available
    expect(groups[1].units).toHaveLength(2);
    expect(groups[1].availableCount).toBe(1);
  });

  it("omits a phase that holds no units", () => {
    const groups = groupUnitsByPhase(
      availability({
        phases: [
          {
            reference: "PAF0002-P3",
            title: "Phase 3",
            status: "draft",
            delivery_date: "2031-01-31",
            construction_status: null,
          },
        ],
        units: [unit()],
      }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].phase).toBeNull();
  });

  /** Showing units under a bare heading beats dropping them. */
  it("still shows units whose phase has no metadata in the payload", () => {
    const groups = groupUnitsByPhase(
      availability({ units: [unit({ phase_reference: "PAF0002-P9" })] }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].phase?.reference).toBe("PAF0002-P9");
    expect(groups[0].phase?.title).toBeNull();
    expect(groups[0].units).toHaveLength(1);
  });
});

describe("statusSummary", () => {
  it("counts in display order and omits statuses with no units", () => {
    expect(
      statusSummary([
        unit({ status: "sold" }),
        unit({ status: "available" }),
        unit({ status: "sold" }),
        unit({ status: "reserved" }),
      ]),
    ).toEqual([
      { status: "available", count: 1 },
      { status: "reserved", count: 1 },
      { status: "sold", count: 2 },
    ]);
  });

  it("appends a status the order does not know rather than dropping its units", () => {
    const summary = statusSummary([unit({ status: "auctioned" }), unit()]);
    expect(summary).toEqual([
      { status: "available", count: 1 },
      { status: "auctioned", count: 1 },
    ]);
    // the point: every unit is accounted for
    expect(summary.reduce((n, s) => n + s.count, 0)).toBe(2);
  });

  it("is empty for an empty matrix", () => {
    expect(statusSummary([])).toEqual([]);
  });
});
