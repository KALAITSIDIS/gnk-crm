import { describe, expect, it } from "vitest";
import { changePasswordSchema } from "./account";

describe("changePasswordSchema (SEC-03)", () => {
  it("accepts a matching pair of adequate length", () => {
    const r = changePasswordSchema.safeParse({
      new_password: "correct horse battery",
      confirm_password: "correct horse battery",
    });
    expect(r.success).toBe(true);
  });

  it("refuses under 10 characters — the backend minimum (6) is not enough here", () => {
    const r = changePasswordSchema.safeParse({
      new_password: "short12",
      confirm_password: "short12",
    });
    expect(r.success).toBe(false);
  });

  it("refuses over 72 characters instead of letting bcrypt truncate silently", () => {
    const long = "x".repeat(73);
    const r = changePasswordSchema.safeParse({ new_password: long, confirm_password: long });
    expect(r.success).toBe(false);
    expect(r.success ? "" : r.error.issues[0].message).toContain("truncated");
  });

  it("refuses a mismatched confirmation, blaming the confirm field", () => {
    const r = changePasswordSchema.safeParse({
      new_password: "correct horse battery",
      confirm_password: "correct horse batterY",
    });
    expect(r.success).toBe(false);
    expect(r.success ? [] : r.error.issues[0].path).toEqual(["confirm_password"]);
  });
});
