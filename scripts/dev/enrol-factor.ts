/**
 * Enrol a verified TOTP factor on a LOCAL account and print the secret.
 *
 *   npm run dev:2fa                      # admin@gnk.local
 *   DEV_EMAIL=agent@gnk.local DEV_PASSWORD=agent1234 npm run dev:2fa
 *
 * WHY THIS EXISTS. Since 0059 two-factor auth is mandatory, so after a
 * `supabase db reset` the seeded admin has no factor and cannot use the app
 * until one is enrolled. The product's own flow handles this perfectly well —
 * log in, get redirected to /security, scan the QR — and you should prefer it.
 * This is for the cases that flow cannot serve: you want the SECRET rather than
 * a QR (headless box, no camera, pasting into a password manager), or you want
 * it done in one command as part of resetting a machine.
 *
 * ============================================================================
 * LOCAL ONLY, AND IT REFUSES RATHER THAN TRUSTS YOU.
 *
 * This clears existing factors before enrolling — deleting a VERIFIED factor
 * revokes every session that user has — and then prints a working second factor
 * to stdout. Both are fine against 127.0.0.1 with a demo password. Against a
 * real project either would be an incident.
 *
 * So the URL is checked, not assumed: anything that is not localhost/127.0.0.1
 * exits non-zero without touching a thing. There is no --force.
 * ============================================================================
 *
 * WHY IT CLEARS FIRST. `enroll()` reveals the shared secret exactly once. Run
 * against an account that already has a factor whose secret you no longer hold
 * and you would get an unusable second factor — or, under mandatory 2FA, an
 * account nobody can sign into. Clearing makes the script idempotent: it always
 * ends with exactly one factor whose secret you are holding.
 */
import { createClient } from "@supabase/supabase-js";
import { totp } from "../../lib/testing/totp.ts";

/**
 * The three MFA calls are inline rather than imported from lib/testing/mfa.ts,
 * which has the same logic. That is not an oversight: this script runs under
 * plain `node` (TypeScript type-stripping), and Node cannot resolve the `@/`
 * path alias that module imports `totp` through — the import fails before the
 * local-only guard below even runs, which is the worst possible ordering for a
 * safety check. A relative `./totp` would not resolve either, because Node ESM
 * does no extension guessing, and `./totp.ts` needs `allowImportingTsExtensions`
 * across the whole project for one script.
 *
 * So: twelve duplicated lines, deliberately, to keep this runnable with no
 * loader and no tsconfig change. If lib/testing/mfa.ts ever drops the alias,
 * import it instead.
 */

const URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";

if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(URL)) {
  console.error(
    `refusing to run against ${URL}\n\n` +
      "This script deletes existing MFA factors (which revokes that user's sessions)\n" +
      "and prints a working second factor to stdout. That is only acceptable on a\n" +
      "local stack. Nothing was changed.",
  );
  process.exit(2);
}

/** The standard local demo keys printed by `supabase status`. Not secrets, and
 *  the guard above means they never reach anything but 127.0.0.1. */
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const SERVICE =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const EMAIL = process.env.DEV_EMAIL ?? "admin@gnk.local";
const PASSWORD = process.env.DEV_PASSWORD ?? "admin1234";

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
const user = createClient(URL, ANON, { auth: { persistSession: false } });

const { data: signIn, error: siErr } = await user.auth.signInWithPassword({
  email: EMAIL,
  password: PASSWORD,
});
if (siErr) {
  console.error(`sign-in failed for ${EMAIL}: ${siErr.message}`);
  console.error("Is the local stack up, and has supabase/seed.sql run?");
  process.exit(1);
}

const userId = signIn.user!.id;

const { data: existing, error: listErr } = await admin.auth.admin.mfa.listFactors({ userId });
if (listErr) throw new Error(`listFactors: ${listErr.message}`);
for (const f of existing?.factors ?? []) {
  const { error } = await admin.auth.admin.mfa.deleteFactor({ userId, id: f.id });
  if (error) throw new Error(`deleteFactor ${f.id}: ${error.message}`);
}
const removed = (existing?.factors ?? []).length;
if (removed) console.log(`removed ${removed} existing factor(s) — their sessions are now signed out`);

const { data: enrolled, error: enErr } = await user.auth.mfa.enroll({ factorType: "totp" });
if (enErr) throw new Error(`enroll: ${enErr.message}`);
const { data: ch, error: chErr } = await user.auth.mfa.challenge({ factorId: enrolled.id });
if (chErr) throw new Error(`challenge: ${chErr.message}`);
const { error: vErr } = await user.auth.mfa.verify({
  factorId: enrolled.id,
  challengeId: ch.id,
  code: totp(enrolled.totp.secret),
});
if (vErr) throw new Error(`verify: ${vErr.message}`);
const secret = enrolled.totp.secret;

console.log(`\nenrolled and VERIFIED for ${EMAIL}\n`);
console.log(`  secret        ${secret}`);
console.log(
  `  otpauth URI   otpauth://totp/${encodeURIComponent(EMAIL)}?secret=${secret}&issuer=gnk-crm%20local&algorithm=SHA1&digits=6&period=30`,
);
console.log(`  code now      ${totp(secret)}   (rotates every 30s)\n`);
console.log("Add it to an authenticator, then log in: password, then the 6-digit code.");
