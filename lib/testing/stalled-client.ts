import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * A REAL supabase-js client whose every request stalls: the server took the
 * connection and never answers (T-site-knock-order review, finding 2).
 *
 * Only the network is stood in for. Its fetch settles when — and only when —
 * the request's own signal aborts, and then rejects with the signal's reason,
 * which is what undici's fetch does; everything above it is the real
 * postgrest-js. So a test sees what production sees, measured against a real
 * local server that never wrote a byte (2026-10-14, supabase-js 2.110.2):
 * with no signal the read was still pending after three seconds with nothing
 * to end it; under `.abortSignal(AbortSignal.timeout(300))` it RESOLVED after
 * 313 ms as `{ data: null, status: 0, error: { message: "TimeoutError: The
 * operation was aborted due to timeout", code: "" } }`, with one request sent
 * (postgrest-js retries a failed GET, but not past an aborted signal).
 *
 * Test-only.
 */
export function stalledClient(): SupabaseClient<Database> {
  return createClient<Database>("http://127.0.0.1:9", "sb_publishable_stalled", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return; // no signal: nothing ever ends it
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    },
  });
}
