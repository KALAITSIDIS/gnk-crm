import { z } from "zod";

/**
 * Turn off Zod 4's JIT validator compiler (IMPROVEMENTS C1).
 *
 * Zod 4 compiles schemas with the `Function` constructor for speed, which a
 * Content-Security-Policy without `'unsafe-eval'` forbids. Staging the CSP
 * report-only surfaced this: five screens reported
 * `script-src / blockedURI: "eval"` in a PRODUCTION build (dev hid it, because
 * `next dev` needs `'unsafe-eval'` anyway).
 *
 * Zod feature-detects and falls back on its own, so an enforced CSP would not
 * BREAK anything — it would just report a violation on every page and lose the
 * fast path silently. Since the enforced end-state is jitless regardless,
 * saying so explicitly is strictly better: deterministic, and the policy stays
 * clean enough to prove.
 *
 * The cost is negligible here — these are small form and search-param schemas,
 * not hot-loop parsing.
 */
z.config({ jitless: true });

/** Imported for the side effect above; the export just gives callers a handle. */
export const zodIsJitless = true;
