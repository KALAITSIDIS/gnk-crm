import { describe, expect, it } from "vitest";
import { OFFER_TRANSITIONS, markLostSchema, markWonSchema } from "./deals";

const DEAL_ID = "0764f3fd-d72e-44f5-901f-722d9befea46";

describe("markWonSchema", () => {
  it("parses with override unchecked (absent field)", () => {
    const parsed = markWonSchema.parse({ deal_id: DEAL_ID });
    expect(parsed.override).toBe(false);
  });

  it("parses checkbox 'on' as override true", () => {
    const parsed = markWonSchema.parse({ deal_id: DEAL_ID, override: "on" });
    expect(parsed.override).toBe(true);
  });

  it("rejects a missing deal id", () => {
    expect(markWonSchema.safeParse({}).success).toBe(false);
  });
});

describe("markLostSchema", () => {
  it("requires a reason", () => {
    expect(markLostSchema.safeParse({ deal_id: DEAL_ID }).success).toBe(false);
    expect(markLostSchema.safeParse({ deal_id: DEAL_ID, lost_reason: "  " }).success).toBe(
      false,
    );
  });

  it("accepts a trimmed reason", () => {
    const parsed = markLostSchema.parse({
      deal_id: DEAL_ID,
      lost_reason: "  buyer withdrew financing  ",
    });
    expect(parsed.lost_reason).toBe("buyer withdrew financing");
  });
});

describe("OFFER_TRANSITIONS", () => {
  it("keeps decided statuses terminal", () => {
    for (const status of ["accepted", "rejected", "withdrawn", "expired"] as const) {
      expect(OFFER_TRANSITIONS[status]).toHaveLength(0);
    }
  });
});
