import { isAuthRetryableFetchError, type AuthRetryableFetchError } from "@supabase/supabase-js";

/**
 * A bounded retry for HARNESS auth calls — the enrol/challenge half of
 * lib/testing/mfa.ts — and the error text that goes with it.
 *
 * WHY. The RLS suite's `beforeAll` enrols five fixture users at once, seconds
 * after `supabase start` returns on a 2-vCPU runner: roughly fifteen auth
 * requests in one second against a container that has just come up. Twice one
 * of them came back 5xx and the whole suite fell in setup — `mfa.enroll: {}` on
 * 2026-09-07 (the auth log: `POST /factors → 504, context deadline exceeded,
 * 11.1s`) and `mfa.challenge: {}` on 2026-09-14 (CI run 34872951408, 832 ms
 * into the file, while the push-event twin of the same commit passed 117/117).
 * DECISIONS T-rls-mfa-transient-5xx.
 *
 * WHY `{}`. For any 5xx, auth-js builds the error's message from the Response
 * object itself: `_getErrorMessage` finds no `msg`/`message`/`error` on it and
 * falls through to `JSON.stringify`, which renders a Response as `{}`. The status
 * survives on `error.status`; the message loses it. `describeAuthError` puts it
 * back, so the next occurrence names itself.
 *
 * WHAT IS RETRIED. Exactly what auth-js labels `AuthRetryableFetchError`: a fetch
 * that failed outright (status 0) or a 500–504 / 520–530 response. That is the
 * library's own classification (auth-js `NETWORK_ERROR_CODES`), not a list
 * picked here, so it moves with the dependency. Anything else — a 4xx, a wrong
 * code, a missing session — is handed back on the first attempt.
 *
 * NOT APPLICATION CODE. The app's own MFA actions (lib/actions/mfa.ts) show the
 * person the error and let them try again; a silent retry there would hide a
 * real outage. This is for a harness that has nobody to ask.
 */

/** Waits between attempts: three retries, never more than 3.5 s of waiting per call. */
export const TRANSIENT_AUTH_BACKOFF_MS: readonly number[] = [500, 1000, 2000];

export interface RetryInfo {
  label: string;
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  /** How many retries the backoff table allows in total. */
  retries: number;
  waitMs: number;
  error: AuthRetryableFetchError;
}

export interface RetryOptions {
  backoffMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** Called before each wait. Defaults to a `console.warn` so a healed flake still shows in the log. */
  onRetry?: (info: RetryInfo) => void;
}

/** The shape every auth-js error carries; structural so a test can pass a lookalike. */
export interface AuthErrorLike {
  name?: string;
  message: string;
  status?: number;
  code?: string;
}

/**
 * `AuthRetryableFetchError status=502: {}` rather than `{}` —
 * `AuthApiError status=422 code=mfa_verification_failed: Invalid TOTP code entered`
 * rather than the message alone.
 */
export function describeAuthError(err: AuthErrorLike): string {
  const head = [err.name ?? "Error"];
  if (err.status !== undefined) head.push(`status=${err.status}`);
  if (err.code) head.push(`code=${err.code}`);
  return `${head.join(" ")}: ${err.message}`;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const announce = (info: RetryInfo) =>
  console.warn(
    `[mfa harness] ${info.label}: ${describeAuthError(info.error)} — retrying in ${info.waitMs} ms (retry ${info.attempt} of ${info.retries})`,
  );

/**
 * Run `call` and, while its `error` is what auth-js labels retryable and the
 * backoff table has a wait left, wait and run it again. The result — success or
 * the LAST error — is returned in the library's own `{ data, error }` shape, so
 * the caller's narrowing is unchanged. Each retry issues a fresh request.
 */
export async function retryTransientAuth<R extends { error: unknown }>(
  label: string,
  call: () => Promise<R>,
  opts: RetryOptions = {},
): Promise<R> {
  const backoff = opts.backoffMs ?? TRANSIENT_AUTH_BACKOFF_MS;
  const sleep = opts.sleep ?? realSleep;
  const onRetry = opts.onRetry ?? announce;

  for (let attempt = 1; ; attempt += 1) {
    const result = await call();
    const waitMs = backoff[attempt - 1];
    if (waitMs === undefined || !isAuthRetryableFetchError(result.error)) return result;
    onRetry({ label, attempt, retries: backoff.length, waitMs, error: result.error });
    await sleep(waitMs);
  }
}
