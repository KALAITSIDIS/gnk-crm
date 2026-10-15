import { EventWriteError } from "@/lib/services/events";
import { NOT_CONFIRMED_NOTICE, NOT_RECORDED_NOTICE } from "@/lib/services/optimistic-save";

/**
 * The words a one-time secret's action hands back WITH the secret
 * (T-one-time-secrets). Here, not in the "use server" files, which may export
 * async functions only.
 *
 * Four actions return a secret that exists nowhere else: `inviteUser` a
 * colleague's one-time password, `setPortalEnabled` (a first enable) and
 * `regeneratePortalToken` a portal's feed URL, `createShareLink` and
 * `createAvailabilityLink` a link's token. Once that secret is committed, a
 * later step that fails must not lose it — an error page shows nothing, and
 * the retry is refused (`email_exists`) or mints a second secret. So the
 * secret comes back, and one of these says what could not be confirmed.
 */

/** Did this event write certainly NOT land? (`certainlyRolledBack`, T-refusal-allowlist) */
export function eventRefused(err: unknown): boolean {
  return err instanceof EventWriteError && err.refused;
}

/**
 * The notice for a timeline line that failed after its write committed: a
 * refusal says the line could not be recorded; anything else, that it could
 * not be confirmed — it may be there.
 */
export function eventNotice(err: unknown): string {
  return eventRefused(err) ? NOT_RECORDED_NOTICE : NOT_CONFIRMED_NOTICE;
}

/** One notice from several, or null for none. */
export function joinNotices(notices: readonly string[]): string | null {
  return notices.length ? notices.join(" ") : null;
}

/**
 * The invitation's `invited` line was REFUSED and its account was deleted
 * again (confirmed), so no account exists without its line, and the e-mail
 * is free for the retry.
 */
export const INVITE_UNDONE =
  "The invitation could not be recorded in the timeline, so its account was removed again — nothing was kept. Try again.";

/**
 * The invitation's `invited` line was REFUSED, and deleting its account again
 * was NOT confirmed. Not confirmed is not "still there": auth-js answers a
 * gateway 5xx, or a connection that dropped after the request went out, as
 * AuthRetryableFetchError, and the delete may have gone through. So the
 * password is shown — the account may still work — with both outcomes said,
 * and how to tell them apart: Users lists profiles, and `profiles_id_fkey`
 * cascades, so the address is listed only while its account exists.
 */
export function undoUnconfirmedNotice(email: string): string {
  return `The invitation could not be recorded in the timeline, and removing its account again could not be confirmed, so the account may already be gone. Reload Users before handing these over: if ${email} is listed, the account works and only its timeline entry is missing; if not, these credentials will not work — invite again.`;
}

/**
 * After a refused profile insert, the orphan login's delete was not
 * confirmed. It may still exist, and then a new invitation of the same
 * address is refused as "already registered".
 */
export function accountMayRemain(email: string): string {
  return `Its sign-in account may still exist: if inviting ${email} again says it is already registered, delete that account in Supabase (Authentication → Users) first.`;
}

/**
 * The profile insert's answer was not a refusal, and reading the row back
 * did not find it (or could not ask). The account exists and its password is
 * shown; the profile may be there — or not, and then the account cannot use
 * the CRM. It will not "land yet": `inviteUser` writes the `invited` line
 * next, and once that line names this id, 0133's `profiles_id_without_history`
 * refuses (42501) a session's profile insert at it — one still in flight that
 * reaches its AFTER trigger too. So the reload this notice asks for is the
 * answer, and "delete it, then invite again" the only way back.
 */
export function profileUnconfirmedNotice(email: string): string {
  return `The account was created, but its profile could not be confirmed. Reload Users before handing these over: if ${email} is not listed, the account cannot use the CRM — delete it in Supabase (Authentication → Users), then invite again.`;
}

/**
 * A link's curation insert answered neither a success nor a refusal, and the
 * read-back did not find its rows. The link exists and is shown; what it
 * shows may be nothing.
 */
export const LINK_CONTENT_UNCONFIRMED_NOTICE =
  "The link was created, but what it shows could not be confirmed. Open it before sending it — if it is empty, revoke it under Share links and create another.";
