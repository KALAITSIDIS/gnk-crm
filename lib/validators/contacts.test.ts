import { describe, expect, it } from "vitest";
import {
  LEAD_CLOSED_STATUSES,
  LEAD_OPEN_STATUSES,
  SELECT_NONE,
  bankingReadinessSchema,
  contactPreferencesSchema,
  createContactSchema,
  kycStateSchema,
  leadFiltersSchema,
  leadStatusesForFilter,
} from "./contacts";

describe("leadFiltersSchema", () => {
  it("defaults to the open inbox", () => {
    expect(leadFiltersSchema.parse({}).status).toBe("open");
  });

  it("accepts scopes and concrete statuses, dropping anything else to open", () => {
    expect(leadFiltersSchema.parse({ status: "closed" }).status).toBe("closed");
    expect(leadFiltersSchema.parse({ status: "all" }).status).toBe("all");
    expect(leadFiltersSchema.parse({ status: "spam" }).status).toBe("spam");
    expect(leadFiltersSchema.parse({ status: "deleted" }).status).toBe("open");
  });
});

describe("leadStatusesForFilter", () => {
  it("maps open and closed to their status groups", () => {
    expect(leadStatusesForFilter("open")).toEqual(LEAD_OPEN_STATUSES);
    expect(leadStatusesForFilter("closed")).toEqual(LEAD_CLOSED_STATUSES);
  });

  it("returns null for all, meaning no status condition", () => {
    expect(leadStatusesForFilter("all")).toBeNull();
  });

  it("narrows to a single status when one is picked", () => {
    expect(leadStatusesForFilter("spam")).toEqual(["spam"]);
    expect(leadStatusesForFilter("converted")).toEqual(["converted"]);
  });

  it("covers every status — open and closed together are the full set", () => {
    expect([...LEAD_OPEN_STATUSES, ...LEAD_CLOSED_STATUSES].sort()).toEqual(
      ["contacted", "converted", "lost", "new", "qualified", "spam"].sort(),
    );
  });
});

describe("createContactSchema", () => {
  it("requires at least one of first/last/company name", () => {
    expect(createContactSchema.safeParse({}).success).toBe(false);
    expect(createContactSchema.safeParse({ first_name: "Maria" }).success).toBe(true);
    expect(createContactSchema.safeParse({ company_name: "GN Capital" }).success).toBe(true);
  });

  it("lowercases email and rejects invalid ones", () => {
    const ok = createContactSchema.safeParse({ first_name: "A", email: "Maria@Example.COM" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.email).toBe("maria@example.com");
    expect(
      createContactSchema.safeParse({ first_name: "A", email: "not-an-email" }).success,
    ).toBe(false);
  });

  it("strips the leading @ from telegram usernames", () => {
    const parsed = createContactSchema.safeParse({ first_name: "A", telegram_username: "@maria" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.telegram_username).toBe("maria");
  });

  it("treats the clearable-select sentinel as unset", () => {
    const parsed = createContactSchema.safeParse({
      first_name: "A",
      source: SELECT_NONE,
      psychology: SELECT_NONE,
      preferred_channel: SELECT_NONE,
      assigned_agent_id: SELECT_NONE,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.source).toBeUndefined();
      expect(parsed.data.psychology).toBeUndefined();
      expect(parsed.data.preferred_channel).toBeUndefined();
      expect(parsed.data.assigned_agent_id).toBeUndefined();
    }
  });

  it("parses checkbox booleans from form values", () => {
    const on = createContactSchema.safeParse({ first_name: "A", has_whatsapp: "on" });
    const off = createContactSchema.safeParse({ first_name: "A" });
    expect(on.success && on.data.has_whatsapp).toBe(true);
    expect(off.success && !off.data.has_whatsapp).toBe(true);
  });
});

describe("contactPreferencesSchema", () => {
  it("coerces form strings to numbers and drops empties", () => {
    const parsed = contactPreferencesSchema.safeParse({
      budget_min: "100000",
      budget_max: "",
      bedrooms_min: "2",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.budget_min).toBe(100000);
      expect(parsed.data.budget_max).toBeUndefined();
      expect(parsed.data.bedrooms_min).toBe(2);
    }
  });

  it("rejects budget min above budget max", () => {
    const parsed = contactPreferencesSchema.safeParse({
      budget_min: "500000",
      budget_max: "300000",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects negative budgets and unknown property types", () => {
    expect(contactPreferencesSchema.safeParse({ budget_min: "-5" }).success).toBe(false);
    expect(
      contactPreferencesSchema.safeParse({ property_types: ["castle"] }).success,
    ).toBe(false);
  });
});

describe("checklist schemas", () => {
  it("accepts a partial KYC state with notes and links", () => {
    const parsed = kycStateSchema.safeParse({
      passport_id: { done: true, note: "copy on file" },
      pep_declaration: { done: false, doc_link: "https://…" },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown KYC keys", () => {
    expect(kycStateSchema.safeParse({ blood_type: { done: true } }).success).toBe(false);
  });

  it("accepts banking readiness fields", () => {
    const parsed = bankingReadinessSchema.safeParse({
      nationality_risk_note: "non-EU",
      bank_pre_check_done: true,
      account_feasibility: "maybe",
    });
    expect(parsed.success).toBe(true);
    expect(bankingReadinessSchema.safeParse({ account_feasibility: "definitely" }).success).toBe(
      false,
    );
  });
});
