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

  it("parses a final value, and a blank one stays undefined for the offer default (0076)", () => {
    expect(markWonSchema.parse({ deal_id: DEAL_ID, final_value: "245000" }).final_value).toBe(
      245000,
    );
    expect(markWonSchema.parse({ deal_id: DEAL_ID, final_value: "" }).final_value).toBeUndefined();
    expect(markWonSchema.parse({ deal_id: DEAL_ID }).final_value).toBeUndefined();
  });

  it("refuses a negative final value — the DB CHECK would too, but loudly here", () => {
    expect(markWonSchema.safeParse({ deal_id: DEAL_ID, final_value: "-1" }).success).toBe(false);
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
