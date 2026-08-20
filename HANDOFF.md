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
| `main` | **in sync with `origin/main` as of 2026-08-20** — four B5 commits that day, all pushed, CI green (`checks` · `rls` · `e2e`), `origin/main..HEAD` = 0. Verify rather than trust: `git status -sb` and `git log --oneline origin/main..HEAD`. The standing agreement is still **commit, don't push**; each push that day was asked for explicitly. **LOCAL IS NOW ONLY `main`** (2026-08-20): five merged branches were deleted, `fix-map-blank` among them — its message asserted a root cause that turned out to be wrong, and a stale branch is a claim someone will read. Two remote branches remain, `origin/exp/chromium-channel` and `origin/fix/ci-chromium-gpu-segv`. `git branch -vv` and `git branch -r` are the answer, not this cell. (SHA: `git log --oneline -1` — deliberately not pinned here, it went stale on every commit) |
| CI | ✅ green — `checks` (typecheck · lint · unit · **build**) + `rls` |
| Production | `gnk-crm.vercel.app` healthy; **auto-deploys every push**. **Functions run in `fra1` (Frankfurt), pinned in `vercel.json` 2026-08-20** — same region as Supabase `eu-central-1`. They ran in `iad1` (Washington DC) until then, so every request crossed the Atlantic; co-locating made all routes ~3x faster (ENGINEERING_NOTES §8). **`X-Vercel-Id` reads `<edge>::<function>` — check the SECOND field if latency ever looks structural again.** Verified 2026-08-20 after the Next 16.3.1 + region changes: 9 authenticated routes 200 with expected content, 0 runtime errors and 0 5xx in 6h of production logs. **A cache-restored build can keep an OLD `NEXT_PUBLIC_*` value compiled in — see §2b, it caused a login outage on 2026-08-09.** |
| Hosted DB | `yjgirvzgoiywdojnpkpd` — **33 migrations, latest `0033` (applied 2026-08-20)**, `non_filename_versions` = 0, **75 events**, 2 properties (1 with exact coordinates), 5 district + 10 area centroids — all MEASURED 2026-08-20. `non_filename_versions` = 0 and chain-verifies were last checked 2026-08-11 when 0031 was applied, not re-run since. **DB-level 2FA is LIVE** — `require_aal2` on all 29 RLS tables, IMPROVEMENTS C2 |
| Data | `share_links` 2 (1 live, 1 revoked) · `tasks` 0 · `deals` 1 · **all of it operator test data** (§0) |
| Tests | **518 unit** · **48 RLS across 4 files** (was 44/3 — migration 0030 added `rls-hoist.test.ts`; re-read from CI run `31568922881` on 2026-08-11. The "12 mandatory tests, doc 04" in the job name is a subset, not the total) · **181 desktop E2E, 0 skipped** — 183 results in total, because the `setup` project holds two tests: the stale-server guard and the login. Counts from `--list` on 2026-08-20; the suite last PASSED in CI run `32157440627` that day. Two of those tests spent part of 2026-08-20 marked `test.fixme` against a map that was never broken — see §1. Full desktop suite measured from a COLD dev server on 2026-08-11, 0 failed, 0 flaky. All three run in CI. Re-running E2E rewrites the 12 tracked `tests/screenshots/*.png` — §7 |
| Cron | `expire-mandates 03:00` · `followup-nudges 03:15` · `verify-events-chain 03:30` |
| Backups | ✅ **`2026-08-10` is the primary** — newest automated set, `verified:true`, `problems:[]`, 55 files, **events inDump 74 = live 74**, written to `D:\dev\TSOPOZIDIS\gnk-backups`. `2026-08-06` is the restore-*proven* one (all 73 event hashes byte-identical to production). Sets: 07-30 · 07-31 (Storage) · 08-04 (superseded) · 08-06 · 08-07 · 08-08 · 08-09 · **08-10**. Nightly ran 03:46 on 2026-08-10, verified. **STILL SINGLE-MACHINE — a current off-site archive is built and waiting to be copied to USB, §3.3** |

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

**Moving it is operator-only** — no off-machine destination is agent-reachable,
and it must not become one casually: it carries `auth.users` bcrypt hashes plus
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
and this is an aggregate rectangle, not an address or a person. **The fix is one
line if it is ever wanted** (`revoke execute on function
public.st_estimatedextent(text,text,text) from anon;` and its two overloads); the
app never calls it. Not applied unilaterally: production DB changes go through
§3's apply-and-verify, and this did not warrant waking that up.

**`GNK-PAF-0002`** still wants archiving **via the UI button** so
`archiveProperty` writes its event.

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
  both levels: `gnk-backups-offsite-2026-08-10.tar.gz` (4.17 MB, **all 8 sets**,
  390 entries), sha256
  `a6360d1123975cf6b330d2240413cdfa8b1c831c7e2c3ae929a4c5fd251550ca`. **The
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
