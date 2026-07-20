/**
 * Vitest stands in for the `server-only` package (vitest.config.ts alias):
 * the real module throws when imported outside a React Server Component,
 * which unit tests legitimately are. Guarding server modules against client
 * bundles remains Next's job in the real build.
 */
export {};
