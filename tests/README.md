# `/tests` — QA audit suites

Added by the 2026-07-22 full audit (`qa/full-audit`). See `TEST_REPORT.md` for
findings and `IMPROVEMENTS.md` for the roadmap.

The repo's original unit tests stay co-located next to their source
(`lib/**/*.test.ts`) — that convention is unchanged. This directory holds the
audit's additions: the E2E harness, and unit tests written specifically to fail
loudly if a Cyprus formula or constant drifts.

```
tests/
  unit/calculators.audit.test.ts   43 tests — statutory scales, per-purchaser
                                   assessment, and config guards
  e2e/
    helpers.ts                     shared fixtures, problem watchers, module map
    auth.setup.ts                  logs in once, stores the session
    accessibility.spec.ts          every form control has an accessible name
    modules.spec.ts                all 11 modules load clean + screenshots
    security.spec.ts               anonymous access, bundle hygiene, headers
    calculators.spec.ts            on-screen figures vs the statutory scale
    happy-path.spec.ts             lead -> pipeline -> property -> task -> dashboard
    performance.spec.ts            Web Vitals + scale safeguards
  screenshots/                     22 PNGs, <module>-{desktop,mobile}.png
```

## Running

```bash
npm run test          # unit — 283 tests, no external deps
npm run test:rls      # RLS  — 25 tests, needs the local Supabase stack up
npm run test:e2e      # E2E  — 150 specs, desktop 1280px + mobile 390px
```

Useful subsets:

```bash
npm run test:e2e:desktop     # skip the mobile project
npm run test:e2e:security    # the non-destructive security suite only
npm run test:e2e:report      # open the last HTML report
```

## Prerequisites

1. **Local Supabase running** — `npx supabase start`. The E2E suite writes, so
   it must never point at hosted data.
2. **Dev server** — Playwright starts `npm run dev` itself and reuses one that
   is already on port 3000.
3. **Seed credentials** — `admin@gnk.local` / `admin1234`. Override with
   `E2E_EMAIL` / `E2E_PASSWORD`.

## Running against a deployed environment

```bash
E2E_BASE_URL=https://gnk-crm.vercel.app npx playwright test --project=desktop --no-deps tests/e2e/security.spec.ts
```

`--no-deps` is required: the `setup` project logs in with the LOCAL seed
credentials, which correctly fails against a deployed environment. The
security suite is entirely anonymous, so it needs no session and skipping the
dependency is the right call — don't "fix" this by putting production
credentials in `E2E_EMAIL` / `E2E_PASSWORD`.

The **write** specs (`happy-path`) self-skip unless the base URL is localhost —
a deliberate guard so the suite can never mutate the client's production data.
`security.spec.ts` and `modules.spec.ts` are safe against any environment
(`security.spec.ts` is entirely anonymous and read-only).

## Fixtures and cleanup

This app has **no hard delete by design**: `events` is append-only and
hash-chained, so RLS denies DELETE on every business table (docs/04). The
happy-path suite therefore tags everything it creates `qa-<base36 timestamp>`
and retires it into the app's own terminal states — lead → spam, property →
archived. Rows remain, which is correct behaviour, not a leak.

`npx supabase db reset` is the only true cleanup for the local database.

## Behaviour on a freshly reset database

`npx supabase db reset` leaves the seeded org with no leads, deals, properties
or keys. The suites are written to cope with that — but two things follow:

- **`[PERF-2] paging preserves the active filter` skips itself** with
  "seed has fewer leads than one page — nothing to page through". That
  assertion only exercises against a database with >25 leads, so don't read a
  green run on a clean DB as proof that paging preserves filters.
- Assertions about list contents must handle the empty case. Two tests
  (`[UX-3] deals are exposed as a named list`, `[PERF-2] list screens state
  their range and total`) originally assumed seeded fixtures and only passed
  because earlier runs had left data behind. Both now assert the empty state
  explicitly when the list is empty.

The RLS suite must pass on the **first** run against a fresh database, because
that is exactly what CI does (`supabase start` then `npm run test:rls`, once).
If a test only passes on a rerun it is depending on residue from the previous
run — that is a bug in the test, not a quirk.

## Known limitations

- **Drag-and-drop is not covered.** dnd-kit sensors ignore synthetic pointer
  input; the pipeline kanban needs a manual pass or a dedicated harness.
- **Radix renders a 1×1 `aria-hidden` native `<select>`** alongside each
  Select so forms submit a value. It is not in the accessibility tree —
  `accessibility.spec.ts` skips `aria-hidden` and out-of-tab-order elements
  for exactly this reason. Don't "fix" those.
- **Performance is measured locally**, not via Lighthouse on live — the heavy
  pages are behind auth and running them on production would mean handling
  production credentials.
