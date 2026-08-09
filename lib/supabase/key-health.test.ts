import { describe, expect, it, vi, beforeEach } from "vitest";

const captureException = vi.hoisted(() => vi.fn());
vi.mock("@sentry/nextjs", () => ({ captureException }));

const { assertModernSupabaseKey, __resetKeyHealthForTests } = await import("./key-health");

/**
 * The point of this guard is that it fires WITHOUT calling Supabase, so a
 * known-dead key is visible from the first request rather than only from
 * whatever symptom it happens to produce. On 2026-08-09 those symptoms were
 * "Invalid email or password", a neutral "link unavailable" page, and an
 * endless /login redirect — none of which name the cause.
 */
beforeEach(() => {
  captureException.mockClear();
  __resetKeyHealthForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const LEGACY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJhbm9uIn0.sig";

describe("assertModernSupabaseKey", () => {
  it("reports a legacy JWT key", () => {
    assertModernSupabaseKey("NEXT_PUBLIC_SUPABASE_ANON_KEY", LEGACY);
    expect(captureException).toHaveBeenCalledTimes(1);
    // The message must name the variable and the redeploy caveat, or the reader
    // fixes the Vercel value, redeploys with cache on, and sees no change.
    const msg = (captureException.mock.calls[0][0] as Error).message;
    expect(msg).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    expect(msg).toContain("build cache");
  });

  it("stays silent for modern keys", () => {
    assertModernSupabaseKey("NEXT_PUBLIC_SUPABASE_ANON_KEY", "sb_publishable_abc123");
    assertModernSupabaseKey("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_abc123");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("stays silent when the key is missing", () => {
    // supabase-js throws on construction for an absent key; that failure is
    // already loud and this must not add noise to it.
    assertModernSupabaseKey("SUPABASE_SERVICE_ROLE_KEY", undefined);
    assertModernSupabaseKey("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("reports each variable once per process, not once per request", () => {
    // These factories run on EVERY request. Sentry is an alerting sink, not a
    // log — repeating this thousands of times would bury it.
    for (let i = 0; i < 50; i++) {
      assertModernSupabaseKey("NEXT_PUBLIC_SUPABASE_ANON_KEY", LEGACY);
    }
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("tracks the two variables independently", () => {
    // The 2026-08-09 outage fixed the anon key first; the service key had to be
    // able to report on its own afterwards.
    assertModernSupabaseKey("NEXT_PUBLIC_SUPABASE_ANON_KEY", LEGACY);
    assertModernSupabaseKey("SUPABASE_SERVICE_ROLE_KEY", LEGACY);
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it("does not mistake a key that merely contains 'eyJ' for a JWT", () => {
    assertModernSupabaseKey("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_xxeyJyy.zz");
    expect(captureException).not.toHaveBeenCalled();
  });
});
