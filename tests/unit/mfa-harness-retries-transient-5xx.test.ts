import { AuthApiError, AuthRetryableFetchError, type SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TRANSIENT_AUTH_BACKOFF_MS,
  describeAuthError,
  retryTransientAuth,
} from "@/lib/testing/auth-retry";
import { enrolAndVerify, passChallenge } from "@/lib/testing/mfa";

/**
 * The RLS suite's `beforeAll` enrols five fixture users at once against an auth
 * container that finished starting seconds earlier. Twice now one of those
 * calls came back 5xx and the whole suite fell in setup — and the message it
 * fell with was literally `mfa.challenge: {}` (CI run 34872951408, 2026-09-14)
 * or `mfa.enroll: {}` (DECISIONS T-mfa-mandatory, 2026-09-07: a 504 after an
 * 11 s GoTrue deadline). The braces are auth-js: for any 5xx it builds the
 * message from the Response object itself, which has no `msg`/`message`, so
 * `JSON.stringify` yields `{}` and the status is gone before the harness sees it.
 *
 * Two things are pinned here. The retry wrapper retries ONLY what auth-js
 * itself labels retryable (`AuthRetryableFetchError`: a failed fetch, or
 * 500–504 / 520–530), with a bounded backoff, and hands every other error back
 * on the first attempt. And the harness is wired through it for enrol and
 * challenge but NOT for verify: a verify that times out may have been applied
 * server-side, and a wrong code is a wrong code.
 *
 * The errors are the REAL auth-js classes, not lookalikes — the classifier
 * checks a private marker as well as the name, and a hand-rolled `{ name }`
 * object would pass a test that the real thing then fails.
 */

// RFC 4226 §D secret, base32 — any valid secret will do; the fake never checks the code.
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const transient = (status: number) => new AuthRetryableFetchError("{}", status);
const wrongCode = () =>
  new AuthApiError("Invalid TOTP code entered", 422, "mfa_verification_failed");

/** A sleep that records what it was asked for and never waits. */
function fakeSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe("retryTransientAuth — retries what auth-js calls retryable, nothing else", () => {
  it.each([0, 500, 502, 503, 504])(
    "an AuthRetryableFetchError with status %s is retried once and the success is returned",
    async (status) => {
      const { waits, sleep } = fakeSleep();
      let attempts = 0;
      const result = await retryTransientAuth(
        "probe",
        async () => {
          attempts += 1;
          return attempts === 1
            ? { data: null, error: transient(status) }
            : { data: { id: "ok" }, error: null };
        },
        { sleep, onRetry: () => {} },
      );

      expect(result).toEqual({ data: { id: "ok" }, error: null });
      expect(attempts).toBe(2);
      expect(waits).toEqual([TRANSIENT_AUTH_BACKOFF_MS[0]]);
    },
  );

  it("a non-retryable auth error comes back on the first attempt, untouched", async () => {
    const { waits, sleep } = fakeSleep();
    const err = wrongCode();
    let attempts = 0;
    const result = await retryTransientAuth(
      "probe",
      async () => {
        attempts += 1;
        return { data: null, error: err };
      },
      { sleep, onRetry: () => {} },
    );

    expect(result.error).toBe(err);
    expect(attempts).toBe(1);
    expect(waits).toEqual([]);
  });

  it("gives up when the backoff table is spent and returns the LAST error", async () => {
    const { waits, sleep } = fakeSleep();
    const statuses = [502, 503, 504, 500];
    let attempts = 0;
    const result = await retryTransientAuth(
      "probe",
      async () => {
        attempts += 1;
        return { data: null, error: transient(statuses[attempts - 1]) };
      },
      { sleep, onRetry: () => {} },
    );

    expect(attempts).toBe(TRANSIENT_AUTH_BACKOFF_MS.length + 1);
    expect(result.error?.status).toBe(500);
    // The bound is the point: never more than 3.5 s of waiting per call.
    expect(waits).toEqual([...TRANSIENT_AUTH_BACKOFF_MS]);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(3500);
  });

  it("tells onRetry which attempt failed, with what, and how long it waits", async () => {
    const { sleep } = fakeSleep();
    const seen: unknown[] = [];
    let attempts = 0;
    await retryTransientAuth(
      "mfa.challenge",
      async () => {
        attempts += 1;
        return attempts === 1
          ? { data: null, error: transient(504) }
          : { data: { id: "ok" }, error: null };
      },
      { sleep, onRetry: (info) => seen.push(info) },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      label: "mfa.challenge",
      attempt: 1,
      retries: TRANSIENT_AUTH_BACKOFF_MS.length,
      waitMs: TRANSIENT_AUTH_BACKOFF_MS[0],
    });
    expect((seen[0] as { error: unknown }).error).toBeInstanceOf(AuthRetryableFetchError);
  });
});

describe("describeAuthError — the next `{}` names itself", () => {
  it("carries the status when auth-js's message is the empty braces", () => {
    const text = describeAuthError(transient(502));
    expect(text).toContain("AuthRetryableFetchError");
    expect(text).toContain("status=502");
    expect(text).toContain("{}");
  });

  it("carries the code of an API error alongside its status", () => {
    const text = describeAuthError(wrongCode());
    expect(text).toContain("status=422");
    expect(text).toContain("code=mfa_verification_failed");
    expect(text).toContain("Invalid TOTP code entered");
  });
});

/**
 * A scripted `client.auth.mfa` — each method serves its queued responses in
 * order and records the call. The fake never checks the TOTP code: what matters
 * here is WHICH challenge the verify answers, and that a retry re-issues the
 * request rather than reusing a response.
 */
type Response = { data: unknown; error: unknown };
function scriptedAuth(script: { enroll: Response[]; challenge: Response[]; verify: Response[] }) {
  const log: { method: string; args: unknown }[] = [];
  const serve = (method: keyof typeof script) => async (args: unknown) => {
    log.push({ method, args });
    const next = script[method].shift();
    if (!next) throw new Error(`scriptedAuth: no ${method} response left`);
    return next;
  };
  const client = {
    auth: {
      mfa: { enroll: serve("enroll"), challenge: serve("challenge"), verify: serve("verify") },
    },
  } as unknown as SupabaseClient;
  return { client, log, methods: () => log.map((l) => l.method) };
}

const enrolOk = (id = "factor-1"): Response => ({
  data: { id, type: "totp", friendly_name: "", totp: { qr_code: "", secret: SECRET, uri: "" } },
  error: null,
});
const challengeOk = (id: string): Response => ({
  data: { id, type: "totp", expires_at: 0 },
  error: null,
});
const verifyOk: Response = { data: {}, error: null };
const failed = (error: unknown): Response => ({ data: null, error });

describe("enrolAndVerify — wired through the retry for enrol and challenge, not verify", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Run a harness call with the real backoff on fake timers, so nothing waits. */
  async function run<T>(fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = fn();
    // Attach a handler before the timers run so a rejection is never "unhandled"
    // between the flush and the await below.
    pending.catch(() => {});
    await vi.runAllTimersAsync();
    return pending;
  }

  it("a 502 on the challenge is retried, and verify answers the SECOND challenge", async () => {
    const auth = scriptedAuth({
      enroll: [enrolOk()],
      challenge: [failed(transient(502)), challengeOk("ch-2")],
      verify: [verifyOk],
    });

    const factor = await run(() => enrolAndVerify(auth.client));

    expect(auth.methods()).toEqual(["enroll", "challenge", "challenge", "verify"]);
    expect(auth.log[3].args).toMatchObject({ factorId: "factor-1", challengeId: "ch-2" });
    expect((auth.log[3].args as { code: string }).code).toMatch(/^\d{6}$/);
    expect(factor).toEqual({ factorId: "factor-1", secret: SECRET });
  });

  it("a 503 on enrol is retried the same way", async () => {
    const auth = scriptedAuth({
      enroll: [failed(transient(503)), enrolOk("factor-2")],
      challenge: [challengeOk("ch-1")],
      verify: [verifyOk],
    });

    const factor = await run(() => enrolAndVerify(auth.client));

    expect(auth.methods()).toEqual(["enroll", "enroll", "challenge", "verify"]);
    expect(factor.factorId).toBe("factor-2");
  });

  it("the retry is announced in the log, with the status", async () => {
    const auth = scriptedAuth({
      enroll: [enrolOk()],
      challenge: [failed(transient(502)), challengeOk("ch-2")],
      verify: [verifyOk],
    });

    await run(() => enrolAndVerify(auth.client));

    const warn = vi.mocked(console.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/mfa\.challenge.*status=502.*retry/i);
  });

  it("a wrong code is NOT retried, and the throw names the status and code", async () => {
    const auth = scriptedAuth({
      enroll: [enrolOk()],
      challenge: [challengeOk("ch-1")],
      verify: [failed(wrongCode())],
    });

    await expect(run(() => enrolAndVerify(auth.client))).rejects.toThrow(
      /^mfa\.verify: AuthApiError status=422 code=mfa_verification_failed: Invalid TOTP code entered$/,
    );
    expect(auth.methods().filter((m) => m === "verify")).toHaveLength(1);
  });

  it("a 5xx on verify is NOT retried either — the server may already have applied it", async () => {
    const auth = scriptedAuth({
      enroll: [enrolOk()],
      challenge: [challengeOk("ch-1")],
      verify: [failed(transient(504))],
    });

    await expect(run(() => enrolAndVerify(auth.client))).rejects.toThrow(
      /^mfa\.verify: AuthRetryableFetchError status=504: \{\}$/,
    );
    expect(auth.methods().filter((m) => m === "verify")).toHaveLength(1);
  });

  it("a challenge that keeps failing gives up after the table, and the throw names the last status", async () => {
    const auth = scriptedAuth({
      enroll: [enrolOk()],
      challenge: [
        failed(transient(502)),
        failed(transient(502)),
        failed(transient(502)),
        failed(transient(504)),
      ],
      verify: [verifyOk],
    });

    await expect(run(() => enrolAndVerify(auth.client))).rejects.toThrow(
      /^mfa\.challenge: AuthRetryableFetchError status=504: \{\}$/,
    );
    expect(auth.methods().filter((m) => m === "challenge")).toHaveLength(
      TRANSIENT_AUTH_BACKOFF_MS.length + 1,
    );
    expect(auth.methods()).not.toContain("verify");
  });

  it("passChallenge retries its challenge the same way and answers the one that succeeded", async () => {
    const auth = scriptedAuth({
      enroll: [],
      challenge: [failed(transient(502)), challengeOk("ch-2")],
      verify: [verifyOk],
    });

    await run(() => passChallenge(auth.client, { factorId: "factor-1", secret: SECRET }));

    expect(auth.methods()).toEqual(["challenge", "challenge", "verify"]);
    expect(auth.log[2].args).toMatchObject({ factorId: "factor-1", challengeId: "ch-2" });
  });
});
