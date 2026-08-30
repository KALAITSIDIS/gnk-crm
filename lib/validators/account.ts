import { z } from "zod";

/**
 * Self-service password change (audit SEC-03). Stricter than the Auth
 * backend's minimum on purpose: this is the only credential some accounts
 * have, and it stands in front of client PII and KYC scans. 72 bytes is
 * bcrypt's hard truncation point — accepting more would silently ignore
 * the tail of a passphrase.
 */
export const changePasswordSchema = z
  .object({
    new_password: z
      .string()
      .min(10, "Use at least 10 characters — a short passphrase beats a complex 8.")
      .max(72, "Passwords over 72 characters are truncated — use fewer."),
    confirm_password: z.string(),
  })
  .refine((d) => d.new_password === d.confirm_password, {
    message: "The two passwords do not match.",
    path: ["confirm_password"],
  });
