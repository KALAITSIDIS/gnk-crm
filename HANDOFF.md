# HANDOFF — 2026-08-08

Read `docs/HANDOVER.md` and `CLAUDE.md` first; this is the delta on top of them.
**History lives in `docs/DECISIONS.md` and git — this file is state, traps and
what to do next. Keep it short; move narrative out rather than growing it.**

**Code- and framework-level gotchas live in `docs/ENGINEERING_NOTES.md`** — the
two bugs that only exist in production, Radix/dnd-kit/next-intl traps, testing
discipline and local-stack recovery. §7 below covers *operational* traps
(Vercel, Supabase, the machine); that file covers the codebase.

| | |
|---|---|
| `main` | **in sync with `origin/main` as of 2026-08-26** — **`feat/drop-contacts-preferences` merged: migration 0055 drops `contacts.preferences`.** **DEPLOY ORDER INVERTED — code merged and deployed FIRST, then the column dropped** (see the Hosted DB row; the standing rule would have 500'd GDPR erasure). Branch deleted. Earlier the same day, **`docs/close-map-shortlist` merged: the property-map shortlist closed, and HANDOFF §0a rewritten — the backlog now has ZERO buildable items, six operator decisions and nothing else.** Earlier, as of 2026-08-25, **`feat/build-progress` merged: construction progress + delivery. NO MIGRATION.** Branch CI green before the merge; branch deleted. Earlier the same day, **`feat/pricing-breakdown` merged: owner net ↔ asking ↔ commission. NO MIGRATION.** Branch CI green before the merge; branch deleted. Earlier the same day, **`feat/quality-worklist` merged: the listing worklist. NO MIGRATION.** Branch CI green before the merge; branch deleted. Earlier the same day, **`feat/location-approx` merged: migration 0054, area centroid as a coordinate fallback.** CI green on the branch before the merge, 0054 applied to hosted before merging, branch deleted. Earlier the same day, **`feat/create-similar` merged: Create similar. NO MIGRATION.** Branch CI green before the merge; branch deleted. Earlier the same day, **`feat/sales-velocity` merged: sales velocity per project. NO MIGRATION** — the first feature in this run that needed no schema change at all, because the sale dates were already in the event log. Branch CI green before the merge; branch deleted. Earlier the same day, **`feat/key-recall` merged: migration 0053, keys follow the mandate.** CI green on the branch before the merge, 0053 applied to hosted before merging, branch deleted. Earlier the same day, **`feat/nudge-thresholds` merged: migration 0052, configurable nudge thresholds.** CI green on the branch before the merge, and 0052 applied to hosted before merging. Branch deleted local and remote. Previously, as of 2026-08-24, **`feat/installment-reminders` merged: migration 0051, instalment reminders.** CI green on the branch head `44874fc` (`checks` · `e2e` · `rls`) BEFORE the merge, and 0051 was applied to hosted before merging — the sweep is pure SQL, but `tasks.installment_id` is in the generated types the app builds against. Branch deleted local and remote. Earlier the same day, **`feat/reservation-payment-schedule` merged (`264786a`): migration 0050.** CI green for that SHA; production READY, 0 runtime errors; branch deleted. Earlier the same day, `feat/task-kinds-table` merged (`9070d23`): migration 0049.** CI green for that SHA; production READY, 0 runtime errors; branch deleted. Earlier the same day, `feat/bulk-reprice-alerts` merged (`b490c2e`): migration 0048.** **CI went RED on that SHA and was re-run green** — the `e2e` job could not bind port 54322 (`address already in use`), so the Supabase stack never started. Infrastructure, not code: identical content had passed on the branch head `b4d2288` minutes earlier. **`gh run rerun <id> --failed` is the fix**; see BACKLOG. Production READY, 0 runtime errors; branch deleted. Earlier the same day, `feat/reservation-expiry-warning` merged (`604738b`): migration 0047.** CI green for that SHA; production READY, 0 runtime errors; branch deleted. Earlier the same day, `feat/new-listing-alerts` merged (`ae0a6a2`): the second PUSH use of the matching engine, migration 0046.** CI green for that SHA; production READY, 0 runtime errors; branch deleted. Earlier the same day, `feat/price-drop-alerts` merged (`08c7b00`): the first PUSH use of the matching engine, migration 0045.** CI green on `08c7b00` for that SHA; production READY, 0 runtime errors; branch deleted. Earlier the same day, `feat/reservations` merged (`22246ad`, `--no-ff`): Phase C, reservations, migration 0044.** CI green on `22246ad` for that SHA (`checks` · `e2e` · `rls`), green on the branch head `ea79780` first; production READY, 0 runtime errors. Branch deleted local and remote. **ALL THREE PHASES OF `IMPROVEMENTS_EXECUTION.md` ARE NOW SHIPPED AND PROVEN ON PRODUCTION.** Earlier on 2026-08-23, `feat/buyer-requirements` merged (`0f0e379`, `--no-ff`, 8 commits) and PUSHED: Phase B, buyer requirements + bidirectional matching, migration 0043.** CI green on `0f0e379` for that SHA (`checks` · `e2e` · `rls`), and green on the branch head `827c406` first. Production READY from `0f0e379`, `/login` 200, `/contacts` and `/properties` 307, 0 runtime errors in a live 1h window. **0043 was applied to hosted BEFORE the merge** — the Matching buyers tab queries the new table and would have thrown against a 0042 database. Branch deleted local and remote. Earlier the same day, `fix/report-phase-a` merged (`b15066c`, `--no-ff`, 4 commits: T-A1 · T-A2 · T-A3 + the plan) and PUSHED. **CI green on `b15066c` for that SHA — `checks` · `e2e` · `rls`** — and green on the branch head `b9bc0dd` first, which is why main never risked going red: `ci.yml` is `on: push:` with no branch filter, so a branch push is a free rehearsal. Production READY from `b15066c` (`/login` 200, `/dashboard` 307, 0 runtime errors in a live 2h window). **THE "COMMIT, DON'T PUSH" AGREEMENT IS SUPERSEDED** — on 2026-08-23 the operator asked why work was left unpushed and said to navigate and decide rather than park it. Treat push-and-deploy as expected unless told otherwise. `fix/report-phase-a` was **deleted local and remote** once merged, per the standing rule that a stale branch is a claim someone will read. Phase A of `IMPROVEMENTS_EXECUTION.md` shipped; **Phases B and C are specified and NOT started.** `git branch -vv` and `git branch -r` are the answer, not this cell. |
| CI | ✅ green — `checks` (typecheck · lint · unit · **build**) + `rls` |
| Production | `gnk-crm.vercel.app` healthy; **auto-deploys every push**. **Functions run in `fra1` (Frankfurt), pinned in `vercel.json` 2026-08-20** — same region as Supabase `eu-central-1`. They ran in `iad1` (Washington DC) until then, so every request crossed the Atlantic; co-locating made all routes ~3x faster (ENGINEERING_NOTES §8). **`X-Vercel-Id` reads `<edge>::<function>` — check the SECOND field if latency ever looks structural again.** Verified 2026-08-20 after the Next 16.3.1 + region changes: 9 authenticated routes 200 with expected content, 0 runtime errors and 0 5xx in 6h of production logs. **A cache-restored build can keep an OLD `NEXT_PUBLIC_*` value compiled in — see §2b, it caused a login outage on 2026-08-09.** |
| Hosted DB | `yjgirvzgoiywdojnpkpd` — **83 migrations, latest `0083_drop_dead_sold_at` (applied 2026-09-02 AFTER the deploy — DESTRUCTIVE, the 0055/0057 order; dead column, zero readers)**. Before that: 82/0082 (applied 2026-09-02, hosted BEFORE the merge — nullable second-attendee column on the immutable slip). Before that: 81/0081 (applied 2026-09-02, hosted BEFORE the merge — the read-only share-link budget peek + the corrected retention-anchor comment)**. Before that: 80/0080 (applied 2026-09-01, hosted BEFORE the merge — two revokes bringing the last anon-executable trigger bodies into the no-execute posture; found by the restore pack's new fail-closed grants check)**. Before that: 79/0079 (applied 2026-08-31, hosted BEFORE the merge — config data only: the VAT transitional deadline is now CONDITIONAL on the building-permit date per Law 109(I)/2026 + Tax Dept announcement 2026-05-04, all figures asserted unchanged)**. Before that: 0078 (applied 2026-08-30, hosted BEFORE the merge — additive: the `profiles_role_staff_only` portal tripwire, a TWELFTH task kind `retention_expired`, and two new sweep arms — still not a ninth cron job) — the tripwire's refusal was PROVEN on a live hosted profile in a rolled-back subtransaction; `md5(replace(prosrc,chr(13),''))` of `create_followup_nudges` identical both sides (`09f1d936…`), 12 kinds, chain true, invariants green. RLS tests 53/54; DECISIONS `T-compliance-loop`. **THE 2026-08-29 AUDIT IS NOW FULLY CLOSED for buildable items** — 33 findings FIXED across 0070–0078; what remains is operator-gated (WF-4 site-live, DB-04 first co-owned mandate, DB-06 first closed rental, REL-08 rehearsal, Pro/PITR, real portfolio). Previously **77 migrations, latest `0077_dls_identity_and_schema_hygiene` (applied 2026-08-30, hosted BEFORE the merge — additive: 4 DLS columns, 13 FK covering indexes with the integrity tail NAMED as deliberately unindexed, 8 validated money CHECKs, and `contacts_email_unique` on (org_id, lower(email)) for active rows)** — the FK indexes are the CLASS decision BACKLOG's stance demanded ("the whole class is what wants a decision"), taken once with per-index read-path annotations; the CHECKs bind service_role where RLS cannot (0072's lesson); the email index closes the check-then-act race phone never had. Chain true, invariants green. RLS test 52; DECISIONS `T-property-identity`. Previously **76 migrations, latest `0076_final_value_and_report_honesty` (applied 2026-08-30, hosted BEFORE the merge — additive: a new nullable column, an ELEVENTH task kind, and four full-body function rewrites old code calls identically)** — 0076 adds `deals.final_value` (validated CHECK ≥ 0; won sums in `admin_dashboard_stats`, `report_agent_performance`, `report_source_roi` now read `coalesce(final_value, expected_value)`), gives `report_agent_performance` 0042's negative-interval guard, bounds `report_stage_conversion.advance_rate` at 1 via the intersection cohort (rebuilt on 0067's body so stage-id resolution survives), and adds the `listing_status_check` kind. `md5(replace(prosrc,chr(13),''))` identical both sides for ALL FOUR functions, 11 kinds, chain true, invariants green. RLS tests 33/38/39 extended; DECISIONS `T-close-the-books`. Previously **75 migrations, latest `0075_viewing_no_show_nudge` (applied 2026-08-30, hosted BEFORE the merge — additive: a TENTH task kind + two new arms in the existing 03:15 sweep, deliberately NOT a ninth cron job)** — 0075 makes a `no_show` viewing mint a next-day `viewing_no_show` rebooking task, superseded by a later non-cancelled viewing for the same contact+property (reason `viewing_rebooked`, stating only what the predicate proved — the 0052 lesson); never minted when the rebooking already exists. `md5(replace(prosrc,chr(13),''))` of `create_followup_nudges` identical both sides (`579ab1a0…`), 10 task kinds, chain true, invariants green. RLS test 51; DECISIONS `T-viewings-loop`. Previously **74 migrations, latest `0074_cron_health` (applied 2026-08-30, hosted BEFORE the merge — additive: nothing calls the function until the new code deploys)** — 0074 gives the 8 pg_cron jobs a witness: `cron_health()` returns per-job facts (schedule, active, last run, last SUCCESS), SECURITY DEFINER, EXECUTE service_role-only (`md5(replace(prosrc,chr(13),''))` identical both sides `ad2cd5cd…`, proacl exactly `postgres=X` + `service_role=X`); verdicts live unit-tested in `lib/services/cron-health.ts` (26h nightly / 8d weekly / 32d monthly) and render on the admin dashboard; the reports chain badge goes amber past 48h. First hosted read: 7 of 8 jobs succeeded this very morning; `ensure-events-partitions` shows **never-run — TRUE and expected**, its first monthly tick (1st @ 03:20) lands 2026-09-01, so the dashboard line is amber until then and its first success is the panel's own proof-of-life. RLS test 50; DECISIONS `T-group1-close`. Previously **73 migrations, latest `0073_feed_media` (applied 2026-08-29, hosted BEFORE the merge — additive: old code passes the function's rows through and the new `images` key simply appears; local applied via `migration up` the same evening)** — 0073 gives the public feed its photos (35th allowlisted column `images`: jsonb array, cover first, public-bucket rendition paths only — the migration greps its own compiled body to prove the private original's column is never referenced), backfills `published_at` for public rows from their visibility-change events (fallback `updated_at`), and rebuilds `public_listings_etag` around a photo fingerprint so media changes move the validator (they never touched `properties.updated_at`). DROP+CREATE in one call (return type changed, 0069 precedent); ACLs restated and asserted. RLS tests 41 + 49; DECISIONS `T-feed-media`. Previously **72 migrations, latest `0072_kyc_documents_admin_only` (applied 2026-08-29, local and hosted both — with OPPOSITE deploy orders per file: 0071 BEFORE the merge, 0072 AFTER the deploy was confirmed READY and aliased, because pre-0072 code inserts KYC docs without a visibility and the new CHECK would have refused every KYC upload in the gap — §0a trap 2, the 0055/0057 rule).** 0071 rewrites `events_insert` to require `actor_id = auth.uid()` — a staff session can no longer append events naming another user or "system"; every authenticated writer was ENUMERATED as compliant before tightening, and the null-actor writers (sweeps, DEFINER RPCs, crons) bypass RLS by role. 0072 backfills contact KYC documents to `admin_only` and adds a CHECK refusing an internal KYC row from ANY path, service_role included; its probe SKIPS with a NOTICE on an org-less fresh database. RLS tests 47/48 pin both; see DECISIONS `T-sec-audit`. **Local bookkeeping find:** local held 0065's CONTENT without its version row (hand-applied during C4, insert missed), which blocked `migration up` — row inserted, local now tracks cleanly. Previously **70 migrations, latest `0070_tax_reform_2026` (applied to hosted 2026-08-29 BEFORE the merge; local followed via `migration up` the same evening, and CI's fresh-database `rls`/`e2e` jobs prove the apply)** — 0070 records the 2026 tax reform in the two config rows it changed, in the 0056/0058 verified-rates idiom (guarded on `verified_at is null`, asserts every figure, aborts on drift): `stamp_duty` gains an `abolished` block — **Law 239(I)/2025 repealed stamp duty for documents signed on or after 2026-01-01**; the bands are KEPT because they still govern pre-2026 contracts, and the calculator renders the notice instead of a figure — and `capital_gains_tax` lifetime exemptions move €17,086/€25,629/€85,430 → **€30,000/€50,000/€150,000 (Law 242(I)/2025**, rate 20% unchanged, primary-residence tax only on the gain above €150,000). Config data only, no schema change, either deploy order safe. See DECISIONS `T-tax-2026`. **NOTE — this row had gone stale AGAIN: it read `0059` while §0a read `0067`** (second occurrence; the first, 0057 missing 0058, is recorded below). The 0060–0069 story lives in §0a and DECISIONS (`T-c5` · `T-c4` · `T-c3` · `T-mfa-mandatory` · `T-stage-ids`); this row resumes from 0070. Previously **59 migrations, latest `0059` (applied 2026-08-28, local and hosted both)** — 0059 makes 2FA **MANDATORY at the database**: the opt-in arm is gone from `mfa_satisfied()`, so any session that has not completed a second factor reads NOTHING. **Code deployed FIRST** (`7ccd604` confirmed READY and aliased before applying) — an invite landing in between would create a factor-less account blocked by RLS with no /security redirect to explain it. `md5(prosrc)` identical both sides (`cf10ce82…`), opt-in arm confirmed gone, `anon` absent from the ACL on both, chain true, `non_filename_versions` = 0. **Precondition checked BY HAND: 2 users, both with a verified factor** — the migration only REPORTS that count, because a hard abort would be false on CI's fresh seed admin and on any local database carrying deliberate factor-less fixtures. **Pre-existing ACL difference, untouched by this change:** hosted grants `service_role` EXECUTE on `mfa_satisfied`, local does not. **0058** verified `cyprus_config.vat_property` (figures were already correct; the live transitional deadline 2026-12-31 was added). **NOTE — this row had gone stale at `0057` and missed 0058 entirely**, because the 0058 work updated a different row; caught 2026-08-28. Previously **57 migrations, latest `0057` (applied 2026-08-26, local and hosted both)** — 0057 removes `top_actors30` from `admin_dashboard_stats` ("top agents by activity", dropped by operator decision, nothing replaced it). **DESTRUCTIVE, so the deploy order was inverted AGAIN** (§0a trap 2): pre-removal code does `stats.top_actors30.map(...)` and throws on `undefined`, so the code merged, `d3dac30` was confirmed READY and aliased to `gnk-crm.vercel.app`, and only then was 0057 applied. **`md5(prosrc)` identical on both sides (`d38b9da4…`) and `proacl` byte-identical**; the function returns exactly 6 keys on both; still ABSENT from the security advisor (SECURITY INVOKER, no `anon` EXECUTE). Chain true before and after; 116 events untouched; `non_filename_versions` = 0. 0056 verified `default_mandate_terms` at 3% / exclusive / 6 months. Previously **55 migrations, latest `0055` (applied 2026-08-26, local and hosted both)** — 0055 DROPS `contacts.preferences`, superseded by `buyer_requirements` (0043). **THE DEPLOY ORDER IS THE OPPOSITE OF THE RULE IN §0 FOR A DROP, and getting it wrong breaks production:** reads survive because every live query uses `select("*")`, but the live code WRITES the column in three places and an UPDATE naming a dropped column errors — `saveContact`, `mergeContacts`, and **GDPR erasure**, whose patch always sets `preferences: {}`. Dropping before the deploy would have 500'd Article 17. **Additive migration → apply before the merge. Destructive migration → deploy the code first.** The migration re-counts at apply time and HARD-ABORTS if any row still holds content, so no future database can lose a blob to it; production held 2 rows and both were `{}`. Chain true — previously 54 migrations, latest `0054` — 0054 adds `properties.location_approx` plus a CHECK that refuses the flag without a point. **It flags NOTHING on apply and cannot move a single existing number** — every row defaults to `false`, so no coordinate already entered becomes approximate and no quality score changes; the migration asserts that count is 0 rather than assuming it. That is the property that made it safe on a database with real listings. The flag exists because `location !== null` was doing double duty as "is exact" in the quality score (TWO call sites) and as the map's precision inference — storing a centroid would have quietly broken both. Chain true before and after — previously 53 migrations, latest `0053` — 0053 adds a NINTH task kind `key_recall`, `raise_key_recall_tasks(uuid, uuid)`, and **narrows two supersede predicates to `kind = 'mandate_renewal'`** — `expire_mandates()` step 3 and, in TypeScript, `supersedeRenewalTasks()`. **That narrowing is the migration.** `tasks.mandate_id` had only ever carried one kind and both places matched on the id alone, so a key_recall task — which hangs off a mandate that is by definition no longer active — was completed on sight by the cron and by the action. Proven both ways in a rolled-back probe: the pre-0053 predicate closes it, the shipped one leaves it open; RLS test 37 pins it. The raiser is service_role-only and the app reaches it through `createAdminClient()` from an already admin-gated action, because granting `authenticated` would let any signed-in user pass any mandate id to a SECURITY DEFINER writer. Chain true before and after — previously 52 migrations, latest `0052` — 0052 adds the `nudge_thresholds` config row and `nudge_threshold(text, numeric)`, and REWRITES three sweeps (`create_followup_nudges`, `warn_expiring_reservations`, `remind_due_installments`) to read it. **`create or replace` preserves the ACL, and the migration asserts that rather than assuming it** — all three still refuse `anon`, and the reader is revoked from `anon` AND `authenticated` because the app reads the config row directly instead. **The corrupt-input fallback is PROVEN in a rolled-back subtransaction**: the row is editable as raw JSON on /settings/cyprus-config, so a string, a 0, a negative and an absurd value are each written and shown to land on the shipped constant. Deleting the row restores exactly pre-0052 behaviour. Chain true before and after — previously 51 migrations, latest `0051` — 0051 adds `tasks.installment_id`, an EIGHTH task kind `installment_due`, and a SIXTH cron job `remind-due-installments @ 03:55`. **`md5(prosrc)` identical on both sides** (`7e1a8309…`), `proacl` byte-identical to `warn_expiring_reservations`, and the function is ABSENT from the security advisor — EXECUTE locked down in the migration, T-C4 applied at write time for the second running. **The eighth kind went in as a one-line INSERT, not a constraint rewrite** — 0049's whole purpose, collected. **Its mint/idempotence probe runs in a SUBTRANSACTION and is rolled back**, because the sweep writes to the hash-chained `events` table and deleting the probe's rows afterwards would either break `verify_events_chain()` or work only by the accident of those rows being last; the errcode is specific so a real failure inside the sweep still propagates. On hosted the probe SKIPPED (0 instalments) and the NOTICE says which case it hit. Chain true before and after; 115 events untouched by the apply — previously 50 migrations, latest `0050` — 0050 adds `reservation_installments` (a hold's FROZEN payment schedule) and `reservations.payment_plan_id`. `relacl` byte-identical to `reservations`, 5 policies, `rls_aal2_coverage()` = 0, absent from the advisor, `anon` INSERT on 0 of 32 RLS tables. **Its paid-coherence probe is SKIPPED on a database with no reservations — which is what CI applies migrations to — and the NOTICE says so rather than claiming a pass; RLS test 34 covers it unconditionally.** Chain true — **0049 REPLACED `tasks_kind_chk` with a `task_kinds` table + FK**, ending the four-migration run of rewriting that CHECK to add one string. **Adding a kind still needs a migration** (a kind with no sweep behind it is an orphan) but it is now a one-line INSERT, and an INSERT cannot silently drop the kinds already there — which a rewritten CHECK can, and 0046 nearly did. The refusal is PROVEN both sides: the migration attempts an unknown kind and fails if it succeeds, then proves NULL still inserts. `task_kinds` is `authenticated=r` only — not even an admin edits the vocabulary from the app — and is absent from the advisor. 31 RLS tables now; `rls_aal2_coverage()` = 0; `anon` INSERT on 0 of them. Chain true; 112 events untouched — 0048 widens `tasks_kind_chk` to a SEVENTH kind. **That is the fourth widening in four migrations and it is a pattern, not a coincidence**: every new system-task rule needs DDL purely to add a string. BACKLOG proposes a `task_kinds` lookup table — the CHECK earns its keep (0045 exists because it rejected a typo loudly) but a new rule should not need a migration. Chain true; 112 events untouched — 0047 adds `tasks.reservation_id`, a sixth `tasks.kind`, and a FIFTH cron job `warn-expiring-reservations @ 03:50`, deliberately five minutes after `expire-reservations` so a hold that lapsed overnight is already `expired` and its stale warning is superseded in the same pass. **EXECUTE was locked down IN the migration this time** — its ACL is byte-identical to `run_chain_checks`, it does NOT appear in the advisor list, and RLS test 32 asserts anon and a signed-in agent are both refused. That is T-C4's lesson applied at write time rather than after the advisor caught it. Chain true; 112 events untouched — 0045 and 0046 only widen `tasks_kind_chk`, to admit `price_drop_match` and `new_listing_match`. Both assertion blocks check that EVERY pre-existing kind survived the rewrite and that no written row was orphaned, because a rewritten CHECK is where a live value gets dropped silently. **0046's first version declared a PL/pgSQL variable named `kind`, which shadows `tasks.kind` and made its own EXISTS ambiguous — the block aborted and the constraint went in UNVERIFIED**, which is exactly the failure an assertion exists to prevent; it is named in the file. Advisor list unchanged, `expire_reservations` still absent from it. Chain true; 112 events untouched — 0045 only widens `tasks_kind_chk` to admit `price_drop_match`, and its assertion block checks that the three PRE-EXISTING kinds survived the rewrite, because a rewritten CHECK is exactly where a live value gets dropped silently. Advisor list unchanged and `expire_reservations` still absent from it, so T-C4's lockdown holds. Chain true; 112 events untouched — 0044 adds `reservations`, `relacl` byte-identical to `price_lists`, 5 policies incl. `require_aal2`, the partial unique index `reservations_one_live_per_property`, and a fourth cron job `expire-reservations @ 03:45`. **The security advisor caught a REAL hole on the apply**: `expire_reservations()` was callable by `anon` over PostgREST because a new function carries a PUBLIC `=X` grant — anyone unauthenticated could have force-expired every live hold in every org. Fixed in T-C4; its ACL now matches `create_followup_nudges` exactly and the advisor list is back to its pre-Phase-C contents. **This is why §3 ends with `get_advisors`.** Chain true before and after; 110 events untouched by the apply — 0043 adds `buyer_requirements`; its `relacl` is byte-identical to `price_lists`, 5 policies incl. `require_aal2`, 5 indexes, `rls_aal2_coverage()` = 0, `anon` INSERT on **0 of 31** RLS tables, and the security advisor list is UNCHANGED (the new table does not appear in it). Chain true before and after; 105 events untouched by the apply. Applied through `execute_sql` in separate calls and NOT `apply_migration`, which stamps a timestamp-shaped version and would have broken the `non_filename_versions` = 0 invariant. **`md5(prosrc)` of `resolve_share_link` is now `529134eb…` on BOTH sides** — before 0041 hosted's copy was 3864 chars to the file's 4280 because it carried NO `--` comments (0023 reached hosted through a comment-stripping path); strip the comments and the two matched exactly, so the drift was never functional, and 0041 closed it. A bare md5 comparison would have looked alarming and meant nothing, `non_filename_versions` = **0**, **79 events**, 3 properties, 1 mandate, 2 contacts, **30 RLS tables** — MEASURED 2026-08-22 in calls separate from the ones that applied. **`verify_events_chain` checked BEFORE and AFTER every apply**, true both sides. `rls_aal2_coverage()` returns **0** — 0039's new table got `require_aal2` explicitly, because a table created after 0029 does NOT inherit it. **`anon` can INSERT on 0 of 30 RLS tables** — 0039 accidentally gave it `arwd` (Supabase's default privileges fire at CREATE TABLE and `grant` is additive), 0040 took it back and made the ACL byte-identical to `price_lists`; see BACKLOG for the rule this produced. **0037 closed a real privilege-escalation path** on `mandates_safe`. **`cyprus_config.default_mandate_terms` (0038) is a PLACEHOLDER** — 3% / open / 6 months, `verified_at` NULL; it prefills every new mandate, so the operator should set the desk's real terms. **DB-level 2FA is LIVE** — `require_aal2` on all 30 RLS tables |
| Data | **LOCAL ONLY: a `VELO-PROJ` demo project with 18 units exists on the local database** — built 2026-08-25 to verify the velocity card against realistic data, deliberately seeding both event shapes. It is NOT on production, and its 9 events cannot be deleted without breaking the hash chain (they are scattered through the id order, and `verify_events_chain` walks by id), so it stays. Ignore `VELO-*` when counting local rows. **RE-MEASURED 2026-08-24 after 0051: 3 properties (PAF0001 `available`, PAF0002 and PAF0003 `draft`) · **2 contacts** · 0 buyer_requirements · 0 reservations · 0 payment_plans · 0 reservation_installments · **0 tasks with a `kind`** · **115 events** · chain true.** **The contact count moved 1 → 2 between two measurements the same day and the second is not mine** — same caveat as the deletions below. **0 system-raised tasks and 0 alert events EVER** is the number §0a is built on: six shipped features all read tables that are empty. **Three of those events are NOT mine and were not there this morning**: `document_deleted` ×3 at 17:46 UTC on 2026-08-24, by a USER account, removing commission-evidence PDFs for MARIOS ANDREOU. I did not touch documents. **Do not infer desk adoption from that** — §0's standing rule is that counts tell you what exists, never who created it or why; ask the operator. Everything else here remains agent- or operator-created test data. |
| Tests | **1036 unit · 81 RLS · 226 desktop E2E listed** — **MEASURED 2026-09-02 after T-wizard-enter-guard (no migration)**: `npm run test` → 1036 across 88 files (unchanged — the wave's findings were UI, page-query and test-honesty ones); `npx playwright test --list --project=desktop` → 226 across 46 files (+1 create-wizard-party.spec: Enter in the party search must not create a listing — **proven by removing the guard and watching it fail**, after a first version that could not fail because `toHaveURL` won the race against the server action). RLS unchanged at 81, re-run green. **Local-stack note:** repairing the hash chain after a bad cleanup (see DECISIONS `T-wizard-enter-guard`) suffix-deleted 60 of today's local events; `verify_events_chain` is true for all three local orgs. Previously **1036 unit · 81 RLS · 225 desktop E2E listed** — **MEASURED 2026-09-02 after T-container-review (no migration)**: `npm run test` → 1036 across 88 files (+5 `container-units.test.ts` pinning the ONE definition of a unit — a phase is not one, a unit under a phase counts for the phase and the project, rent counts as priced; +5 in quality-score.test.ts for the container's "Units priced" item, with the empty-project figure moved 85 → 75 on purpose); `npx playwright test --list --project=desktop` → 225 across 46 files (+4 create-wizard-project.spec: the floors path end to end with the price ladder verified in the DB, a building-typed development minting APARTMENT units (the critic pass — units take their type from the layout), the Floors→Villas toggle no longer aliasing a floor into the plot area, a half-filled range refused before submit; +1 unit-generator.spec "a phase is not a unit" — refused with the admin override ticked, allowed once one unit sits under the phase; the two 2026-09-02 generator tests now clean up and the override/tooltip assertions can actually fail). RLS unchanged at 81 — no table, policy or function. Previously **1026 unit · 81 RLS · 220 desktop E2E listed** — **MEASURED 2026-09-02 after T-container-aware-listings + T-wizard-project-layout (no migration)**: `npm run test` → 1026 across 87 files (+21 from the container work — the score's container branch totalling 100 with an empty project pinned at 85, the villa generator's zero-padding and floor-less rows — never measured into this row at `eaadd7b`); `npx playwright test --list --project=desktop` → 220 across 46 files (+2 in unit-generator.spec: villas, and the empty-container score + publish refusal in one test — this row first said +3, corrected by the 2026-09-02 review; +1 create-wizard-party.spec from T-search-empty-state; +2 create-wizard-project.spec: a villa development created WITH its 3 villas landing on `/units` with prices 800k/825k/850k verified in the DB, and one property still landing on its own page). The units-page generator's 7 e2e passed UNCHANGED through the shared-writer refactor — that is the proof the wizard writes the same units. RLS unchanged at 81 — no table, policy or function. Previously **1005 unit · 81 RLS · 215 desktop E2E listed** — **MEASURED 2026-09-02 after the delegated-decisions wave (T-gov1-closeout through T-drop-sold-at)**: `npm run test` → 1005; `npx playwright test --list --project=desktop` → 215 across 45 files (+reservation-convert.spec, the suite's first reservation e2e); RLS still 81, test 44 now carrying the 0081 read-only-peek pins. Previously **994 unit · 81 RLS · 214 desktop E2E listed** — **MEASURED 2026-09-01 after the post-audit review wave (T-post-audit-review through T-test-honesty)**: `npm run test` → 994 (+2 verify-restore lockstep pins, +3 party-email parity); `npx playwright test --list --project=desktop` → 214 across 44 files (+ the aal1 password-change cycle in mfa.spec, + vat-condition.spec pinning 0079's warning line). RLS count unchanged at 81, but test 51's due-date expectation is now DST-proof (date-space arithmetic matching the SQL) and the calculators copy-summary test reads the actual CLIPBOARD. Previously **989 unit · 81 RLS · 212 desktop E2E listed** — **MEASURED 2026-08-31 after 0079 (T-vat-transitional)**: `npm run test` → 989 (the +1 pins that a pre-0079 config without the transitional `condition` still renders with condition null — the mid-rollout case); `npx playwright test --list --project=desktop` → 212 across 43 files (setup project's 2 included — first re-count since 2026-08-22's 204/206). RLS unchanged at 81 — 0079 is config data, no table/policy/function. Previously **988 unit · 81 RLS across 4 files · e2e grows by 3 specs and the MFA spec RUNS AGAIN** — **T-coverage-hardening, 2026-08-30 (no migration)**: mfa.spec.ts reworked onto a dedicated user (safe in either MFA mode, never touches the shared session — BACKLOG's last outstanding item, struck), + deal-close / viewing-reschedule / entity-tasks specs for the Phase-3 surfaces nothing pinned. **Its first run caught a REAL bug: under mandatory 2FA an invited user could not enrol** — startMfaEnrollment's RLS profile read threw for every factor-less session (0059: aal1 reads nothing); fixed by authenticating from the JWT and fetching the profile only after verify() reaches aal2. Previously **988 unit · 81 RLS across 4 files** — **MEASURED 2026-08-30 after 0078 (T-compliance-loop), on a FIRST run against a FRESH database** (`npm run test` → 988 across 85 files; local was `db reset` mid-batch after residue from repeated same-day runs crowded the feed past RLS test 41's new listing — the fresh run also proves all 78 migrations apply in sequence; dev-fixtures re-applied). The +2 RLS: test 53 (all three portal roles 23514 even for service_role, row untouched) and test 54 (an expired retention duty is nudged exactly once, admin-assigned, idempotent, superseded by the purge with `retention_purged_or_changed`). Previously **988 unit · 79 RLS across 4 files** — **MEASURED 2026-08-30 after 0077 (T-property-identity)** (`npm run test` → 988 across 85 files; `npm run test:rls` → 79 with 0077 applied). The +5 unit are the DLS matcher pins: case/spacing are typist noise ("0 / 12345" matches "0/12345"), no fuzziness on a legal identifier, null registration numbers never match on empty, a too-short target is not evidence. The +1 RLS is test 52: an active case-variant email duplicate is 23505 even for service_role, archiving the holder frees the address (the merge-flow guarantee), and negative offer amounts / asking prices are 23514 at the table. Previously **983 unit · 78 RLS across 4 files** — **MEASURED 2026-08-30 after 0076 (T-close-the-books)** (`npm run test` → 983 across 85 files; `npm run test:rls` → 78 with 0076 applied — count unchanged because tests 33/38/39 were EXTENDED, not added). The +5 unit: `isStatusRegression` pins (sold/rented→market is a regression, sold↔rented is not, the restore path never is) and `markWonSchema.final_value` pins (blank stays undefined for the offer default; negatives refused). The extensions that matter: test 38 now carries a deal whose 999999 estimate must LOSE to its confirmed 250000 (the coalesce) and a backdated lead whose negative interval must not drag the 60-min average (the guard); test 39 carries a pre-window entrant whose in-window departure must NOT count as advanced, with every advance_rate asserted ≤ 1. Previously **978 unit · 78 RLS across 4 files** — **MEASURED 2026-08-30 after 0075 (T-viewings-loop)** (`npm run test` → 978 across 85 files; `npm run test:rls` → 78 with 0075 applied). The +7 unit are `viewing-ics.test.ts`: UTC-basis DTSTART/DTEND the length of the viewing, the STABLE UID that makes a reschedule replace rather than duplicate on re-import, RFC 5545 escaping (backslash first), 75-octet folding, CRLF-only line endings. The +1 RLS is test 51: a no_show viewing is nudged exactly once, due the Cyprus day after the missed slot, idempotent on a second run, superseded by a rebooking with reason `viewing_rebooked`, and NEVER minted when the rebooking already exists. Previously **971 unit · 77 RLS across 4 files** — **MEASURED 2026-08-30 after 0074 + SEC-03** (`npm run test` → 971 across 84 files; `npm run test:rls` → 77 with 0074 applied). The +10 unit are `cron-health.test.ts` — the per-schedule allowances (26h nightly / 8d weekly / 32d monthly, derived from the cron expression's shape) and that a never-succeeded job always alarms (the post-restore state) — and +4 `account.test.ts` pinning the password schema (min 10; max 72 because bcrypt truncates there silently; mismatch blames the confirm field). The +1 RLS is test 50: `cron_health()` refused to anon AND authenticated, service_role sees all 8 named jobs. Previously **957 unit · 76 RLS across 4 files** — **MEASURED 2026-08-30 after the upload/import work (no migration)** (`npm run test` → 957 across 82 files; RLS unchanged — no table, policy or function). The +6 are `client-image.test.ts`, pinning the REL-05 decision logic against MEASURED platform reality: the per-request budget must sit under the ~4.5 MB ceiling production 413s at (probed 2026-08-30: 3 MB → 200, 5/8/20 MB → 413), the 2000 px client target must exceed the 1600 px "full" rendition so nothing rendered is lost, and an oversize NON-image is never laundered into a fake JPEG by the canvas re-encode. The bulk importer (`scripts/import/media.mts`, REL-06) is proven by EXECUTION rather than unit tests: dry-run + live + idempotent re-run against local PAF0001, verified down to rows/renditions/events/score — DECISIONS `T-media-import`. Previously **951 unit · 76 RLS across 4 files** — **MEASURED 2026-08-29 after 0073** (`npm run test` → 951 across 81 files; `npm run test:rls` → 76, first run with 0073 applied). The +1 RLS is test 49: photo renditions only and finished ones only (floor plans and mid-pipeline photos withheld), the cover leads even with a later sort_order, newest-published-first actually orders the feed, a photo-less listing carries `[]` not null, and the EXIF-bearing original's path appears under NO key. The +5 unit pin the URL absolutizer — double-slash-proof, null renditions stay null, and a pre-0073 row without an images key passes through untouched (the mid-rollout case). Previously **946 unit · 75 RLS across 4 files** — **MEASURED 2026-08-29 after 0071/0072** (`npm run test` → 946 across 81 files; `npm run test:rls` → 75 on a first run against the local stack with 0070–0072 applied). The +2 RLS earn their keep: test 47 asserts a staff session CANNOT insert an event naming another actor or null — and that service-role system rows still can — and test 48 asserts an agent AND a listing manager read 0 rows for a KYC contact document while the 0072 CHECK refuses an 'internal' KYC row even from service_role. The +4 unit pin `contactDocVisibility` as the matched pair of 0072's IN-list, because TS-vs-SQL drift is the likeliest failure this feature could grow (the 0052 lesson). Previously **942 unit** — **MEASURED 2026-08-29 after 0070 + the tax fixes** (`npm run test` → 942 across 80 files; the RLS suite was NOT re-run locally — 0070 adds no table, policy or function, §0a's 73 stands and CI's `rls` job proves the fresh-database apply on the branch). The +6 are the pins that make these fixes hold: the VAT area-cliff cost must equal the EXACT under-vs-over delta at the same price (€28,736.84 at 191 m²/€300,000 — the pre-fix formula showed €45,262 and cannot pass it), a both-caps-crossed hypothetical priced at BOTH caps (€45,500), and four `parseStampDutyConfig` abolition tests, the one to keep being that a MALFORMED `abolished` block fails the WHOLE config rather than being ignored — silently dropping it would quote a repealed tax. **NOTE: this row had also gone stale (897/58 while §0a read 936/73)** — the 0060–0069 test history was never prepended here; §0a carried the honest counts. Previously **897 unit** · **58 RLS across 4 files** — **MEASURED 2026-08-26 after 0055** (`npm run test` → 897 across 77 files; `npm run test:rls` → 58). The count went DOWN by one: the preferences schema's tests went with the schema, and two new ones replaced them — that `saved_searches` is in erasure's `fields_cleared` and that `preferences` no longer is. **The first of those is the one to keep**: 0043 moved a buyer's criteria to rows and erasure was never updated to follow, so Article 17 had stopped reaching them. Previously 898 unit · 58 RLS — **MEASURED 2026-08-25 after the build card** (`npm run test` → 898 across 77 files; `npm run test:rls` → 58, unchanged — no table, policy or function). The +21 are `construction.test.ts`. The ones that matter: that `permit_granted` sits at 10 and not the 37.5% eight even stages would give it, that a NON-STANDARD status yields no stage and no bar (finding 10 preserves free text on purpose), and that a delivered project is never called overdue. Previously 877 unit · 58 RLS — **MEASURED 2026-08-25 after the pricing panel** (`npm run test` → 877 across 76 files; `npm run test:rls` → 58, unchanged — no table, policy or function). The +19 are `commission.test.ts`. The one to keep asserts that the floor is a DIVISION: `net + commission` is €500 short on a €200.000 net at 5%, and the test names that figure. Others pin that a 100% rate yields NO floor rather than Infinity, and that a null `commission_pct` (a listing manager reading `mandates_safe`) derives nothing at all. Previously 858 unit · 58 RLS — **MEASURED 2026-08-25 after the worklist** (`npm run test` → 858 across 75 files; `npm run test:rls` → 58, unchanged — no table, policy or function). The +12 are `quality-worklist.test.ts`. Two earn their keep: that ordering is by POINTS RECOVERABLE rather than count (3 × 5 points must rank below 2 × 10), and that land and non-land share the `area` KEY even though its LABEL differs — grouping by label would split one real gap into two rows that each look smaller than it is. Previously 846 unit · 58 RLS — **MEASURED 2026-08-25 after 0054** (`npm run test` → 846 across 74 files; `npm run test:rls` → 58). The +5 pin that a STORED centroid still reads as approximate, that an unflagged point stays exact, and — the one that protects every pre-0054 row — that an ABSENT flag reads as exact. RLS test 38 covers the CHECK over PostgREST. Previously 841 unit · 57 RLS — **MEASURED 2026-08-25 after Create similar** (`npm run test` → 841 across 74 files; `npm run test:rls` → 57, unchanged — no table, policy or function). The +11 are `property-seed.test.ts`: what carries, what must NOT (reference, status, coordinates, unit placement), a `numeric` that arrived as a STRING, and a legitimate ZERO that `|| ""` would have erased (a studio really does have 0 bedrooms). Previously 830 unit · 57 RLS — **MEASURED 2026-08-25 after sales velocity** (`npm run test` → 830 across 73 files; `npm run test:rls` → 57, unchanged because the feature adds no table, policy or function). The +20 are `sales-velocity.test.ts`, including the two that would catch a silent undercount: `soldAtFromEvents` reading the `updated` shape as well as `status_changed`, and `monthKey` bucketing a late-UTC instant into the correct CYPRUS month. Previously 810 unit · 57 RLS — **MEASURED 2026-08-25 after 0053** (`npm run test` → 810 across 72 files; `npm run test:rls` → 57). RLS test 37 is the one to keep: it asserts a key_recall task SURVIVES a full `expire_mandates()` run, which is the regression that would otherwise return the moment someone re-tidies that predicate. Previously 807 unit · 56 RLS — **MEASURED 2026-08-25 after 0052** (`npm run test` → 807 across 72 files; `npm run test:rls` → 56). The +13 unit tests are `nudge-thresholds.test.ts`, which runs the SAME fallback table against the TypeScript reader that 0052's assertion block runs against the SQL one — the two are a matched pair and drift between them is the failure mode this feature could most easily introduce. RLS test 36 covers the other half: an agent may READ the thresholds (the Log contact dialog states the number) but not write them, the reader is not callable over PostgREST, the sweeps actually follow a changed value, and a threshold change is logged as `threshold_changed` rather than falsely as `deal_contacted`. Previously 794 unit · 55 RLS — **MEASURED 2026-08-24 after 0051** (`npm run test` → 794 across 71 files; `npm run test:rls` → 55, RLS test 35 included, and CI's `rls` job proves the fresh-database run independently). The +6 unit tests pin the instalment renderer: the SIGN of `days` picks due-soon vs overdue, `=0` renders “today” rather than “in 0 days”, an unparseable count must not render `NaN`, and — the real regression risk — `reservation_no_longer_live` is disambiguated by `kind` because 0047 and 0051 BOTH write it. Previously 788 unit · 54 RLS · **204 desktop E2E** — **unit and RLS MEASURED 2026-08-23 after Phase B** (`npm run test` → 788 across 71 files; `npm run test:rls` → **54**, RLS tests 30–34 included, passing on a FIRST run against a fresh DB, and CI's `rls` job proves the fresh-database run independently). **The 204 desktop E2E figure is still the 2026-08-22 measurement and was NOT re-counted today** — Phase A added no spec, and CI’s `e2e` job passed on `b15066c`, but that is not the same as re-running `playwright test --project=desktop --list` (which reports 206 because the `setup` project’s two tests come with it). The previous line said 518 / 48 / 181 and was dated 2026-08-11 and 2026-08-20; the unit count had drifted by 173 across work that never updated it, which is why these carry the command that produced them. Migration 0041 added RLS test 29 and `tests/e2e/availability-share.spec.ts` (3 tests). The full desktop suite was NOT re-run for 0041 — only the new spec was, so the 12 tracked `tests/screenshots/*.png` are untouched (§7). All three suites run in CI |
| Cron | **EIGHT jobs** (was listed as six here until 2026-08-31 — this row had gone stale): `expire-mandates 03:00` · `followup-nudges 03:15` · `ensure-events-partitions 03:20 (1st of month)` · `verify-events-chain 03:30` · `verify-events-chain-full 03:35 (Sun)` · `expire-reservations 03:45` · `warn-expiring-reservations 03:50` · `remind-due-installments 03:55` — authoritative table in docs/10; `cron_health()` (0074) watches them on the admin dashboard — **the last three are ordered on purpose**: a hold that lapses overnight is `expired` by 03:45, so both its expiry warning and its instalment reminders supersede in the same night rather than surviving until tomorrow and chasing a buyer who has walked away |
| Backups | ✅ **The off-machine copy is ATTESTED nightly since 2026-09-02** — offsite-github.mjs ships the dated archive to the private `gnk-backups-offsite` repo, re-downloads it from GitHub and hash-compares (proven both interactively and in scheduler context; arms fully when the operator adds `GH_TOKEN`, item 1b). ✅ **THE CLOUD RESTORE PATH IS PROVEN END TO END (2026-08-31, audit REL-08 — BACKUP_RESTORE §4e, DECISIONS `T-cloud-restore-drill`).** The `2026-08-31` set was restored into a real scratch cloud project over the wire (schema 73 s / 0 errors, data 12 s / 2 benign), the restored chain's hash aggregate came back **byte-identical to live production over 130 events**, and after the §4e remedy recipe (ledger + 8 cron jobs + corrected grant lockdown) `verify-restore.sql` failed the scratch on EXACTLY the same 11 rows as live production — converged. Two §3.1 recipe corrections and the pack's stale baseline were found and fixed the same day; the scratch was deleted within the hour. Remaining composition gaps are human by nature: auth.users recreation, storage bytes (§4c), the Vercel env swap. Previously: ✅ **OFF-SITE IS AUTOMATED AND NO LONGER SINGLE-MACHINE (2026-08-29, audit REL-01/REL-02 — DECISIONS `T-offsite`, BACKUP_RESTORE §3.0/§3.3).** Every nightly now ends with `offsite.mjs` (dated whole-folder archive → `C:\Users\user\OneDrive\gnk-backups-offsite\`, **re-hashed at the destination**, newest 7 kept — OneDrive trade-off accepted with the mitigations §3.3 records; USB stays the offline leg) and `notify.mjs` (healthchecks dead-man ping — **ARMED 2026-08-30**: check `gnk-crm nightly backup`, Period 1 day / Grace 2h / email ON, full new→up→down→up cycle proven with real pings incl. the /fail alert email). The task itself went **S4U + StartWhenAvailable + WakeToRun + runs-on-battery** — it had been "Interactive only" and the 2026-08-29 03:45 run was SILENTLY SKIPPED with nobody logged in; proven fixed by a real scheduler-context run the same evening (exit=0, full chain). **The same evening's first capture also caught a real regression: 0063's partitioning had silently emptied the dump's events** — `--schema public` never sees the `events_parts` partitions, the verify refused to promote ("missing COPY public.events", count 0 vs 122), and `capture.mjs` now dumps `public,events_parts` in both schema and data passes and counts events ACROSS partition COPY blocks (122 across 15 partitions = live 122 on the fixed run). Had the nightly not been silently skipped that morning, it would have been the first RED night — the two audit findings and the regression were one story. `2026-08-29` is the new primary set (50 files, verified, the first partition-aware one); the historical 18-set archive is preserved off-machine as `gnk-backups-historical-2026-08-23.tar.gz` (renamed OUT of the retention pattern; not a strict subset — never delete it by the subset ritual). Previously: ✅ **`2026-08-23` is the primary** — newest automated set, `verified:true`, `problems:[]`, 55 files, **events inDump 105 = live 105**, in `D:\dev\TSOPOZIDIS\gnk-backups`. **`2026-08-28` IS THE FIRST SELF-CONTAINED SET** — produced by the 03:45 unattended nightly with the `CREATE EXTENSION` preamble the capture script now writes (`546668b`); `exit=0`, 52/52 SHA256SUMS OK, `verified: true`, `problems: []`, events 116 = 116. It restores into a fresh database with NO manual step; every earlier set still needs §3.1 by hand. **`2026-08-27` is the newest restore-PROVEN set (drill 2026-08-26, BACKUP_RESTORE §4d): 26/26 tables match its own JSON exports and the `events` hash-aggregate `88a742c4…`/116 rows is IDENTICAL to live production.** `2026-08-06` was the previously proven one (all 73 event hashes byte-identical to production). **§4b.1 IS NOW FIXED (2026-08-26): `capture.mjs` writes a `CREATE EXTENSION IF NOT EXISTS` preamble into `pg_dump.sql` and REFUSES to promote a set that lacks one, or that uses an extension the preamble misses.** Proven both ways — a produced dump restores into a bare database with **0 errors** and all four geography tables present, and a sabotaged run (postgis removed) was refused and left the destination untouched. **BUT EVERY SET THAT ALREADY EXISTS — on disk and on the USB — PREDATES THE FIX** and still needs §3.1's manual `create extension` step; check with `grep -c 'gnk: extension preamble' <set>/pg_dump.sql`. Storage bytes and `pg_cron` jobs remain uncovered by any drill. **18 sets, nightly running unbroken since 08-06** — measured 2026-08-23, the 03:46 run that morning was green. **STILL SINGLE-MACHINE. A fresh off-site archive `gnk-backups-offsite-2026-08-23.tar.gz` is built and verified twice and is waiting to be copied to USB, §3.3** — the 08-10 one it replaces was never copied either, which is the point: an uncopied archive ages, so this closes nothing until it moves off the box |

---

## 0a. NEXT UP — the CRM is finished for Phase 1; what is left is data and four decisions (2026-08-28)

**State:** current migration, test and deploy state live in the §0 table
above — ONLY there (this line carried its own copy of those numbers and went
stale twice, last caught 2026-09-01 at nine migrations behind; a second copy
of a count is a second thing to forget). An outside-style audit ran 2026-08-29 against the code
(45 findings, all verified; report held by the operator) — its headline items
were the 0070 rate corrections and the VAT area-cliff formula, fixed the same
day. Previously: `main` at `6bfd5f7`+, tree clean, local and hosted both at
**0067**, **936 unit / 73 RLS / 209 E2E**, CI green, production READY.

**TWO PHASE-C FOLLOW-ONS CLOSED (2026-08-29). One changed a working
agreement, so read it before touching the docs:**

1. **`docs/03_DATABASE_SCHEMA.sql` is no longer "authoritative", and the
   sync-it rule is GONE** — removed from `CLAUDE.md`, `README.md` and doc 08
   T0.3. The rule held to migration 0023 and then lapsed silently: measured
   2026-08-29, the file was missing `admin_dashboard_stats` (0018),
   `mfa_satisfied` (0029), `buyer_requirements` (0043), `reservations` (0044),
   `task_kinds` (0049), `reservation_installments` (0050), `location_approx`
   (0054) and all of Phase C — while still calling itself the authoritative
   DDL. **Do not sync schema changes into it.** `supabase/migrations/` is the
   authority; the file keeps its design commentary, which is its real value.
2. **`stage_changed` records stage IDS as well as names (0067)**, so renaming
   a pipeline stage no longer splits its history in
   `report_stage_conversion`. Additive: names stay (the timeline renderer
   reads them, RLS test 15 asserts `payload.to`), pre-0067 events behave
   exactly as before, and the report now returns `moves_with_ids` against
   `moves_total` so the coverage is visible rather than assumed.

**PHASE C IS DONE except C7, which stays gated.** C5 → C4 → C3 all built,
applied to hosted, merged and deployed. C7 needs a real second-office or
franchise requirement and there is still one office and two admins.

**C3 IS COMPLETE (2026-08-29)** — migration 0066 and
`GET /api/public/listings?org=<slug>`. ~~It exposes nothing today~~ **STALE
SAME-DAY: the operator published PAF0001 on 2026-08-29 (~10:30 UTC), so the
live feed serves 1 listing** — and 0073 (same day, audit FEED-1/DB-02) made it
launch-ready: listings now carry an `images` jsonb array (cover first,
public-bucket rendition URLs absolutized by the route, `kind='photo'` with
finished renditions only — never the EXIF-bearing private original, asserted
by a prosrc grep in the migration and RLS test 49), `published_at` is stamped
by `saveProperty` on every transition into public (backfilled from the
visibility-change events), and the ETag folds in a photo fingerprint so
add/remove/reorder/cover moves the validator. See DECISIONS `T-feed-media`.

Four things to know before touching it:

1. **The predicate is `visibility='public' AND status='available'` — the score
   is NOT re-checked**, contrary to the brief. An admin can publish below
   `PUBLISH_THRESHOLD` deliberately (`publish_override`, audited), and no DB
   constraint ties visibility to the score, so re-checking would silently undo
   an audited decision and would drop listings whose score merely decayed.
   Operator decision; `published_below_threshold()` keeps that drift visible.
2. **The returned columns are an ALLOWLIST of 35 (34 + `images`, 0073), not a
   denylist.** `properties` has 72 columns (69 + 0077's four DLS identity
   columns − 0083's dead `sold_at`; the allowlist deliberately withholds the
   DLS four). A column added to `properties` is
   withheld until somebody edits `public_listings` on purpose — which is the
   only way "adding a column cannot silently publish it" can actually hold.
   RLS test 41 asserts the withheld names AND that no withheld VALUE appears
   under any key; test 49 pins the images shape.
3. **`/api/public/` is a third public prefix in `proxy.ts`**, beside `/p/` and
   `/offline`. Anything put under it is unauthenticated by construction.
4. **It cost six new advisor WARNs**, all deliberate: `public_listings`,
   `public_listings_etag` and `note_public_listing_hit` are anon- and
   authenticated-executable SECURITY DEFINER functions, exactly like
   `resolve_share_link`. No new ERROR-level lint, which is why this is a
   function and not a granted view.

**C4 IS COMPLETE (2026-08-29)** — migration 0065 plus `/reports/performance`
and a CSV export per report. Five SECURITY INVOKER aggregates (agent
performance, source ROI, time to close, stage conversion, price reductions)
and `report_citation()`. `docs/DECISIONS.md` `T-c4` has the detail; three
things to know before touching it:

1. **There is no materialised view, and there must not be one.** The brief's
   warning was measured and is worse than it says: an MV over an RLS table
   returned BOTH orgs' rows to an org-scoped session — directly AND through a
   `SECURITY INVOKER` function — and `alter materialized view … enable row
   level security` is refused outright (42809). An MV cannot be made safe by
   policy at all, only by never granting it and filtering in a wrapper.
2. **`stage_changed` records stage NAMES, not ids** (0011). Stage conversion
   therefore joins on a mutable string and declares it (`stage_key: "name"`);
   renaming a stage splits its history. Won/lost are separate event types
   whose payloads carry the DESTINATION stage, so outcomes are counted but
   deliberately not attributed to the stage they left.
3. **The citation anchors, it does not reproduce.** It records the verified
   `(last_id, last_hash)` from 0062 — a point a walk actually proved. It does
   NOT prove the figures are reproducible, because most metrics read mutable
   entity tables that are not hash-chained. Only stage conversion is genuinely
   re-derivable, and it says so in its own output.

**C5 IS COMPLETE — all four steps built, applied to hosted, merged and
deployed (2026-08-28).** `docs/DECISIONS.md` `T-c5` carries what was measured;
the short version, because two of these change how you read the chain:

| | |
|---|---|
| 0060 | `verify_events_chain(p_org, p_from_id)` returns `(ok, failed_id, reason)`. The one-arg boolean is unchanged, so all four callers stayed put. **`p_from_id` has NO default** — with the wrapper present, a default makes the one-arg call ambiguous and it fails at CALL time, not at apply time |
| 0061 | `hash_version`. **The chain used to read `false` on intact data under `Asia/Nicosia`** — this desk's own timezone. v1 rows keep the old formula; v2 hashes ISO-8601 UTC. `verify_events_chain` now pins `TimeZone = 'UTC'`, which fixes the v1 rows too |
| 0062 | `events_chain_checkpoint`. Nightly 03:30 is now incremental; a **full walk runs Sundays 03:35**. `full_walk_at` is the column that tells you how stale the prefix proof is — **a resumed walk does NOT re-prove the prefix**, and that is inherent, not a defect |
| 0063/0064 | `events` is monthly RANGE-partitioned on `occurred_at`, PK `(id, occurred_at)`. **Partitions live in the `events_parts` schema** because `pg_default_acl` grants `anon=Dxtm` on anything created in `public`, and `D` is TRUNCATE, which RLS does not gate. 0064 dropped the rollback copy after the deploy was confirmed |

**Two things a future session will otherwise get wrong:**

1. **`id` is no longer unique on its own.** PK is `(id, occurred_at)` because
   Postgres requires the partition key in a unique index — and
   `verify_events_chain` walks by `id`. `events_partition_health()` reports
   duplicates; RLS test 21d asserts it returns nothing.
2. **PostgREST never exposed partitions.** Measured: a partition moved into
   `public` and granted `select` to `anon` is still refused with `PGRST205`
   after a restart. Do not write a test that GETs a partition — it passes
   whether or not the partition is protected. The GRANT is the exposure.

A pre-partition snapshot of production sits at
`gnk-backups/events-pre-partition-2026-08-28.sql` (120 rows, chain fingerprint
`31aea3aade863d58c294a77043438468`, sha256 beside it).

**SECURITY POSTURE CHANGED TODAY: 2FA IS MANDATORY.** Both halves are live and
coupled by a test — `MFA_REQUIRED = true` (proxy) and migration **0059** (the
opt-in arm is gone from `mfa_satisfied()`). A session without a second factor
now reads NOTHING, whatever client it uses. Both operators confirmed sign-in
afterwards. Flipping either half alone fails the RLS suite on purpose; see
DECISIONS `T-mfa-mandatory`.

### The only thing that actually matters now

**Production holds FOUR properties (PAF0001–PAF0004, entered by the operator
2026-09-01 through Claude in Chrome) and 2 contacts.** Everything below is
secondary to entering real listings. **PAF0002 is a villa development**
(kind `project`, €4.85M, ZERO units) and was set PRIVATE on 2026-09-01 until
the operator writes its copy. **Its next step, in order:** write the
title/short/public text → open its units page and generate the villas (the
Villas layout on the generator — NOT "Create similar", which makes a NEW
project; the wizard's Development layout only serves a project being created)
→ publish. Until it has
units the publish gate refuses it by design and the feed will not carry it —
see DECISIONS `T-container-aware-listings` / `T-wizard-project-layout`. The
PAF0003/PAF0004 doubled-title corruption (the Chrome `type`-appends trap)
was repaired 2026-09-01; `docs/AGENT_TEST_PROMPT.md` front-loads that trap.

The tools that pay off the moment data exists: **`/properties/worklist`** (what
each listing is missing, ranked by recoverable points), **Create similar**, the
**pricing panel**, and the new **VAT panel**. PAF0001 itself sits at 85/100,
needing only photos (15) and an assigned agent (5).

### Waiting on a person — nothing here is engineering work

| # | Item | Who | Note |
|---|---|---|---|
| 0 | ~~**Arm the dead-man's switch**~~ | ~~operator~~ | **DONE 2026-08-30.** Operator signed up (passwordless); the check `gnk-crm nightly backup` (Period 1 day, Grace 2h, email ON) is live at healthchecks.io, `HEALTHCHECK_URL` is in backup.env, and the WHOLE alarm cycle was proven with real pings through notify.mjs: new→up (rc=0), up→DOWN (rc=1 → /fail → alert email), down→up (recovery email). A silent missed night now emails within ~26h. |
| 1 | **Store the USB offsite** | operator | It is verified and restore-proven but only helps if it leaves the building. Downgraded again 2026-09-02: the attested GitHub leg now PROVES an off-machine copy nightly (re-download + hash), so the USB's remaining role is the offline copy no cloud account compromise can touch. |
| 1b | **Arm the attested GitHub leg** | operator | One paste: add `GH_TOKEN` to `backup.env` (under the `GH_BACKUP_REPO` line that is already there — use `gh auth token` output or a fine-grained PAT scoped to `gnk-backups-offsite`, Contents R/W). Until then the leg logs SKIPPED and nights stay green; after it, a missed GitHub upload fails the night into the dead-man. |
| 2 | **B4 contracts** (IMPROVEMENTS) | operator | Viewing confirmation shipped (0027); the two contract templates are **blocked on supplied wording**, not on code. |
| 3 | **A9 field CWV** (IMPROVEMENTS) | operator | LCP/CLS/INP need a VISIBLE browser — a 30-second DevTools Lighthouse run. Server timing was already fixed (`fra1`, ~3x). |
| 4b | **Rent developments in the units subsystem** | gated: first rental development | The units subsystem is SALE-shaped: the matrix, price lists, the uplift, the public availability share (SQL 0041) and sales velocity all read `asking_price` as the unit price. A rent development's monthly figure therefore lands in `asking_price` and prints without "/month" (a same-day remap to `rent_price_month` made rent units invisible to all of them and was reverted — DECISIONS `T-container-review`). Making it rent-aware is a feature with a migration; build it at the first rental development mandate, not before. |
| 4 | **Unequal purchaser shares** | operator | A1's follow-up: the calculator assumes EQUAL shares. A per-share list is ~a day, and the entry says to ask the agents before building it. |

### Buildable: PHASE C IS BUILT — ONLY C7 REMAINS, AND IT IS GATED (2026-08-29)

The operator decided to build **all of `IMPROVEMENTS.md` §C**. The brief is
**`docs/PHASE_C_BRIEF.md`** — a re-audit against the code, not the roadmap's
prose. Each of §2, §3 and §4 now opens with a SHIPPED banner and the
corrections that section needed.

**C5, C4 and C3 are shipped (migrations 0060–0066). C7 is the only item left
and it stays gated** — it needs a concrete second-office or franchise
requirement, and there is one office and two admins. Do not start it on the
strength of the roadmap alone.

**HOW THE BRIEF HELD UP, now that all three sections have been built against
it.** Worth reading before trusting any other planning document here:

* **Five specifics were checked. Four were wrong, incomplete, or a premise
  that does not hold.** `p_from_id default null` (§2) would have applied green
  and broken the 03:30 cron. Epoch microseconds (§2) was one of two equally
  canonical options. Finding 3 (§2) misdescribes the writers — every writer
  takes `default now()`; the computed dates go in the payload and
  `tasks.due_at`, so the invariant held by construction rather than luck. And
  §4's load-bearing premise — "a listing below 70 cannot be made public
  internally" — is false: an admin can override, audited, and no DB constraint
  ties visibility to the score.
* **One was RIGHT and understated.** §3's materialised-view warning: an MV over
  an RLS table leaks across orgs even behind a `SECURITY INVOKER` function, and
  RLS cannot be enabled on an MV at all (42809).
* **The lesson is not "the brief was bad".** It was a good brief and it aimed
  the work correctly. It is that a re-audit written without running anything
  will contain claims that look like facts, and the cheapest moment to find
  out is before the migration, not after the deploy.

**Order is C5 → C4 → C3 → C7**, and C7 stays gated on a real second-office
requirement. The brief carries the three findings that matter most, none of
which appear in `IMPROVEMENTS.md`:

1. **`verify_events_chain` returns a bare boolean** — when it says `false` it
   tells you nothing about WHERE, and it will say `false` exactly when someone
   is under pressure. Returning the failing id is the highest-value hour in
   the whole phase.
2. **The hash covers `occurred_at::text`, which is session-timezone
   dependent.** C5 is the only moment that table is open; fixing it needs a
   `hash_version` column so existing evidence stays verifiable.
3. **Materialised views do not respect RLS.** C4 is described as "a
   materialised-view problem"; an MV over `events` is computed once for
   everyone, and reading it from a SECURITY INVOKER function does NOT
   re-apply row security. That is a cross-org leak waiting to be written.

**I advised against building §C now** — production holds 1 property, 2
contacts and 119 events, and C5 partitions a 144 kB table. The operator
decided to proceed; that is recorded in the brief's §0 along with what it
changes about scope (build for the SHAPE of the data, not its volume; any
metric that cannot be checked against real data ships with a synthetic
fixture that supplies it). Do not re-litigate it.

### THREE DOCS ARE NOW WRONG. Fix them before trusting them.

1. **`IMPROVEMENTS.md` §D says "Hard delete anywhere" is not recommended** —
   "the append-only hash-chained `events` spine *is* the commission evidence".
   Production has now been hard-deleted TWICE: ~19 properties on 2026-08-22 and
   four on 2026-08-28 (operator-instructed, test records, after the cost was
   explained). **28 property events now point at rows that no longer exist.**
   The chain still verifies — events were never touched — but the guidance and
   the practice disagree, and one of them should change.
2. **`IMPROVEMENTS.md` C2 still describes 2FA as opt-in enrolment.** It has been
   mandatory since 2026-08-28.
3. **`IMPROVEMENTS_EXECUTION.md` still says "Commit, do not push — the standing
   agreement."** That was superseded on 2026-08-23; this session pushed, merged
   and deployed continuously. A future agent reading it will hold work back.

### A10 leaked-password: assessed, and it is NOT a gap here

Pro-only, and this org is free — but more to the point **there is nothing for it
to check**. `inviteUser` mints every password as `randomBytes(9)` (72 bits) and
there is no forgot-password link, no change-password UI and no SMTP. No human
has ever chosen a password in this system. The advisor lint's PRESENCE is
expected. Re-open when a password-change flow lands; the free fix then is the
HIBP range API, not a plan upgrade. The free half (length + character classes)
was set in the dashboard on 2026-08-28.

### Where "what remains" actually lives — surveyed 2026-08-28

Checked, so the next session does not re-survey: **no open GitHub issues, no
open PRs**, 30 markdown files in the repo. The unchecked boxes in `CLAUDE.md`,
`IMPROVEMENTS_EXECUTION.md` §checklist and `BACKUP_RESTORE.md` §5 are
definition-of-done TEMPLATES — they are supposed to be empty and are not work.

**`docs/superpowers/plans/` was the one real trap.** Its three plans carried
**118 unchecked steps and zero ticked**, for work shipped weeks ago (0029, 0030,
0031, 0032 — DB 2FA, the property map, the RLS helper hoist). Nothing said so.
Each now opens with a **DO NOT EXECUTE** banner naming the migration that
delivered it, because a plan that reads as 42 open steps invites a future agent
to rebuild production. The C2 plan also carried a second hazard: it describes
building the opt-in arm that **0059 has since removed**.

`IMPROVEMENTS.md` §C is the honest remaining roadmap; `docs/BACKLOG.md` is at
zero buildable items; the specs under `docs/superpowers/specs/` are design
records with no checkboxes and nothing outstanding.

### Traps this session paid for

1. **A doc that warns about a trap but still contains it is worse than
   silence.** `supabase/dev-fixtures.sql` documented "district codes duplicate
   per org, scope by org_id" in its header and used unscoped lookups anyway.
2. **On Windows, `ps aux | grep` cannot see Windows processes.** It reported
   zero Playwright processes while three were running; two suites then fought
   for the auth service and a TOTP enrol timed out at 11s. Use PowerShell
   `Get-Process`.
3. **React resets an uncontrolled form after a server action settles** — so a
   FAILED create empties the boxes. Anything reading those inputs afterwards
   reads blanks, which is how the new-property draft briefly overwrote itself.
4. **`/session-clock` blamed the machine clock when all three clocks agreed to
   the second.** It fires on PGRST303, which `lib/supabase/clock-skew.ts`
   records hitting production three times before. The remedy is signing in
   again, not correcting a clock.

## 0a-prev. The project availability share link (2026-08-22)

**The project availability share link is BUILT.** This section held its brief;
what shipped is struck through in `docs/BACKLOG.md` with a VERIFY line, and the
design lives in `supabase/migrations/0041_availability_share_links.sql`, which
is written to be read the way 0023 is. **This section does not restate it** —
that is the bug §0 keeps having.

State, measured 2026-08-22: **local and hosted are both at `0041`**, verified on
each side in a call separate from the one that applied it — `non_filename_versions`
= 0, `rls_aal2_coverage()` = 0, `anon` INSERT on 0 of the RLS tables, 79 events
unchanged (the assertion probe rolled back and wrote nothing), and
`verify_events_chain` true BEFORE and AFTER on both. Merged to `main` and pushed.

What a session picking this up needs to know, and nothing more:

| | |
|---|---|
| the four decisions §0a used to list | all four made and written up in 0041's preamble and in BACKLOG's struck entry |
| the exposure boundary | widened to carry `status`, **for `kind = 'availability'` only**. RLS test **29** proves the scoping by resolving both kinds over one project. Test 25 is untouched and still pins the proposal boundary |
| the phase trap | closed — the resolver walks descendants, recursively, because the one-level rule is enforced in `createPhase` and not in the database |
| what is NOT done | a real availability link sent to a real developer, and **hosted currently has no project with units**, so minting one there needs a project built first. **The feature is PROVEN on production**, not merely deployed: `PAF0004` was created, a pinned link minted, opened anonymously (both phases, each phase's own delivery date, launch prices not live ones, B302 unpriced), then revoked to the neutral page — `created` → `opened` → `revoked`, chain true throughout. **The throttle showed itself: 2 views, ONE `opened` event.** Same shape as the B3/B7 proof in §0, and the events stay after the link dies, which is correct |

**One thing worth carrying rather than looking up.** 0041's assertion block greps
the compiled function body for forbidden column names, and on the first apply it
rejected the migration because a COMMENT inside the function used one of those
words in prose. That is the guard working: a substring match on `prosrc` cannot
tell documentation from SQL, which is exactly why it cannot be argued past. Keep
the forbidden list in the file header, never inside the function.

**And the defect that only the rendered page could find.** `unpriced_count` was
counting units with no asking price in LIVE mode, so a page with no price list
carried a sentence about one. Every test passed; the number was wrong on screen.
It was caught by reading a real 75-unit project's page, and the regression
assertion was confirmed to FAIL against the pre-fix resolver before being kept —
because a test that cannot fail spends a green run on nothing (§4).

---

## 0. START HERE

> **THIS SECTION POINTS. IT DOES NOT RESTATE.** Roadmap state belongs to §5,
> known gaps to §6, accepted-not-fixed findings to §2c, backups and drill results
> to `docs/BACKUP_RESTORE.md`, history to `docs/DECISIONS.md`. **A conclusion
> summarised here is stale by construction** — three of them were on 2026-08-09
> (this section's own counts, "do not start B4", and "nothing is half-finished",
> the last contradicted by four other sections of this file). **When you find
> one, delete it and point at the owner. Do not correct it in place** — a
> corrected copy is just a copy that goes stale later.

> ### 2026-08-09 — read before trusting anything below this line
>
> Three things were found broken in production and fixed the same day. Full
> narrative in DECISIONS `T-prod-day`; what a new session needs:
>
> | area | state |
> |---|---|
> | Supabase keys | **BOTH** were the disabled legacy pair. Fixed, and verified by real calls (login + a slip download), not by reading the env. §2b |
> | CSP | **ROOT-CAUSED AND FIXED 2026-08-10** — the nonce now lands in production (`/login` 22 of 22). The cause was ours: a `Content-Security-Policy` key in `next.config.ts` `headers()` occupied the request header Next reads the nonce from, and won on Vercel but not locally. Three rounds had blamed the platform. **Then ENFORCED the same day** — `/offline` was not a blocker after all (static text, 0 interactive elements). `npm run check:csp-nonce <url>` measures the nonce; rollback is `CSP_HEADER` in `lib/services/csp.ts`. IMPROVEMENTS C1 owns it |
> | Sentry | server `SENTRY_DSN` was missing, so everything reported nowhere. Fixed; delivery **and** alerting proven with probes. Source maps + release tracking still missing — BACKLOG |
>
> **The pattern matters more than the three fixes.** Each was an undated
> "verified" claim in this file that nobody re-checked, and each was contradicted
> by evidence already sitting in a log — including one this file talked a reader
> out of believing. **Date every claim here, and re-check it rather than reading
> it.** The rest of §0 was rewritten under that lesson on 2026-08-09; §1 onward
> still predates it.
>
**Nothing is half-APPLIED** (2026-08-10): no failed migration, no half-deployed
change, no open incident. The CSP control that this line had to disown on
2026-08-09 was root-caused and fixed on 2026-08-10 and is now measured working in
production — table above, IMPROVEMENTS C1 owns it. Both long-standing *operator*
items are closed — the exposed `service_role` key is revoked (§2b), and Sentry is
wired and confirmed receiving, so C1's report-only CSP has a durable sink.

**The lesson from that one is worth more than the fix.** It was called broken,
then blamed on the platform three times over, and the answer was a header this
repo set itself. **What broke the deadlock was measuring what ARRIVED instead of
what was missing** — every round that reasoned about the absence got it wrong,
and the one that asked a deployed endpoint what it actually received got it in a
single deploy.

**That is NOT the same as "nothing is outstanding", which is what this line used
to claim** — while four other sections of this same file said otherwise. Plenty
is outstanding, including security work. **§5 owns roadmap state and the operator
list, §6 owns the known gaps, §2c owns what is accepted rather than fixed. Go and
read them — a summary of them here is exactly the bug this section keeps
having.**

**C6 is closed and the backup story is finished — `docs/BACKUP_RESTORE.md` owns
all of it, and this section no longer summarises it.** Where to look:

| | state | owner |
|---|---|---|
| Restore drill, both halves | **PASSED 2026-08-05** | §4b (database — found four defects) · §4c (Storage) |
| Schema of record | `2026-08-06/pg_dump.sql`, `--schema public` | §2 here for the set table |
| RTO | **measured** — ~4.5 min of machine, inside a 4-hour target | §6b |
| Restore traps (the pooler's misleading auth error, 0-byte dumps, `-f`) | still true | §3.1 |

**Two things worth carrying in your head rather than looking up.** The drill
proved the evidence survives a restore *as evidence*: the PDFs still re-hash to
the values in their generation events, one of them pulled through the app's own
Download button. And the check that shows it is **comparing hashes to the
source** — `verify_events_chain = true` alone cannot, because a re-minted chain
verifies happily against invented values (BACKUP_RESTORE §5).

**Both drill targets were local, and that is the one limit to carry.** §4c and
§6b ran against the local stack because the cloud routes need credentials the
operator holds. Bytes, hashes, buckets, the app path and the timings are proven;
**cloud S3 behaviour and the §4b.3 grant defect are not reproducible locally** —
§6b shows `anon` correctly restricted there, which is §4.2 below, *not* a
contradiction of §4b. **§4b stays the authority on grants.**

**EVERY ROW IN PRODUCTION IS OPERATOR-CREATED TEST DATA. There is no live client
data yet** (operator-confirmed 2026-08-04). Contacts, properties and the
`MARIOS ANDREOU` deal were all made for testing.

> **Never infer usage from row counts.** On 2026-08-04 an agent saw a
> real-looking deal with a real agent assigned and "corrected" this file to say
> the desk had started using the system. It had not. Counts tell you what
> exists, never who created it or why. Ask, or read `events.actor_id` and the
> payloads.

What follows from it: destructive testing on hosted is cheaper than it looks —
no client PII is at risk *today*, though that changes the moment real work is
entered. And §2b's exposed key reached a test dataset, not live KYC documents;
revoking was still right, but calibrate the severity honestly.

**B3 and B7 are proven end to end in production, not merely shipped**
(2026-08-04) — link minted → opened → revoked → re-minted, and lead → deal →
nudge → superseded-on-contact, with correct actor attribution and the chain
verifying at every step. The seed rows were deleted afterwards and **their events
remain, which is correct** — that is why production holds events whose row is
gone. Don't "fix" it.

**Do not act on a remembered "do not start B4".** That instruction lived here
until 2026-08-09 and was already false when it was last read — its first slice
had shipped. **§5 owns B4's real state**, and B5's. **B9 is closed, not
deferred.**

**What next is still usage, not code:** a real proposal link sent to a real
buyer, and the PWA on a phone. Decision-free engineering work is bug-shaped and
lives in `docs/BACKLOG.md`, not IMPROVEMENTS.

First checks in a new session — all read-only:

```bash
cd "D:/dev/TSOPOZIDIS/gnk-crm" && git log --oneline -3 && git status -sb
```

Then via the Supabase connector (`execute_sql`). **Two of these are invariants
and must hold whatever else has changed: `non_filename_versions` = 0, and the
chain verifies.** The counts are a snapshot, so they carry the date they were
taken — **2026-08-09: migrations 28 · `events` 74 · `share_links` 2 · `tasks` 0 ·
`deals` 1.** They only ever grow; a *lower* number is the alarm. This line went
stale once already (it said 25/73 while the header table said 28/74) — if the two
ever disagree again, re-run the query rather than picking a side.

**Two snippet corrections that read like real failures:**
`verify_events_chain` takes an argument — `verify_events_chain(p_org uuid)`;
calling it bare raises `42883 function does not exist`, which looks like a
missing migration. And `non_filename_versions` must test
`version !~ '^[0-9]{4}$'` (versions are `0001`…`0028`); the 14-digit timestamp
shape flags every row.

---

## 1. Shipped

Full write-ups in `docs/DECISIONS.md`; migrations in `supabase/migrations/`.

**2026-08-20** — 0033 `short_references` — **APPLIED TO HOSTED and verified
there.** Property references are now `PAF0001`, not `GNK-PAF-0001`. District
codes UNCHANGED (PAF/LIM/LAR/NIC/FAM); only the org prefix and hyphens went.
Operator decision, taken before the first real import precisely because doc 02
§A6 declares a reference immutable once assigned. Units follow for free —
`PAF0007-B203` — with no code change, since `lib/actions/units.ts` derives them
from the parent.

**⚠️ THE FIRST ATTEMPT WAS REFUSED BY PRODUCTION, AND THAT WAS THE SYSTEM
WORKING.** Trigger `properties_reference_immutable` raises 'property reference is
immutable once assigned' on any change to the column. §A6 is not just written
down, it is enforced. The migration now disables that trigger for exactly the one
UPDATE, re-enables it immediately, and **refuses to finish unless `tgenabled`
is back to `'O'`** — leaving it off would silently remove a real integrity guard.
Re-verified by BEHAVIOUR afterwards, not by reading the flag: an attempted
`update ... set reference = 'HACK9999'` was rejected with the same message.

**CI had passed this migration and could not have caught it.** On a fresh
database the UPDATE matches zero rows, so the trigger never fires. "Green against
a fresh DB" proved the migration APPLIES; it said nothing about the data path.
Worth remembering for any migration whose real work is a backfill.

Verified: refs `PAF0001, PAF0002`; 2 properties; counters `PAF:2` untouched
(they key on district_code, which did not change); 33 migrations,
`non_filename_versions` 0; **events 75 and the event-chain md5 byte-identical at
`b2a169b7bc6b9dceea2c508ae5f3659d`** — the audit log was not rewritten, and the
two events naming `GNK-PAF-0001/0002` keep that string because it is what the
reference WAS when they were recorded. Production pages re-read afterwards show
the new format and zero occurrences of the old one.

**2026-08-20** — 0032 `hoist_auth_uid` — **APPLIED TO HOSTED and verified there.**
32 migrations, `non_filename_versions` 0, **115 policies before and after**,
`rls_bare_auth_calls()` **0**, 11 policies with a hoisted `auth.uid()`, 0030
untouched (0 bare helpers / 24 hoisted), events **75** unchanged. Verified BEFORE
recording the version.

**The check worth copying: un-hoisting the NEW policies reproduced the BEFORE
md5 exactly** — `449357231cbb28edd8c20d7d3a01d98c` over every policy predicate in
`public`, captured before the change and recomputed after with
`( SELECT auth.uid() AS uid)` normalised back to `auth.uid()`. That is proof no
predicate changed MEANING, not a claim that none did.

Applied as ONE `execute_sql` call, deliberately, for the same reason 0030 was:
the self-check reads a temp table captured in the same session, and splitting it
would leave the guard with nothing to compare against.

Advisors after: performance `auth_rls_initplan` **23 → 12** (110 → 99 lints
total), **none remaining on the 7 paginated list tables** — the 12 are the
config/staff-bounded tables 0030 excluded. Security went 21 → 22, the single
addition being `rls_bare_auth_calls()` as a `SECURITY DEFINER` function callable
by `authenticated`, which is intentional and matches the 0030 helpers; `anon` and
`public` are revoked (`proacl` re-read: postgres, authenticated, service_role).

**Functional check in production, because an RLS denial returns ZERO ROWS rather
than an error** — "broken" and "correctly denied" look identical in the UI.
Signed-in fetches of 7 routes returned byte-identical page sizes to before the
change (dashboard 64kb, properties 91kb, contacts 75kb, tasks 57kb, viewings
62kb, pipeline 60kb, map 54kb) with real references rendering (`GNK-PAF-0001`,
`GNK-PAF-0002`) and the map still resolving features.

**Nobody will feel this at 2 properties.** It is insurance for thousands of rows,
on the same reasoning 0030 was accepted under.

**2026-08-20** — `a787d78`, `2829937` — **A9 closed: the functions were on the
wrong continent.** No migration. Timed server response on production, warm, 3
fetches per route: `/login` came back in **1301 ms** while fetching no business
data at all — as slow as `/dashboard`. That is what proved the floor was a FIXED
per-request cost rather than query complexity, and no amount of dashboard tuning
would have touched it.

`X-Vercel-Id: fra1::iad1` — edge in Frankfurt, **function in Washington DC**,
database in `eu-central-1` Frankfurt, and `proxy.ts` calling `auth.getUser()` on
every request before any page code. `vercel.json` now pins `fra1`.

After, same method and session: **dashboard 1324 → 387 ms, properties 818 → 258,
contacts 672 → 247, tasks 1409 → 479, login 1301 → 469. ~3x on every route**, and
the uniformity is the evidence — a fixed cost removed, not a query improved.
Relative numbers, not absolutes: both columns include client-to-edge latency.

**NOT fixed: the ~4 s cold start** on the first hit after idle, measured before
the move and a separate serverless characteristic. **NOT measurable by an agent
at all: LCP/CLS/INP** — a hidden automation tab never reports LCP (§7), so that
half of A9 still wants 30 seconds of the operator's DevTools.

**2026-08-20** — `30fdddc` Next 16.2.10 → 16.3.1. **No migration.** Cleared 6
high-severity CVEs: `sharp <0.35.0` inheriting libvips CVE-2026-33327, -33328,
-35590, -35591. **Reachable, not theoretical** — `next/image` is used by the
property list and media tab, so the optimiser runs sharp over agent-uploaded
photos. The direct `sharp` was already safe at `^0.35.3`; the vulnerable copy was
NESTED at `node_modules/next/node_modules/sharp@0.34.5` because Next 16.2 pins a
0.34.x range, which is why the fix was a Next bump. Two more (`fast-uri`, via
Sentry → webpack → ajv) went with a plain `npm audit fix` — lockfile only.
**`npm audit` now reports 0, production and full.** Checked beyond the usual
gates because a Next minor could disturb C1's nonce path: `check:csp-nonce`
reports **16 of 16** script tags stamped on a real production build.

**2026-08-20** — B5 map, second pass. **No migration; code and docs only.**
`17d204f` click-through popups, fit-to-results and clustering · `97bd359` the
correction below · `5ec3d19`, `9e2ddc9` the false alarm. CI green on each.

**Clustering here is correctness, not decoration.** `resolvePosition` falls back
to the AREA then the DISTRICT centroid, so every property in one area resolves to
the IDENTICAL coordinate — forty listings drew as one circle. Such a cluster can
never be split by zooming either, so clicking one checks whether its leaves share
a coordinate and, when they do, lists them in the popup instead. Pin clicks use
`queryRenderedFeatures` for the same reason: taking the top feature would open an
arbitrary property. `boundsOf()` is pure and unit-tested including the degenerate
single-property box, which needs `maxZoom` or `fitBounds` lands in a garden.

**⚠️ THE FALSE ALARM, KEPT ON PURPOSE.** Earlier that day this map was declared
broken in production, its link was HIDDEN from users, and two of its tests were
marked `test.fixme`. **It was working the entire time.** Two instruments lied and
neither was validated:

1. **A hidden browser tab never runs `requestAnimationFrame`.** MapLibre requests
   tiles from inside its render loop and fires `load` from there, so a
   backgrounded tab reproduces every symptom of a dead map — no tiles, no `load`,
   no pins, no errors, correct canvas. Every check, production included, was made
   through automation where `document.visibilityState === "hidden"`.
2. **A worker's fetches never reach the window's resource timeline.** Same working
   page, same moment: 9 tiles at the network level, **0** via
   `performance.getEntriesByType`, and 11 `.pbf` glyphs on the main thread — which
   is what made the original any-`.pbf` assertion pass for the wrong reason.

So an assertion that could not fail was replaced by one that could not pass, the
resulting red CI was read as proof, and a working feature was withdrawn on that
basis. Each step followed from the one before. **`docs/ENGINEERING_NOTES.md` §7
owns the trap; the struck BACKLOG entry keeps the full account.** The one real
bug found along the way — the map being torn down and rebuilt on every render —
was genuine, is fixed, and never caused anything blank.

**2026-08-11** — 0031 `area_centroids` — **B5 map view. APPLIED TO HOSTED and
verified there:** 31 migrations, `non_filename_versions` 0, districts **5/5** and
areas **10/10** seeded, **0 centroids outside Cyprus bounds**, FAM at
`35.0378, 33.9832` (Paralimni), **both production properties now mappable**,
115 policies and 24 hoisted unchanged, `get_advisors` identical to before,
chain verifies, events 74. Verified BEFORE recording the version.

`/properties/map` plots listings over OpenFreeMap tiles, reached by a Map/List
toggle that carries the filters through the URL.

**The entry that justified this feature was false.** IMPROVEMENTS B5 said
`properties.location` was "already populated"; **0 of 2 hosted rows had
coordinates**, so a map keyed on it would have rendered zero pins forever. Hence
centroids: exact location → area centroid → district centroid → omitted, with
approximate pins visually distinct. 0031 seeds all 15 (5 districts, 10 areas).
**FAM is the FREE AREA (Paralimni), not Famagusta town** — operator decision.

**Tiles need no account, key or payment** (OpenFreeMap, commercial use allowed).
Checked first: MapTiler's free tier forbids commercial use, and Nominatim tells
geocoding-led commercial apps to self-host. `https://tiles.openfreemap.org` is
now on `img-src`/`connect-src`; **the CSP is enforced, so deleting that line
blanks the map in production silently.**

**2026-08-11** — 0029 `require_aal2` — **applied to hosted, C2's DB-level 2FA.**
See §6 and IMPROVEMENTS C2.

**2026-08-11** — 0030 `hoist_rls_helpers` — **APPLIED TO HOSTED and verified
there.** 30 migrations, `non_filename_versions` 0, 24 hoisted, 0 bare,
**115 policies before and after**, the 29 `require_aal2` policies untouched,
`anon` and `authenticated` both refused on the two new guard functions,
`get_advisors` naming neither of them, chain verifies, events 74.

**Pre-flight worth copying for any policy migration:** hosted's own 24 bare
definitions were fingerprinted (`md5` over generated `drop`/`create` pairs) and
compared against local's hoisted policies un-hoisted back to bare — identical,
`a96260bd4ceb139244767018f19d1aa9`. That proved before touching anything that the
committed rollback script was valid for hosted and that the migration would
produce there exactly what it produced locally.

**Applied as ONE `execute_sql` call, deliberately against §3's usual advice** —
the self-check reads a temp table captured in the same transaction, and aborting
everything on a mismatch is the entire safety property. Verification ran in its
own call afterwards, as §3 wants. **Verified BEFORE recording the version**, so a
migration that had not landed could not be recorded as though it had.

**Operator-confirmed in a SIGNED-IN session, 2026-08-11: `/contacts`,
`/properties` and `/tasks` all render.** This is the check that mattered and the
one no agent could make — an RLS mistake returns **zero rows, not an error**, so
a broken policy and a genuinely empty list are indistinguishable from outside.
Catalog counts and anonymous surfaces cannot tell them apart; a human looking at
a populated page can.

24 permissive policies on the 7 paginated list tables now wrap both helpers in
`(select …)`, which Postgres evaluates once per statement. Counted, not inferred:
**21 helper calls for a 20-row scan before, 1 after.** 62 permissive policies
stay bare deliberately.

**Meaning is preserved, proven twice by different methods** — the migration's own
equivalence check (0 changed on an untouched database, exactly 1 when a policy
was deliberately weakened), and an independent diff that stripped the wrappers
back out and compared against the generated rollback script, byte-identical for
all 24. Two service-role guards, `rls_bare_helper_calls()` and
`rls_hoisted_policy_count()`, fail CI if a future policy regresses.

**The trap worth carrying:** `pg_policies.qual` is deparsed by `pg_get_expr()`
against the CALLER's `search_path`, so a `security definer` function with
`pg_catalog` pinned sees `public.current_org_id()` and an unqualified literal
silently INVERTS the guard. BACKLOG has the other two.

**2026-08-09** — 0027 `viewing_confirmation` · 0028 `org_mfa_status` — **both are
on hosted, re-verified there 2026-08-09**: enum value present; function present
with `anon` EXECUTE revoked and `authenticated` granted, which is the §4.3
default that 0021 missed. **Neither has a `docs/DECISIONS.md` entry — the
migration headers are the only write-up, and they are unusually complete.**

- **0027 is the FIRST SLICE OF B4** — a viewing confirmation generated from the
  record, following `evidence_report` (0015): same `documents` table, same
  private bucket, `viewing_confirmation_generated` carrying `pdf_sha256`. The
  other two B4 documents are contracts and are deliberately not built. **§5 is
  the authority on B4, not §0.**
- **0028** — `Settings → Users` showed Name/Email/Role/Status and nothing about
  2FA, so an admin could not tell that another admin was password-only. Found the
  hard way: production had a dormant second admin with no second factor, and only
  a hand-written query against `auth.mfa_factors` could reveal it (§5). The
  function is gated on `admin` *inside the body* (a non-admin gets zero rows, not
  an error) and returns one boolean per profile — never factor detail.

**2026-08-08** — 0026 `T-slip-pdf-hash` — the signed slip PDF, the strongest
commission-dispute artefact this system makes, had no recorded hash anywhere;
only the signature PNG did. Now `viewing_slips.pdf_sha256` **and** `pdf_sha256`
in the hash-chained `viewing_slip_signed` payload — the chained copy is the half
that matters, since a column alone is as forgeable as the file. **Deliberately
NOT backfilled**, and hosted still shows 1 slip with a null hash (re-verified
2026-08-09): hashing today's stored bytes would assert they are the bytes that
were signed, which nobody can know. A null says "unknown", which is true.

**2026-08-07** — 0025 `T-deal-contact` — **applied to hosted the same day via §3
and verified** (column present, 0 unbackfilled, 25 migration rows,
`non_filename_versions` 0, trigger `WHEN` reads `last_contact_at`,
`anon` cannot execute the job, `service_role` can, chain verifies, events 73).
`get_advisors` clean — no new finding; neither `create_followup_nudges` nor
`trg_supersede_deal_nudges` appears in the anon/authenticated lists.

> **The migration went out AFTER the code, and for a few minutes production ran
> code referencing a column that did not exist.** Pushing is enough to deploy
> (Vercel auto-deploys `main`) but it is NOT enough to migrate — hosted only
> changes when someone runs §3. `logConversation` on a converted lead would have
> failed in that window. **Apply the migration to hosted BEFORE pushing code that
> depends on it**, or accept a deliberate gap and say so.

The bug: the `deal_no_contact` nudge could be silenced by a typo. It keyed off `last_activity_at`, which every deal edit
stamps, so renaming a deal **closed the open chase-up** and logged
`reason: deal_contacted_or_closed` against the editing user — the log asserted
contact nobody had claimed. Silence now has its own column, `last_contact_at`,
written only by the new `logDealContact` action and by `logConversation` on a
converted lead. **The trigger's `WHEN` clause had to move with the predicate**;
the function alone would have been correct while the feature stayed broken, and
RLS test 27's second half is what caught it.

**2026-08-02/04** — 0024 `T-nudge-active-assignee` (system tasks never land on a
deactivated profile; every fallback arm active-only, nightly re-home sweep, RLS
test 26) · `T-csp-fixture` (the CSP detail tests seed their own rows instead of
depending on residue) · `T-sb-key-guard` (the client-bundle leak test would have
gone blind at key rotation) · `T-csp-413` (production was collecting CSP reports
and discarding them at 413) · `T-key-rotation` (§2b) · `T-sentry-dsn` (C1's
sink) · CI now builds on every push.

**2026-07-29/31** — B7 follow-up nudges (0020) · 0021 revoke on nudge triggers ·
0022 drop undocumented `service_role` grants · B3 buyer proposal links (0023) ·
B8 installable PWA · backup tooling (`scripts/backup/export-events.sql`).

---

## 2. Backups

Sets live in `../gnk-backups/`, outside the repo and untracked. **The table below
says what each set contains; the state table at the top of this file names the
current primary.** This paragraph used to read "Three sets … `2026-08-04` is the
primary" while the table directly beneath it marked 08-04 *superseded* and 08-07
*PRIMARY*. Don't reintroduce a summary here — there is nowhere for it to be
right.

| set | contents |
|---|---|
| `2026-07-30/` | `events.sql` ids 1–62 (**chain-faithful**), `business-data.json` (15 tables), auth + storage manifest, restore guide |
| `2026-07-31/` | `export.mjs` output: **all 26 Storage files** + every table as JSON |
| `2026-08-04/` | superseded — its `pg_dump.sql` carries the wrong-`--schema` defect. Keep for the hand-rolled deltas (an independent second copy of `events`) and as the artefact that exposed it |
| `2026-08-06/` | **the restore-PROVEN set** — `pg_dump.sql` (`--schema public`, correct), `data.sql` (**`auth.users` 2**, `events` 73), `roles.sql`. Loaded end to end with all 73 hashes matching production; README has the evidence. No Storage of its own |
| `2026-08-07/` | **PRIMARY — first automated set, and the only COMPLETE one.** Schema · data · roles · **26 Storage objects** · table JSON · `SHA256SUMS` · `manifest.json` (`verified:true`, `problems:[]`, events 73 = live). Produced and self-verified by `capture.mjs` |

**The older sets stay valid as prefixes, and that is sound, not a shortcut.**
`events` has no UPDATE/DELETE grant, so an older export remains a valid prefix of
production forever — verified, not assumed: production's first 62 rows still hash
to the md5 in the 2026-07-30 header. Storage has not been re-copied since
2026-07-31 because the newest object anywhere still dates from 2026-07-23
(re-confirmed 2026-08-06).

**Verifying an export on disk has an md5 trap** — the header hash is over
LF-joined insert lines with no trailing newline, and OneDrive stores the file
CRLF, so the naive `grep | md5sum` makes an intact backup look corrupt. Correct
command in BACKUP_RESTORE §5.

**Keep both.** `export.mjs`'s `events` copy is NOT chain-faithful — PostgREST
hands `jsonb` to JavaScript and numeric scale is lost, so `verify_events_chain`
fails on restore. `2026-07-31` has the FILES; `2026-07-30/events.sql` has the
events that actually restore.

~~**Still to do: `supabase db dump` for a true pg_dump.**~~ **DONE** — and
re-taken correctly 2026-08-06. pg_dump is primary; the hand-rolled exports above
are the independent second copy, not the safety net of last resort they once were.

**CAPTURE IS AUTOMATED AND LIVE. First green run 2026-08-07** — `2026-08-07/`,
55 files / 1,010 KB: schema 125,258 · data 84,661 with **73 events matching
production live** · roles · **26 Storage objects** · `verified: true,
problems: []`. The scheduled task also fired unattended at 03:45:02 that morning
and exited `2` with a clear reason while the config was still incomplete, so both
the happy and the unhappy path are proven in the wild.

`scripts/backup/capture.mjs` takes a complete set in one command
and **verifies its own output**, refusing to call it a backup otherwise: zero
`supabase_admin` in the schema file, `session_replication_role = replica` on line
1 of `data.sql`, the `auth.users`/`events`/`storage.objects` COPY blocks present,
and **events-in-the-dump compared against events-live-right-now** (a truncated
dump does not error). Exit `0` verified · `1` produced but untrustworthy · `2`
refused to start. Failures also land in `manifest.json` as `verified:false`.

A scheduled task **"gnk-crm nightly backup"** runs it daily at 03:45 (after the
03:30 chain-check cron) with `--keep 14`. **It exits 2 every night until
`C:\Users\user\.gnk-crm\backup.env` is created** from the `.example` beside it —
that is the operator action (§2c). That directory is outside the repo on purpose
— a password must never land in git, and back when the workspace was under
OneDrive it would also have synced to the cloud. It **stayed on `C:`** during the
2026-08-07 move; only `REPO`/`DEST` inside `run-backup.cmd` were repointed to
`D:\dev\TSOPOZIDIS`. The task is "Interactive only", so a machine that is off or
logged out at 03:45 takes no backup silently — the log is
`C:\Users\user\.gnk-crm\backup.log`.

**Still open, and now worse: getting a copy OFF THIS MACHINE.** `../gnk-backups/`
used to be under OneDrive — sync rather than backup, but it did put a copy in the
cloud. Since 2026-08-07 it is on `D:`, a second volume in the same box. Every
backup set is now single-machine; automation does not change that.

**A verified archive is staged and waiting for a destination:**
`TSOPOZIDIS/gnk-backups-offsite-2026-08-07.tar.gz` — **2.0 MB, 141 files**, all
six sets including the first automated one, `sha256 b689df4f…0b50` (in the
adjacent `.sha256`). Verified twice: 141/141 byte-identical after extraction, and
`sha256sum -c SHA256SUMS` passing 55/55 inside the extracted `2026-08-07` set.
It is the only archive — the earlier `2026-08-06` one was deleted after checking
it was a strict subset, so there is no chance of moving the wrong file.

**Moving it is operator-only.** Since 2026-09-02 ONE off-machine destination
is agent-reachable — the PRIVATE `gnk-backups-offsite` GitHub repo the
attested nightly leg ships to (§3.3; the script refuses any non-private
target). Nothing else must become one casually: it carries `auth.users` bcrypt hashes plus
the signed slips and evidence PDFs, and **`gnk-crm` is a PUBLIC repo**, so the
archive must never land in it. Verify with `sha256sum -c` **at the destination**,
not here. §3.3.

**Trap:** `export.mjs` reads `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from
the SHELL and loads no `.env`. With nothing set it silently falls back to
`NEXT_PUBLIC_SUPABASE_URL` — **your local stack** — and backs up the wrong
database. Always check `manifest.json`'s `source`.

`scripts/backup/verify-restore.sql` is the 47-check invariant pack; it passed
against hosted on 2026-08-02 after 0024. Re-capture its baseline before a drill.

---

## 2b. Key rotation — **RESOLVED 2026-08-03**

The exposed legacy `service_role` key is **dead**. Supabase disabled the legacy
JWT pair at `2026-08-03T17:40:12Z`; a REST call with it returns
`401 Legacy API keys are disabled` and the hint names `(anon, service_role)`
explicitly. Production runs on `sb_publishable_…` / `sb_secret_…` and is healthy.

> ### ⚠ THAT LAST SENTENCE WAS WRONG, AND IT CAUSED A ~6-DAY OUTAGE (2026-08-09)
>
> **Nobody could sign in to production.** 38 requests to `/login`, **zero** to
> `/dashboard`, for hours. The cause was the thing this section declares fixed:
> production was still running the **disabled legacy anon key**, so every auth
> call returned `401 Legacy API keys are disabled`, `getUser()` saw no user, and
> every navigation bounced back to `/login`.
>
> **How it survived the rotation:** `NEXT_PUBLIC_*` is **inlined at build time**
> (see the note in `proxy.ts`), and the production build log said
> `Restored build cache from previous deployment`. A cached build keeps the OLD
> value compiled in no matter what the Vercel variable now says. The fix was to
> set the publishable key and **redeploy with build cache OFF** — a plain
> redeploy is not enough.
>
> **Two things made it expensive, both worth more than the fix:**
>
> 1. **`login()` mapped every failure to "Invalid email or password."** A total
>    auth outage was indistinguishable from a forgotten password, so it was read
>    as one. Fixed 2026-08-09: credential rejections stay vague (no account
>    oracle), everything else says "temporarily unavailable — this is not your
>    password" and goes to **Sentry**, because Vercel keeps ~1h of runtime logs
>    and nobody reports a login problem that fast. `lib/services/auth-errors.ts`.
> 2. **This paragraph was believed over the evidence.** A production
>    `AuthApiError: Legacy API keys are disabled` on `/middleware` was visible in
>    the error log on 2026-08-07 and was dismissed as a stale browser session
>    *because this file said production was healthy*. **A "verified" claim with
>    no date and no re-check is a liability.** Verify keys against the running
>    deployment, not against this sentence.
>
> **BOTH keys were stale, not one — and the guard is what found the second.**
> Fixing `NEXT_PUBLIC_SUPABASE_ANON_KEY` restored sign-in, which made the outage
> look over. It was not: `SUPABASE_SERVICE_ROLE_KEY` still held the legacy JWT,
> so everything running as service-role was silently broken — slip downloads,
> evidence reports, document and photo upload/download, media renditions,
> branding, admin invites, contact merge, GDPR erasure, and the new viewing
> confirmation. None of it errors visibly on a page you would happen to open.
>
> `lib/supabase/key-health.ts` (shipped the same day) named it on the first
> render of `/settings/organization`:
>
> ```
> 09:24  GET /settings/organization  200 [error]  [supabase-key] SUPABASE_SERVICE_ROLE_KEY holds a LEGACY JWT Supabase key…
> 09:35  GET /settings/organization  200 [info]   (silent — fixed)
> ```
>
> **The guard checks SHAPE, so silence is necessary but not sufficient** — a
> well-formed but wrong secret would also pass it. Verified by exercising a real
> service-role call instead: "Download slip (PDF)" on viewing
> `85fe47a1-…` produced a working signed Storage URL and served the PDF. That is
> the check to repeat after any future key change.
>
> Confirmed recovered: `/dashboard` and every module route serving normally.
>
> **Post-incident sweep, 2026-08-09 — no damage.** The rollback paths in the
> upload actions call `admin.storage.remove()`, which was itself dead during the
> outage, so partial writes were plausible. Checked and clean: 3 document rows /
> 0 missing files, 1 slip / 0 missing files, 0 orphan signature objects, 5
> `property_media` rows consistent with their 5 files in both directions, chain
> verifies, nightly backup green (`2026-08-09` set, "every check passed").
> The only new event is `mfa_enrolled` — 2FA was turned on the same morning,
> factor `verified`.

Nine earlier attempts silently failed. **What worked: never touching the
Redeploy button.** Git pushes deploy reliably, so the env change was picked up
by pushing a commit and the deployment verified through the Vercel connector.

**If this is ever repeated, the order is not negotiable:** save env → **deploy**
→ **verify both keys in production** → *only then* disable the old pair. Vercel
injects env vars at deploy time, so before the redeploy the running app still
authenticates with the OLD keys. Everything before the toggle is reversible; the
toggle is not. Full account in DECISIONS `T-key-rotation`.

---

## 2c. Operator-only items

**Leaked-password protection is off, and it is NOT a free toggle.** It is gated
to **Supabase Pro** on this plan — a spend decision, not a click (established
2026-08-04; earlier handoffs implied otherwise and were wrong). Until the plan
changes, the advisor finding `auth_leaked_password_protection` is **accepted,
not unnoticed**. Not agent-reachable either: the connector has no auth-config
tool and the setting is platform config, not database state.

**PostGIS advisor findings — ACCEPTED, not unnoticed (measured 2026-08-20).**
`get_advisors` reports 21 security lints. Most are structural consequences of
PostGIS, which the `location`/`centroid` geography columns require, and are not
cleanly fixable:

| finding | why it is accepted |
|---|---|
| `spatial_ref_sys` has no RLS (**ERROR**) | PostGIS system table of EPSG definitions — public reference data, no customer rows. It is extension-owned, so enabling RLS needs an ownership we do not have. |
| `postgis` and `pg_trgm` live in `public` (WARN) | Moving a schema means dropping and recreating the extension, which would take every geography column and GIST/trigram index with it. Disproportionate. |
| `SECURITY DEFINER` functions callable by `authenticated` (WARN ×9) | **Intentional.** `current_org_id`, `current_role_gnk` and `mfa_satisfied` are the RLS helpers; 0029 grants EXECUTE to `authenticated` deliberately and revokes it from `anon`, which was verified when it was applied. |
| `mandates_safe` is a `SECURITY DEFINER` view (**ERROR**) | Pre-existing and deliberate — it is the safe projection. |

**One deserves a second look rather than a shrug: `st_estimatedextent` is
`SECURITY DEFINER` and executable by `anon`, so it bypasses RLS.** Measured
directly on hosted as the `anon` role on 2026-08-20:
`has_function_privilege` = **true**, and the call returns **null** — the planner
holds no statistics for a 2-row table. **So nothing leaks today, but that is an
accident of size, not a control.** Once the table grows and autovacuum analyses
it, the function returns the bounding box of every property coordinate to an
unauthenticated caller.

Sensitivity is genuinely low — an agency's coverage area is on its own website,
and this is an aggregate rectangle, not an address or a person. The app never
calls it: `grep -rn st_estimatedextent app lib components scripts tests` is
empty, so there is no code path to break.

> **THE "ONE LINE FIX" THIS ENTRY USED TO PROMISE DOES NOT EXIST. Attempted
> 2026-08-23 and measured at every step; all three paths are closed to us.**
>
> This said the fix was `revoke execute … from anon` and its two overloads. It
> is wrong twice over, and the second way is the dangerous one.
>
> 1. **Naming roles cannot remove a PUBLIC grant.** The ACL is
>    `{=X/supabase_admin, supabase_admin=X, postgres=X, anon=X, authenticated=X,
>    service_role=X}` — the leading `=X` is PUBLIC, so `anon` holds EXECUTE
>    twice. 0007 already knew this; every line of it reads
>    `from public, anon, authenticated`. Ours had drifted from that.
> 2. **Even the correct statement is a silent no-op, because we do not own the
>    function.** `st_estimatedextent` is owned by `supabase_admin`; the connector,
>    the CLI and the dashboard SQL editor all run as `postgres`, which is **not a
>    superuser and not a member of `supabase_admin`** (both measured). Postgres
>    answers a revoke you are not entitled to make with a WARNING and then
>    reports success:
>
>    ```
>    WARNING:  no privileges could be revoked for "st_estimatedextent"
>    REVOKE
>    ```
>
>    **In the dashboard editor that renders as "Success. No rows returned."** Run
>    it, believe it, and the advisor keeps flagging a hole you think you closed.
> 3. `set role supabase_admin` → `permission denied to set role`.
>    `alter function … owner to postgres` → `must be owner of function`.
>
> **So it is not deferred, it is UNAVAILABLE** — it needs Supabase platform
> support or a superuser, neither of which the operator or an agent has. What
> caught it was an assertion that tested the PRIVILEGE (`has_function_privilege`)
> rather than the statement's exit status; a migration checking only that the
> revoke "ran" would have shipped green and changed nothing. **If PostGIS is ever
> upgraded the ACL is rebuilt anyway, so even a successful revoke would need
> re-applying.**

~~**`GNK-PAF-0002`** still wants archiving via the UI button~~ **VOID 2026-09-02
— that row was hard-deleted on 2026-08-28** (operator-instructed; IMPROVEMENTS
§D now carries the explicit test-record carve-out). The reference itself was
recycled by the 2026-08-28 counter reset, so this line had begun pointing at a
FUTURE different property — caught by the 2026-09-01 artifact verification.

~~CREATE `C:\Users\user\.gnk-crm\backup.env`.~~ **DONE 2026-08-07.** The nightly
backup is live and its first full run is green — see §2 for the result. If it
ever needs re-doing, use
`powershell -ExecutionPolicy Bypass -File C:\Users\user\.gnk-crm\set-credentials-clipboard.ps1`,
which reads both values from the clipboard, validates them and tests the key
before writing. **Do not hand-edit `backup.env`** — three attempts to do so never
reached disk.

**DELETE THE DRILL PROJECT `gnk-crm-rto-drill` (`qxkpoqxiudkrctlvrvwg`) —
DEFERRED 2026-08-06, and it does not delete.** Created that day to time
provisioning (§6b). It holds **no production data** (a probe function and an
empty table), so the cost is one free-plan project slot, not an exposure.
Production is untouched and healthy. **Deliberately parked by the operator — not
forgotten.**

**Three dashboard deletes were reported and none applied.** State when parked:
`ACTIVE_HEALTHY`, `rest/v1/` answering 401. Confirmed against a negative control
— a nonexistent ref gives HTTP 000 / DNS failure, this gives 401 exactly like
production — so it is genuinely alive and the listing is **not** stale.

**Working diagnosis: management-API writes from the operator's browser silently
no-op.** A rename also reported success and also did not persist — the listing
still shows the original name. Untried when parked: a clean incognito session,
and the Network tab (`DELETE api.supabase.com/v1/projects/<ref>` — does it fire,
does it error). If both fail it is Supabase-side and wants a support ticket.

**Do not read this as "pausing broke it" — that was the first conclusion here and
it was wrong.** Pausing genuinely blocks both delete and restore *during* the
`PAUSING` transition (66 minutes, §4 step 8), but the deletes failed just as
completely from `ACTIVE_HEALTHY` afterwards, so the pause is not the cause. What
remains true: the connector has **no delete tool** (create/pause/restore only),
so this drill leaks a project unless a human removes it. BACKUP_RESTORE §4 step 8.

---

## 3. How to apply a migration

`.claude/settings.local.json` must contain the entry that unblocks
`execute_sql` writes:

```json
"mcp__728f3c26-074c-4f63-839e-0d81840c3291__execute_sql"
```

**The operator must add it** — an agent editing its own permission file is
blocked, correctly. It permits *any* SQL through that tool in this directory;
remove the line to restore the block. Kept deliberately (§5).

With it present: apply in **separate `execute_sql` calls** (schema → functions →
triggers → cron → the `schema_migrations` insert), **verify in a further
separate call**, then diff each function body against local — `md5(prosrc)` on
both sides is exact and beats eyeballing. Then **run `get_advisors`**; skipping
it is what caused 0021.

`create or replace function` **preserves the existing ACL** — it does not reset
grants. Re-read `proacl` afterwards anyway.

Two SQL-editor traps: the dashboard editor can discard DDL while a `select` in
the *same run* still sees it (verify in a second, separate run), and it wraps a
multi-statement script in one transaction, so a failure on the trailing insert
rolls back everything before it.

---

## 4. Patterns that bit repeatedly — check these on any new object

**A new object does not inherit the treatment an earlier migration applied.**

1. **RLS policies do not imply table GRANTs.** 0002 grants each table to
   `authenticated` one by one; a later table inherits nothing. Symptom:
   `permission denied for table …` with correct policies.
2. **Hosted grants new tables to `anon`/`authenticated` by default; local does
   not.** A migration that only GRANTs produces two different databases. Always
   `revoke all … from anon, authenticated` first, then grant back precisely.
3. **New `security definer` functions are anon-executable by default.** 0007
   locked this down; anything added since must repeat it — or be a deliberate
   exception pinned in `verify-restore.sql`, as `resolve_share_link` is.

**And on tests — four ways a green test proved nothing:**

- **A self-healing step can hide the bug it heals.** 0024's step 5 re-homes
  stranded tasks in the *same* invocation that mints them, so asserting on the
  final `tasks.assignee_id` passed even with the buggy arms restored. Where a
  job both creates and repairs in one pass, **assert on the creation event, not
  the row**.
- **A guard keyed to a credential's CONTENT dies when the format changes.**
  `security.spec.ts` asserted `not.toContain("service_role")`; a modern
  `sb_secret_…` key contains no such string, so the rotation would have left it
  passing and blind. When a credential format changes, re-check every guard that
  matches on its content.
- **A test can depend on the *absence* of residue.** RLS test 24 pinned the
  orphan-deal fallback to a specific admin; the fixture org accumulates admins
  across local reruns, so it passed only on a fresh DB — and CI always starts
  fresh, which is how such a test hides.
- **Playwright's `request` fixture is authenticated.** It reported 200 for
  `/manifest.webmanifest` while real browsers got a 307 to `/login`. Test public
  surfaces with an anonymous context.

**The meta-lesson from 2026-08-02/04: every defect found was in something
already marked done.** Auditing "verified" claims beat building new surface. But
the mirror error is just as easy — see the row-counts warning in §0.

---

## 5. Roadmap state

*Rewritten 2026-08-09. The previous version listed C1 as Done and claimed both
Sentry DSNs were "set and verified live"; neither was true. Corrected below.*

**Done:** A (all) · B1 · B2 · B3 · **B5 (shipped 2026-08-11, click-through +
clustering 2026-08-20)** · B6 · B7 · B8 · B10 · B11 · **C1 (enforced
2026-08-10)** · **C2 (opt-in enrolment + DB-level enforcement, hosted
2026-08-11)** · C6.

*C1 moved up from "Partly done" on 2026-08-10, as the bullet standing there
asked. Framing is enforced twice now — `X-Frame-Options` and the policy's own
`frame-ancestors`. **IMPROVEMENTS C1 owns the evidence and the rollback**, which
is one word: `CSP_HEADER` in `lib/services/csp.ts`.*

**Partly done:**
- **B4 documents** — viewing confirmation SHIPPED 2026-08-09 (migration 0027,
  `viewing_confirmation` doc type, hashed + evented). Reservation agreements and
  mandate renewals deliberately NOT built: they are contracts, and inventing
  Cyprus legal text is not an engineering decision. **Blocked on supplied wording,
  not on code** — the pipeline is proven, each is then an afternoon.

**Open, needing an operator decision (not engineering):**
- **Get a backup off this machine — STILL OPEN 2026-08-10, and this is the
  highest-value item on the list.** A current archive is built and verified at
  both levels: **`gnk-backups-offsite-2026-08-23.tar.gz` (11.5 MB, all 18 sets,
  1100 entries), sha256
  `9919ffb3a619c200c87b8787deccb50303f7c2c4d5fdd33b3add62051008c078`** — rebuilt
  2026-08-23 because the 08-10 one had fallen thirteen nightlies and six
  migrations behind, and the 08-10 archive was then deleted after confirming it
  was a strict subset. **An uncopied archive still ages.** **The
  operator will copy it to a USB drive; that had not happened yet when this line
  was written, so every backup is still on one machine.** Verify at the
  DESTINATION — a checksum taken here proves nothing about what arrived. **It is
  the only archive on `D:`** — the 08-07 and 08-09 ones were deleted 2026-08-10
  after confirming both were strict subsets, so there is no question which file
  to copy.
- ~~**B5 map** — tile provider is a spend + ToS call.~~ **DECIDED AND SHIPPED.**
  OpenFreeMap: no account, no key, no payment, commercial use allowed. The CSP
  half was the real risk and it was handled — `https://tiles.openfreemap.org` is
  on `img-src`/`connect-src`, and an E2E asserts zero violations, because
  deleting that line blanks the map in production silently.

  **A caution worth more than the decision:** on 2026-08-20 this feature was
  declared broken, its link hidden from users, and two of its tests disabled —
  all on measurements taken through a hidden browser tab, where
  `requestAnimationFrame` never runs and no map can render. It had been working
  the whole time. `docs/ENGINEERING_NOTES.md` §7 owns that trap; BACKLOG keeps
  the struck entry as the cautionary tale.

- **`gerasimos@` has no 2FA** — reviewed 2026-08-09, kept as admin deliberately,
  and **that decision is now load-bearing rather than pending**: C2's DB-level
  enforcement went live 2026-08-11 and the opt-in template means he is never
  gated, so he is the account that still gets in if the enrolled admin is locked
  out. Confirmed on hosted the day it landed: 2 admins, 1 verified factor
  (`nontari@`), 0 factors on his. **If he ever enrols, the safety net closes** —
  make sure a second recovery path exists first.

~~**Staged, proven, NOT applied — `0032`.**~~ **APPLIED TO HOSTED 2026-08-20**
via §3. See §1 for the evidence; `rls_bare_auth_calls()` returns 0 rows and the
advisor's `auth_rls_initplan` fell 23 → 12, the remaining 12 being the config
tables 0030 excluded on purpose.

**Next engineering work, in order:**
1. ~~**C2 DB-level 2FA enforcement**~~ — **DONE 2026-08-11, and moved to the Done
   line above** as the bullet here asked. §6 and IMPROVEMENTS C2 own the state
   and the evidence; the rollback is in `docs/superpowers/plans/`.
2. ~~**Sentry source maps + release**~~ — **SHIPPED `70e4ceb`.** This line said
   "stacks are currently minified and issues carry no release" after both had
   been fixed. What is left is not a build change but **one observation, and it
   cannot be scheduled**: read the top frame of the NEXT genuine client error. A
   path like `components/features/…` means the maps match the deployed bundles;
   another `chunks/44sdjkbb-9351.js` means they do not and this reopens. BACKLOG
   owns it and explains why manufacturing an error was rejected.
3. **THERE IS NO DECISION-FREE ENGINEERING WORK LEFT.** This line used to point
   at "the remaining CSV exports"; **all six shipped 2026-07-24** and BACKLOG had
   said otherwise for 18 days — checked 2026-08-11 by globbing
   `app/**/export/**/route.ts` before writing any code. What BACKLOG actually
   holds now: one perf item already built and awaiting a hosted apply (0030),
   two OPERATOR decisions (mandatory 2FA, nudge thresholds) and three
   informational notes. Read it, but check whether a thing exists before
   building it — three entries there described finished work.

**Standing decisions:**
- **Build nothing new — stabilise and let the desk use it** (2026-07-29). Still
  true: `share_links` 2, `tasks` 0, `deals` 1, all operator test data.
- **B9 closed, not deferred** — the desk works in English.
- **The `execute_sql` permission entry stays** (§3), deliberately.
- **Sentry is configuration, not code.** `SENTRY_DSN` (server — error boundaries,
  the sign-in report, the key guard and the CSP handler all run server-side) and
  `NEXT_PUBLIC_SENTRY_DSN` (browser, and what puts the ingest origin into
  `connect-src`). The server one was MISSING until 2026-08-09 and everything
  server-side reported nowhere. Both set now, delivery and alerting proven by
  probe. `tracesSampleRate` 0.1.

---

## 6. Known gaps

- ~~**CSP is still Report-Only.**~~ **ENFORCED 2026-08-10**, after the nonce
  collision was root-caused and fixed. `report-uri`/`report-to` stay in the
  policy, so a blocked violation is still *reported* — the Sentry signal does
  not go quiet now that the policy bites. The ~1h Vercel log-retention trap
  still applies to anyone grepping stdout rather than reading Sentry: **empty
  must not be read as clean**. Rollback is one word: `CSP_HEADER` in
  `lib/services/csp.ts`. IMPROVEMENTS C1 owns the evidence.
- ~~**2FA is enforced at the application layer only.**~~ **CLOSED — 0029 APPLIED
  TO HOSTED 2026-08-11.** `require_aal2` on all 29 RLS tables, so an `aal1`
  session belonging to a user WITH a verified factor is denied every table: a
  stolen `aal1` JWT hitting PostgREST directly now reads nothing. **A user with
  no verified factor is untouched** (the opt-in template) — deliberate, and what
  keeps an unfactored admin usable as the lockout safety net. Verified on hosted:
  29 policies all correctly shaped, coverage empty, `anon` cannot execute the
  predicate, `get_advisors` clean, chain verifies, 74 events. The application
  half was proven first — `mfa.spec.ts` enrols a real factor and shows the
  password alone no longer gets in, green in a full cold suite run — so a user
  who loses a device can still re-enrol. **IMPROVEMENTS C2 owns the evidence;
  the rollback loop is in `docs/superpowers/plans/`.**
  **One acceptance check remains and it is the operator's:** sign in as the
  enrolled account, pass the TOTP challenge, load a real page. Everything
  verified so far is database-level, and an RLS denial returns zero rows rather
  than an error — so "no data" and "correctly denied" look identical in the UI.
- ~~**The E2E suite is flaky in most CI runs and the cause is not known.**~~
  **FIXED 2026-08-11 by switching CI off `chrome-headless-shell` —
  `channel: "chromium"` in `playwright.config.ts` (`7f420e5`). Measured 0 of 5
  sampled runs crashed, 0 flaky, 177 passed every time**, against baselines of
  3 of 6 before any change, 3 of 5 with the GPU flags, 4 of 5 with `/offline`
  fixed. That is the first time the whole suite passed on first attempt.

  **A workaround, not a root cause.** It establishes that the shell binary
  crashes and the full one does not; nobody has explained WHY it dereferences
  null at a fixed address. A Playwright upgrade could make it unnecessary or
  reintroduce the crash elsewhere — re-measure, do not assume. **`retries: 1` is
  now absorbing nothing known, so it is a real safety net again rather than a
  silencer.** The habit still earns its keep: `grep -c flaky` a job log before
  treating a green tick as a clean run.

  **The history is worth keeping, because two shipped fixes were wrong.**
  chrome-headless-shell died with `Received signal 11 SEGV_MAPERR 0000000001b0`
  — always that identical address, so a deterministic code path, not memory
  pressure. 0–4 times per run, most runs affected. The browser being gone, the
  NEXT test to ask for a context failed with `browser.newContext: Target page,
  context or browser has been closed`, and that was `security.spec.ts` purely
  because `pwa` sorts before `security`. **Its anonymous-visitor loop was a
  bystander** — the earliest version of this entry blamed it. No app fault was
  ever indicated, and the retry always passed.

  **TWO HYPOTHESES WERE SHIPPED AND BOTH DISPROVED. Read this before forming a
  third.**
  1. *GPU init* (`3761b89`, since reverted). The crash is preceded by
     `drmGetDevices2() has not found any devices` and a `gpu-process` sandbox
     warning, so `--disable-gpu --disable-software-rasterizer` was added for CI.
     The flags provably applied and the warnings stopped; 3 of 5 sampled runs
     still crashed.
  2. *The `/offline` CSP violation burst* (`e24e452`, kept — see below). In 4 of
     4 crashes, all 20 console lines before the signal came from
     `http://localhost:3000/offline`, whose scripts were all refused. Giving the
     page a nonce took violations to **0** — and **4 of 5** sampled runs still
     crashed.

  **Both wrong answers were reached the same way:** "X appears immediately before
  the signal in N of N crashes" was read as causation, when it only ever showed
  what sat in the log buffer at the moment of death. A fixed fault address inside
  a vendored binary points upstream, at chrome-headless-shell 1228 (Playwright
  1.61.1), rather than at anything in this repo.

  **What finally worked was treating it as an experiment with a bar to clear,**
  not a third theory: swap the binary and measure. 5 samples via `gh run rerun`
  (which re-runs a commit without redeploying) — 0 of 5. **Anything that does not
  come with a sample count is not an answer**; that is the transferable part,
  because the two wrong fixes each looked convincing and each shipped.

  `e24e452` STAYS despite its stated reason being disproved: a page whose every
  script is refused is a defect regardless of what crashes, nonce coverage is now
  uniform, and the pointless CSP reports stop. §0 records `/offline` as "not a
  blocker after all (static text, 0 interactive elements)" — true for usability,
  and this was the cost that came with it.
  **Production `/offline` also blocked every one of its own scripts and filed a
  CSP report for each — but the report VOLUME was almost certainly ~0, not a
  stream.** Per view the cost is ~20 `Sentry.captureMessage` calls from
  `app/api/csp-report/route.ts`; the number of views is the missing factor, and
  Vercel runtime logs for the 24h to 2026-08-11 18:00 hold **2 lines in total**
  (`/login` and `/`, both from that afternoon's own smoke check). No traffic, so
  no reports. **Sentry confirms it: there are NO `/offline` CSP reports.** The
  `[csp]` issues that exist name a different path — `[csp] script-src-elem
  blocked …/chunks/43nlpkxvny-py.js on /settings/organization` and the same on
  `/login` — i.e. the pre-`force-dynamic` static-prerender bug `T-prod-day` fixed
  on 2026-08-09, not this one. All resolved, and **zero new violation reports in
  the ~12h after enforcement went live** (checked 2026-08-11 06:18 in the "Sentry
  errors review" session; org `gn-kalaitsidis-capital-ltd`, project
  `4511848276951120`). Two independent lines of evidence agree, which is the only
  reason to believe it: no traffic in the Vercel logs, and no such issue in
  Sentry. Second-hand and bounded, though — that was another session's query, and
  it enumerated recent issues rather than proving a 90-day absence. **Sentry
  cannot be queried from a dev machine at all:** `SENTRY_DSN` and
  `SENTRY_AUTH_TOKEN` are present in `.env.local` as EMPTY keys, the real values
  living only in Vercel. Search `"[csp]" "/offline"` to re-check; the message
  format is `[csp] <directive> blocked <uri> on <path>`. Note that ~1h Vercel log
  retention means an empty log query is never evidence of a clean state on its
  own — the 2-line control count above is what made it meaningful. Turning flake into a hard failure was tried the same day and reverted;
  the reasoning is in `playwright.config.ts` where the option used to be.
- **B8 does not queue writes.** Offline slip signing was considered and
  rejected: it would put commission evidence in a client-side queue.
- ~~Playwright does not run in CI~~ — **fixed 2026-08-04**, and it caught a real
  CSP-breaking `eval` on `/share-links` on its first run (§8, DECISIONS
  `T-share-links-eval`).

---

## 7. Environment traps

**Vercel**
- **Env vars are PER-ENVIRONMENT, and "set for Preview only" is
  indistinguishable from "not set".** Cost six deployments on 2026-08-03. When a
  value does not appear in production, check the environment ticks *before*
  suspecting the save or the build.
- **`NEXT_PUBLIC_*` is compiled in, so changing one needs a new BUILD, not a new
  request — and installing an integration does not trigger a redeploy either.**
  Checking production immediately after either change always shows the old state
  and is not evidence of failure. Push a commit, then check.
- **The dashboard can silently swallow every action** (a full-screen 2FA
  interstitial did it on 2026-07-31). Verify by the row's date changing and a new
  deployment appearing — never by the click seeming to land.
- **Do not poll a production domain in a tight loop.** ~80 requests over ten
  minutes triggered the firewall: every response became `403`
  `X-Vercel-Mitigated: challenge`, which looks exactly like an outage. Real users
  are unaffected (a browser solves the JS challenge). Wait on
  `get_deployment().state` instead. Polling a deployment's own `*.vercel.app`
  URL for a 200 never works anyway — `ssoProtection` is on for
  `all_except_custom_domains`.
- **Diagnostic that beats reasoning:** when two adjacent `NEXT_PUBLIC_*` reads in
  one function behave differently (Supabase inlined, Sentry not), the difference
  is the *environment*, not the build — it eliminates cache, bundler and
  framework in one observation.
- Logs: `get_runtime_errors` and `get_runtime_logs` with
  `group_by: statusCode|requestPath` are fast; full-text `query` tends to time
  out — scope to a `deploymentId` or a narrow window.

**Supabase / local stack**
- **`supabase login` may never persist a token** (nothing in `~/.supabase` or
  Credential Manager) — even `login --token`. `db dump` / `db push` are then
  unusable; `--db-url` needs neither `login` nor `link`.
- **`npx supabase stop` can drop the local volume.** After any stop/start check
  `select count(*) from supabase_migrations.schema_migrations` and `db reset` if
  empty. After a reset PostgREST's schema cache can be stale (`Could not find the
  table 'public.organizations' in the schema cache`); it clears on the reset's own
  container restart, otherwise reset again.
- A silent local-stack `fetch failed` returns `data: null`, which reads exactly
  like an empty table. **Always print `error`.**
- Docker Desktop is sometimes fully down, not just flaky.
- `document_type` has no `id_passport` — it is `id_document`.
- Supabase `signOut()` defaults to **global** scope.

**Machine**
- **Do not `rm -rf .next` or build while a dev server is running.**
- **A leftover `next start` on :3000 makes the whole app non-hydrating, and the
  E2E suite reuses it without saying so (2026-08-11).** `playwright.config.ts`
  has `reuseExistingServer: true` and only checks that *something* answers the
  base URL, so the suite runs against whatever holds the port. A `next start`
  left from a prod check serves the manifests it cached at boot; a later
  `npm run build` replaces `.next`, the content-hashed chunk names move, and the
  old server then 500s (`text/plain`) for exactly the chunks that moved —
  including the Turbopack runtime. Every page SSRs perfectly and **nothing is
  interactive**, with no application error anywhere to explain it. Cost an A/B
  bisect across two branches that wrongly implicated migration `0029`.
  **Tell:** a click that does nothing, plus `Refused to execute script … MIME
  type ('text/plain')` in the console. **Confirm:** `Get-CimInstance Win32_Process
  -Filter "ProcessId=<pid on 3000>"` — a command line reading `next start` is it.
  **Fix:** kill it, `npm run dev`. Full mechanism in DECISIONS
  `T-e2e-cold-server`.
  - **GUARDED 2026-08-11 — the suite now refuses to run against one.**
    `tests/e2e/server-health.ts`, first test of the `setup` project: it requests
    every `<script src>` that `/login` asks for and aborts unless all come back
    `200` JavaScript (stale server measured at 2 of 16 → `500 text/plain`,
    healthy `next start` 16 of 16, healthy `next dev` 28 of 28). It prints the
    diagnosis and the kill-then-`npm run dev` commands, so you should not have to
    come back to this bullet. `reuseExistingServer: true` is deliberately KEPT —
    `ci.yml` depends on it — and the guard checks *what* is being reused instead.
    Skipped only when `E2E_BASE_URL` is not local.
  - **Do NOT build a check on `.next/BUILD_ID` appearing in the served HTML.**
    This bullet used to offer that as a second tell, and it is only true of
    `next start`: `next dev` writes no `BUILD_ID` (dev output lives in
    `.next/dev`, and the id on disk belongs to the last production build), so a
    HEALTHY dev server has 0 occurrences too — measured 2026-08-11. Gating on it
    would fail every local run. The chunk statuses are the reliable signal.
- **E2E `setup` spends minutes compiling routes on a cold dev server** — 4.6m
  observed 2026-08-11. It is warming, not hung: a local run is `next dev`, which
  compiles per route on first request (43s for `/login/verify`, and one
  `/properties/<id>` warm-up swung between 21s and 130s across runs). CI builds
  and serves `next start`, so it never pays this. Why it is done there, and why
  the local budgets are scaled to match, is commented in
  `tests/e2e/auth.setup.ts`, `tests/e2e/helpers.ts` (`opTimeout`) and
  `playwright.config.ts`.
- **A shell left `cd`'d into a directory locks it on Windows**, so an emptied
  directory may refuse to disappear. `git worktree remove` can fail this way —
  prune, then remove with PowerShell. (This bit the 2026-08-07 move: robocopy
  relocated every file but could not delete the source root, because the live
  session held it as cwd.)
- **The working tree lives on `D:\dev\TSOPOZIDIS` (moved 2026-08-07).** It is no
  longer under OneDrive — which also means no cloud copy of anything untracked,
  `gnk-backups/` included. See §3.3: the off-site gap is now wider, not narrower.
- **Disk runs tight, and a FULL disk truncated a tracked file to 0 bytes
  (2026-08-07).** `C:` hit 100% mid-session while a full Playwright run was
  going; the next `pathlib.write_text` on `HANDOFF.md` truncated it and then
  failed with `OSError: [Errno 28]`, leaving an empty file. Recovered with
  `git restore` — nothing was lost only because the file was committed.
  - **`.next` is the bulk: it reached 3.6 GB.** `tests/.playwright-output` and
    `-report` were 9 MB combined, so clearing them buys nothing; `.next` is the
    one worth deleting. Stop the dev server first (see above).
  - **Write files atomically when the disk may be tight** — temp file plus
    `os.replace`, not a direct `write_text`, which truncates before it writes.
  - **`npx playwright test` (full desktop) locally is what filled it**, because
    the run builds `.next` for `next start`. **This is no longer a constraint**:
    on `D:` the full suite ran 2026-08-08 in 6.4 minutes (168 passed / 4
    skipped) with `.next` at 2.29 GB and `C:` never moving off ~22 GB free. A
    local `supabase db reset` cycle is affordable again too — which is how the
    `csp.spec.ts` run-1 proof finally got taken (DECISIONS 2026-08-08).
  - **`git status` after a local full run: `tests/screenshots/*.png` are TRACKED
    and `modules.spec.ts` overwrites all 12 with whatever your local database
    looked like.** Run the suite right after a `db reset` and they silently
    become pictures of an empty app — `leads-desktop.png` halved, 207 KB → 102 KB
    — which is a downgrade, not a change, and it will ride along in your next
    `git add -A`. **It goes the other way just as easily**: on 2026-08-10, run
    against a stack that had been up two days, the same file went 207 KB →
    525 KB. Bigger is not better here either — both directions are unintended
    churn in tracked files from a run you did for some other reason. They are
    report artifacts, not a `toHaveScreenshot` baseline, so nothing fails; just
    `git checkout HEAD -- tests/screenshots/` unless you deliberately want to
    refresh them.
  - **Killing a backgrounded `npm run dev` leaves `next dev` alive, and Playwright
    will then reuse the wreckage.** `playwright.config.ts` sets
    `reuseExistingServer: true` against `npm run dev`, so a half-orphaned server
    on :3000 gets adopted by the next suite run. Symptom (2026-08-08): four
    unrelated specs failed — `happy-path` step 4, both anonymous `share-links`
    tests, one `csp` public-route test — and the page snapshot showed Next's
    **"Jest worker encountered 2 child process exceptions, exceeding retry
    limit"** overlay rather than any assertion problem. Nothing was wrong with the
    code; the same suite passed 170/174 minutes later on a clean server. Before
    trusting an E2E failure, check :3000 has no leftover owner — `next dev` prints
    its PID in the "Another next dev server is already running" message, and
    `Stop-Process -Id <pid> -Force` clears it. A stray dev server looks exactly
    like a real regression.
  - **Do not run `test:rls` and `test:e2e` at the same time — they share the
    local database.** TEST-1 gave the RLS suite its own fixture *org*, not its
    own database, and the E2E suite writes to that same org. Running them
    concurrently on 2026-08-09 produced a **1 failed / 30 passed** RLS result
    while an E2E fixture (a deactivated profile) happened to exist; the same
    suite was 31/31 the moment it ran alone. HANDOFF §2b already lists "a test
    can depend on the absence of residue" — this is the same hazard arriving
    from a neighbouring process rather than a previous run. Sequence them.
  - **The move to `D:` fixed the build-artifact half of this, not the disk.**
    `.next`, `node_modules` and Playwright output now land on D: (123 GB free).
    But `C:` was measured at **830 MB free of 222 GB** and the repo was only
    0.8 GB of it — the move reclaimed under a gigabyte. What actually fills C:
    is `Outlook.pst` (55.8 GB) plus `archive.pst.corrupt` (11.4 GB) — user mail
    data, leave it alone — and Docker's `docker_data.vhdx` (20.7 GB) under
    `%LOCALAPPDATA%\Docker\wsl\disk\`, which regrew on every `supabase start`.
  - **Docker's disk image was moved to `D:\docker\disk` the same day, and that
    is what actually fixed C: — 0.83 GB → 22.58 GB free.** It is a **directory
    junction**, not a Docker setting: `mklink /J "%LOCALAPPDATA%\Docker\wsl\disk"
    "D:\docker\disk"`. The documented-looking `DataFolder` key in
    `%APPDATA%\Docker\settings-store.json` is silently ignored by Docker Desktop
    4.85 — it kept the key *and* built a fresh empty disk at the default path.
    If Docker ever reports 0 images, check that the junction still exists before
    assuming data loss; the real vhdx is on D:. Images/volumes verified intact
    after the move (28 images, `supabase_db_gnk-crm` volume present).

---

## 8. Verify state

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

```bash
npm run test:rls
```

```bash
npx playwright test --project=setup --project=desktop
```

Expect **437 unit · 30 RLS · 168 E2E passed, 4 skipped** (`--list` counts 172,
including self-skips and the `setup` project). A freshly reset DB is a clean
first run — the `csp.spec.ts` detail tests seed what they need.

**What CI covers — all three jobs:**
- `checks` — typecheck · lint · unit · **build**. Takes **no secrets on purpose**:
  `npm run build` exits 0 with no `.env` at all (verified). If it ever needs
  them, something has started reaching the database at build time; investigate
  that rather than adding them.
- `rls` — the RLS suite against a real Supabase stack.
- `e2e` — **added 2026-08-04.** Desktop Playwright against a real stack **and a
  production build**. ~8 min, so pushes are slower; if that becomes a problem the
  lever is scoping it to `pull_request` + `main` rather than every push.

**The `e2e` job runs `next start`, NOT `next dev`, and that is load-bearing.**
`lib/services/csp.ts` ships `'unsafe-eval'` under dev, so `script-src`
violations are **invisible** there. On its first run this job caught a real one
(`/share-links`, DECISIONS `T-share-links-eval`) that had been live for six days.
`playwright.config.ts` sets `reuseExistingServer`, so the job starting the server
means Playwright reuses it instead of launching `npm run dev`.

**Unlike `checks`, `e2e` needs Supabase env** — the app must actually reach a
database. It exports the local stack's well-known demo values from
`supabase status -o env`; those are not secrets and never production credentials.

**Confirm a CI step actually RAN** before trusting a green tick:

```bash
curl -s "https://api.github.com/repos/KALAITSIDIS/gnk-crm/actions/runs/<RUN_ID>/jobs"
```
