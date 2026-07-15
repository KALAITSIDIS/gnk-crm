# RELEASE CHECKLIST — Phase 1

Run top-to-bottom for each production deploy. Ticks marked ✅ are automated in
CI or verified in T5.7; the **manual** ones need a human with production access.

## 1. Code gates (CI, every push)

- ✅ `npm run typecheck` clean
- ✅ `npm run lint` clean
- ✅ `npm run test` green (unit)
- ✅ `npm run test:rls` green (needs local Supabase running)
- ✅ `npm run build` succeeds (production build)

## 2. Database (hosted Supabase, project `yjgirvzgoiywdojnpkpd`, eu-central-1)

- Migrations applied and in order — check Supabase → Database → Migrations
  matches `supabase/migrations/` (0001–0006 as of Phase 1).
  Apply new ones with the Supabase CLI/connector, never by hand.
- Seed present: 5 districts, 26 deal stages, 6 `cyprus_config` rows.
- Buckets exist: `media` (public), `documents` (private), `signatures` (private).
- `pg_cron` job `expire-mandates` scheduled (daily 03:00).
- **Integrity:** `select verify_events_chain(id) from organizations;` returns
  `true` for every org.

## 3. Environment (Vercel project settings → Environment Variables)

Required (Production):

- `NEXT_PUBLIC_SUPABASE_URL` — hosted project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` — server-only; never client-exposed
- `NEXT_PUBLIC_APP_URL` — production URL
- `TZ=Asia/Nicosia`

Optional (error tracking — omit to disable; the app is a strict no-op without them):

- `SENTRY_DSN` (server/edge) · `NEXT_PUBLIC_SENTRY_DSN` (browser)

## 4. Accounts

- Production admin exists (created via Supabase dashboard per doc 07 — **no**
  seed on hosted). Confirm one `profiles` row with `role='admin'`.
- Invite the rest of the team from **Settings → Users** (hands over a one-time
  password; email invites arrive with the Phase 2 email integration).

## 5. Production smoke test (**manual**, after deploy)

Sign in as the production admin on the live URL and confirm the three critical
paths from the T5.7 acceptance:

1. **Login** — email + password → lands on the dashboard.
2. **Create property** — Properties → New → wizard → reference auto-generates
   (`GNK-<DISTRICT>-####`); the property opens; an event is logged (Activity tab).
3. **Sign slip** — create a viewing (Viewings → New), open it → Sign slip →
   draw + confirm → the slip PDF downloads and the row shows "signed".

Then spot-check: dashboard KPIs render, `/calculators` shows fees, a
`verify_events_chain` still returns `true` after the smoke data.

## 6. Post-release

- Watch Sentry (if configured) for the first hour.
- Remove any smoke-test rows if this was a clean go-live.
- Tag the release commit.

---

**Phase 1 modules shipped:** properties + media + quality score · contacts +
merge + KYC · leads + response clock · pipeline + deals + offers + health ·
won/lost · viewings (calendar, slips, feedback, routes) · mandates · keys ·
calculators · commission evidence report · dashboards · settings · tasks ·
CSV import · error/Sentry hardening.
