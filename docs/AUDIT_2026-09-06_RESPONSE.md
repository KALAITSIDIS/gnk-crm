# Response to the external audit of 2026-09-06

**Status:** re-audited 2026-09-06 against current `main` (gnk-crm `c5b5b6f`, gnk-web `8239085`) and the live site and feed. The audit reviewed gnk-crm `66e1f8e` and gnk-web `5f7d17d`; both moved on 09-05/09-06 (DECISIONS `T-close-of-day`, `T-deferred-sweep`), and several of its findings were fixed before it arrived.

**Progress (2026-09-06, evening).** Now #1 done (galleries removed through the CRM, evented, feed at 0 images on both). Now #2 done: 0087 merged, route deployed on the admin client, then applied on hosted and verified (anon refused, service_role kept, currency CHECK validated); 87/87. Now #3 shipped and live (one `<JsonLd>` sink, gnk-web `cc909c7`). Now #4 merged (`ef05293`; erasure over explicit steps, storage removal that verifies, `redactLead` for the enquiries erasure could not reach). Now #5 merged and live (gnk-web `80d9195`; the site reads every feed page, the sitemap is whole or absent). Now #6 merged (`5d8fc58`; `--text-3` #667085 at 4.97:1 / 4.68:1, doc 06 bound to `globals.css` by `palette-parity.test.ts`). Now #7 merged (`0e67338`; DECISIONS `T-etag-from-body` — the validator is sha256 of the bytes sent; `public_listings_etag` STAYS as the first segment because gnk-web compares it across pages, so the round-trip count in the row above did not fall; live: `W/"<snapshot>-<digest>"`, 304 on a match at both the edge and the function). Now #8 merged (lockfile `a48f47b`, 0 vulnerabilities on production dependencies; the CI step is on both mains — gnk-crm's through the upload page as `d8dcb44`, because the local token cannot push a workflow file; DEP-2 retired in HANDOVER). **Now is complete.** Next #1 merged and live in both repos (CRM `cb56df0`, site `467dabd`; DECISIONS `T-forwarder-proof`; both deployments READY with the secrets present, `OPTIONS /api/public/enquiries` 204, the legal page's new wording live — not proven by posting, by design). Next #2 merged and live (site `8657901`: one `pricing`, one `bedroomsOf`, one `CURRENCY`; JSON-LD rewritten once — the live PAF0001 page carries `mainEntity` SingleFamilyResidence, a Sell offer and `numberOfBedrooms` 3; rentals, `sale_or_rent` and studios pinned before any publishes). Next #3 on `feat/price-bracket`: a bracket with no transaction chosen is `or(and(asking…),and(rent…))` — one figure must satisfy both bounds; list, export and map share the function; the A09 shape is the mutation the test refuses. Next #5 on `feat/paged-reads` (branched on #3): one `fetchAll` (`lib/supabase/fetch-all.ts`) pages every read that used to stop silently at PostgREST's 1,000 and throws on a failed page — the active requirements behind both alerts, the repriced-unit read, the mandate exclusion and the quality worklist all read it; the alert hooks now surface a failed read to their callers' error log instead of answering "no matches"; both capped candidate fetches are `.order('id')` so the cap is the same 400 every time. `lib/testing/fake-client.ts` scripts pages per table for the tests; mutation-proven (swallowed error, one page only, rows-so-far on error). Next #5 merged (`80f208b`; deploy READY). Next #8 and #9 merged and live on the site (`65d4513`; verified on PAF0001: hero and og:image on the `_full` rendition, the WhatsApp text carries the listing URL, the bar renders `lg:grid-cols-5`, the 429 pass-through pinned by `app/api/enquiry/route.test.ts`; README § How fresh the site is, bound by `lib/freshness.test.ts`). Next #6 on `feat/optimistic-save` (DECISIONS `T-optimistic-save`; the E2E is the proof of the whole path). Next #7 on `feat/plans-private` (stacked on #6; DECISIONS `T-plans-private`; production had zero non-photo media rows, verified read-only, so nothing to move). Next #7 merged (`7af529ef`; production had zero non-photo media rows, verified read-only, so nothing to move). Next #4 on `feat/0088-feed-reference` — DECISIONS `T-feed-reference`: `p_reference` on the feed (one allowlist, the 3-arg overload gone), the composite `property_media` tenant FK, `content_sha256` and a shared-photograph WARNING that moves no points; RLS tests 57/58; gnk-web `getListing` reads one reference on `feat/listing-by-reference` (CI green). **Additive, so hosted applies BEFORE the merge.** With it the Next phase is complete except F3's container columns, which stay in Later until PAF0002's units are ready. Original plan text for this row: it is the one hosted apply, and it goes last so the day's schema change is one.

**Method.** Fourteen independent read-only verifications, one per claim group, each required to reproduce the claim at HEAD (grep, SQL, existing tests, public GETs), assign its own severity, and name the *binding* fix — one source, not a corrected copy — with effort and whether it needs a migration (the hosted apply is a manual path here). Then a synthesis. Nothing was written to production during the review.

**Verdict.** Of 71 checkable claims: **21 agreed, 18 partially, 18 disagreed, 14 already done** before the audit landed. The audit is good on mechanisms and consistently overstates severity and remedy for a two-person firm with three published listings. Its most serious finding is not in its security section: **two live client mandates were publishing another property's photographs** (live-ui-1) — the project's recurring failure, on the public site. That was actioned the same day.

---

## 1. What was already true before the audit arrived

| Audit item | Where it was closed |
|---|---|
| A10 — ETag blind to alt text | 0086 hashes `md5(alt)`; RLS test 56; hosted at 0086 |
| Image `is_cover` drift on the site | removed 611d2fb; `coverImage()` reads `images[0]`, the CRM's cover-first order |
| Development (container) facts in card / table / JSON-LD / search | withheld 09-05/09-06; `isContainer` is the one definition |
| Rental prices mixed into the search price ladder | `salePrice` / `matchesMaxPrice` 09-06 |
| Organisation JSON-LD from its own literals | derived from `lib/site.ts` 09-06 |
| Feed column allowlist unpinned | RLS test 41 pins all 36 against the generated types |
| Sitemap "should be dynamic" | `force-dynamic` since 09-05 |
| Feed offset paging on the CRM | already supported and `limit` is echoed; only the site's loop is missing |
| Trusted client-IP source; fail-open outage policy | already so; recorded in DECISIONS |
| Dark mode "unfinished" | a recorded product decision (doc 06, BACKLOG) — the audit tripped on the documented false positive |
| Branch / super-admin model | gated as C7 with a written trigger |
| Channels, matching engine, share links, PDF toolchain, MapLibre, el/ru copy | all exist; only public projections are missing, each gated |

## 2. Where this response disagrees

**Severity** (the audit's → ours, with the reason):

- **A01 anonymous RPC — P1 → P2.** Confirmed mechanism: `submit_public_enquiry` and `note_public_enquiry_hit` are EXECUTE-granted to `anon`; every control (rate limit, honeypot, email format, desk alert) lives only in the Next route. Bounded today because the publishable key is shipped to no browser, committed nowhere and absent from CI. **Reverts to P1 the moment any client-side Supabase call appears.** Fixed this week regardless.
- **A03 cross-org media — P1 → P3 with a hard gate.** One organisation exists; every PostgREST-capable insider is a principal. The composite FK **must precede the second `organizations` row**.
- **A04 erasure — P1 → P2.** Every defect is a failure-path defect; no erasure has run on real data; under two days to close.
- **A06 two-commit saves — P2 → P3.** The `asking_price` leg is already atomic via trigger; the window is a dropped connection between two round trips on a two-person desk.
- **B02 first-100 — P1 → P2.** Three listings live; the cliff is at 101 — silent, so fix before growth, but not an outage.
- **live-ui-1 borrowed photographs — P1 stands**, as a content matter, not a rendering bug.

**Remedies rejected** (each with what replaces it):

| Audit remedy | Why not | Instead |
|---|---|---|
| Dedicated Postgres role + custom-signed JWT intake adapter | a new credential class, 2–4 days, buys nothing over a revoke for one function | revoke `anon`/`authenticated`; the route uses the server-only admin client |
| HMAC over timestamp+body for the forwarded visitor header | webhook-signature pattern for a capture point that does not exist between two Vercel deployments over TLS | a static shared forward key, compared with `timingSafeEqual` |
| Rotating HMAC for the IP hash | rotation only resets 15-minute counters | a server-only `IP_HASH_SALT` secret |
| Resumable erasure state machine | unearned for a rare, admin-only, five-write action | ordering + error propagation + idempotent re-run + one guarded storage helper |
| Per-section atomic RPC | needs a jsonb→columns mapping that is a second copy of the section schema | optimistic `updated_at` predicate now; RPC recorded as the 15th accepted instance |
| Signed URLs / private staging for all photographs | the site hotlinks the public bucket; moving objects on every visibility flip makes location a second copy of `visibility` | floor plans only → the private `documents` bucket via one `mediaBucketFor(kind)` |
| Scoring in SQL for matching | DECISIONS and `match-alerts.ts` reject a second copy of the rules | surface errors, page reads, deterministic order |
| Revision column + outbox + worker + signed webhook + reconciliation | for a site whose reconciliation *is* the 60s TTL | measure and state the freshness; an optional fire-and-forget hook later |
| Nonce CSP on the site | ISR forfeits last-good-copy; hashes cannot cover Next's chunks | the serialiser closes the class alone |
| Rejecting `<` in CRM validators | wrong layer; misses the service-role import path; "<100 m from the sea" is legitimate copy | escape at the one sink |
| A second public function for by-reference lookup | 0085's header records an allowlist copy silently dropping `images` | `p_reference` on `public_listings` — one allowlist |
| 0087 as specified (a fourth hashed segment over area/district names) | a hand-maintained mirror of the body's joins that has now drifted twice | derive the validator from the serialised body in the route |
| Rendering actual currency; ft²; `leaseLength`; `schema-dts`; composed OG card with a price; portal adapters; branch model; splitting files by line count | each either invents data, copies a fact, or serves a firm this is not | see §5 |

## 3. Now — this week (≈ 5.7 engineering days)

| # | Item | Effort | Migration | Acceptance |
|---|---|---|---|---|
| 1 | **Borrowed galleries** (PAF0003, PAF0004 published PAF0001's six photographs, byte-identical) — removed via the CRM's own delete action on 2026-09-06 with the operator's approval; both now render "Photography to follow". Firm still owes: real photographs at ≥1600 px wide, two principal names/roles/bios/portraits (`lib/site.ts`), and the stale HANDOFF pointer "PAF0001 needs only photos". | 0 | no | feed `images[0].card` hashes differ across the three; `/about` shows two real names |
| 2 | **Migration 0087 — the enquiry door.** `create or replace submit_public_enquiry` resolving the reference FIRST and writing only the canonical reference (or null) into `criteria` and the immutable event (A05); **revoke** EXECUTE from `anon`/`authenticated` on it and on `note_public_enquiry_hit`, keep `service_role` (A01); rider: validated `CHECK (currency = 'EUR')` on `properties` (B03-b). Route switches to `createAdminClient()`; the route header and `lib/supabase/public.ts` comment stop claiming anon reaches two functions; restore-pack grant pins flip and the "eight rows" comment becomes six; RLS test 55 expects `anon.rpc` to be refused and proves the probe email never reaches the event. **Deploy the route BEFORE applying the migration** — reversed order, because `service_role` already has EXECUTE. | 1.75 | **yes** | `has_function_privilege('anon', …) = false` on hosted for both functions; `payload->>'listing_reference'` is canonical or null for a crafted reference |
| 3 | **One `<JsonLd>` component** — `serializeJsonLd` escapes `<` as `<`; the only file allowed to contain `application/ld+json` or `dangerouslySetInnerHTML`, guarded by a comment-stripping source scan; three call sites (B01). | 0.25 | no | a `</script>` fixture round-trips as data; grep for the sink returns exactly one file |
| 4 | **Erasure that means it** (A04): check every basis read (never compute AML basis from a failed read — today a failed read *destroys* documents that must be kept); reorder so `erased_at` is the last write before the event; idempotent re-run (refuse only when `erased_at` is set *and* a `contact.erased` event exists); one `removeObjectsOrFail` helper asserting `data.length === paths.length`, guarded repo-wide by a source scan; a `redactLead` action for unlinked website enquiries, which today have no delete policy and no sweep while the legal page promises deletion. | 2 | no | six injected failure points each leave `erased_at` null or re-run to one event; a bare `storage.remove(` anywhere in `lib/` fails CI |
| 5 | **Page the feed** (B02b): `getListings` loops on `offset`, stops on a page shorter than the CRM's *echoed* `limit` (delete the site's own literal 100), any failed page ⇒ `{ok:false}`, dedupe by reference, compare the ETag hash prefix across pages, cap at 50 pages. **Sitemap throws** on a failed feed instead of serving a complete-looking 200 of eight static URLs (B02-sitemap); its comment describing a build-time hazard `force-dynamic` removed goes. | 0.65 | no | a 250-row mocked feed yields 250; a mid-page failure yields `{ok:false}`; no literal `100` in `gnk-web/lib` |
| 6 | **Contrast** (live-ui-5): `--text-3: #98A2B3` (2.58:1 on white, 322 usages including error text) → `#667085` (4.97:1); doc 06 updated in the same commit with a test that reads the hex out of doc 06 and asserts it equals `globals.css`. No `next-themes`. | 0.3 | no | computed ratio ≥ 4.5:1 on both surfaces; palette-parity test green |
| 7 | **ETag derived from the body** (A10): the route already runs `public_listings` on every 200 — hash the serialised listings and answer 304 on match. A validator computed from the body cannot drift; the 200 path drops from three round trips to two. Discharges the "next migration must carry the 0087 area-rename segment" note in DECISIONS/HANDOFF without SQL; `public_listings_etag` and RLS tests 43/56 stay until a later migration retires it. | 0.5 | no | route test: ETag moves on an alt edit and on an area rename, stable otherwise |
| 8 | **`npm audit fix`** (never `--force`) in gnk-crm — two highs (browserslist, fast-uri) via `@sentry/nextjs`'s webpack plugin, build tooling Turbopack does not exercise; add `npm audit --omit=dev --audit-level=high` to both CIs; retire the DEP-2 rationale in HANDOVER.md. | 0.25 | no | 0 high in gnk-crm; the CI step exists and is green in both repos |

## 4. Next — before paid traffic or more listings (≈ 8 days)

| # | Item | Effort | Migration |
|---|---|---|---|
| 1 | **The site proves it is the forwarder** (A02): `x-gnk-forward-key` compared with `timingSafeEqual`; `budgetsFor` honours the visitor header only when trusted (third argument, unit-pinned: unsigned ⇒ `[5]`, forged ⇒ `[5]`, signed ⇒ `[visitor 5, transport 60]`, signed-and-equal ⇒ one budget of 5 — the double-charge dedupe); `IP_HASH_SALT` becomes a server-only secret (today the salt is the public project URL); the legal page's "identifies nobody" becomes what the code does. README's config table gains the row (its test already fails until it does). | 1 | no |
| 2 | **One `pricing(l)`, one `bedroomsOf(l)`, one `CURRENCY`** in `lib/format.ts`, read by label, per-m², search and JSON-LD; JSON-LD rewritten once — `offers` stay on `RealEstateListing`, dwelling facts move under `mainEntity` typed from `property_type` (`Apartment`, `SingleFamilyResidence`, `House`, `Place` for land/commercial, never `House` by default); rentals get an Offer with `LeaseOut` and a per-month `UnitPriceSpecification`; `sale_or_rent` two Offers; studios keep bedrooms 0 (B03-a/c/d, S4-a/b/c). Before the first rental or studio publishes. | 1.25 | no |
| 3 | **Grouped price bracket** in `applyPropertyListFilters` (A09): `or(and(asking…),and(rent…))` when both bounds are set; list, export and map share the one function. Before the first `sale_or_rent` listing. | 0.25 | no |
| 4 | **Migration 0088 — one hosted apply**: `p_reference` on `public_listings` (DROP+CREATE, one allowlist) and the site's `getListing` uses it; **composite FK** `(org_id, property_id) → properties(org_id, id)` on `property_media` replacing the single-column FK (A03) with a rolled-back mismatched insert proved in-migration and RLS test 58; `content_sha256` on `property_media` computed at upload, and the quality score / worklist withhold imagery points for a photograph whose hash appears on another property in the org — **warn, never block** (a development's units share exteriors); F3's computed container columns ride here if PAF0002 is ready. | 2.5 | **yes** |
| 5 | **Match-alert errors surface** (A08a): `activeRequirements` and the unit read throw instead of returning "no matches"; one paged `fetchAll` helper for requirements and the mandate exclusion; `.order('id')` on the capped candidate fetches. | 0.5 | no |
| 6 | **Optimistic predicate on section saves** (A06): hidden `expected_updated_at` from the row's own trigger-maintained column; `.eq('updated_at', expected)`; a distinguishable "changed since you opened it" error; "saved but not recorded" when the event insert fails after a committed update; `updatePropertySection` recorded as the 15th accepted `T-event-integrity` instance. | 0.5 | no |
| 7 | **Floor plans to the private bucket** (A07): `mediaBucketFor(kind)` at the four hardcoded `from("media")` sites; served via the existing signed-URL idiom; a one-off move of existing plan objects. Ask the firm whether plans are held under confidentiality — that decides P3 vs P2, not the fix. | 1 | no |
| 8 | **Small site fixes, one commit**: search grid to five columns when four controls render (live-ui-3); `heroImage(l)` = `full ?? card` for the hero and OG image (production `full` is 1024 px until the firm uploads larger originals); 429 + `Retry-After` passed through the site's enquiry route; listing URL appended to the WhatsApp prefill. | 0.5 | no |
| 9 | **State the measured freshness** (S1): three caches — CRM edge TTL 60s, site data cache SWR 60s, ISR SWR 60s — so under traffic a change shows within ~3 minutes and on a quiet site the first visitor after a lull is served the last render however old (5h20m observed). Written into README and HANDOFF and bound by a test to the constants. | 0.5 | no |

## 5. Later — on a named business trigger

| Item | Trigger | Effort |
|---|---|---|
| F3 — feed-computed container facts (`units_available`, `price_from`, `price_to`) from `container-units.ts`'s definition ported to SQL; the site prices a development from the computed figure, never the typed one | PAF0002's units ready to publish, or the first developer mandate | 2, migration |
| F1 — structured intake into `buyer_requirements` (`p_criteria jsonb` validated in SQL against the seven `BUYER_KEYS`; "create requirement from this lead") | ~10 web enquiries retyped, or ~20 listings | 2.5, migration |
| Enquiry retention arm (a third arm of the 03:15 sweep) | the firm confirms the period and whether enquiries are destroyed automatically | 1, migration |
| F4 — listing brochure PDF rendered from the feed's output only | the first request for one | 2 |
| F7 — public map on an **area-centroid** projection (never `location`) | ~10 listings across localities | 2.5, migration |
| F5 — el/ru routing with a Greek/Cyrillic-capable face | domain cut-over **and** a decision to market to el/ru buyers **and** translated legal pages | 4 |
| F6 / S8 — favourites + compare, URL-state search, lightbox, named enquiry card | ≥~15 listings; real galleries; principal names | 2.5 |
| A08(b)(c) — buyer-side pushdown, 2000-row paged candidates, anti-join for mandates | >300 matchable properties or a few hundred mandates | 1.5 |
| Composite tenant FK sweep on the nine sibling tables | before the second `organizations` row | 1.5, migration |
| S1 revalidate hook (fire-and-forget, HMAC, no outbox) | paid traffic, or a withdrawal that must vanish faster than a TTL | 1.25 |

## 6. Not now — and what would change that

Dedicated-role intake adapter (never for one function) · HMAC-signed forwarding (a third party forwards) · rotating IP-hash HMAC (never) · resumable erasure job (volume, or a recorded unrecoverable failure) · per-section atomic RPC (more than two operators on one section) · private staging for photographs (never; plans only) · scoring in SQL (never) · revision + outbox + worker (never at this scale) · 0087 as a SQL segment (only if the route-side validator is rejected) · nonce CSP (the site stops being ISR) · `<` rejection in validators (never) · multi-currency rendering (the firm trades outside EUR) · `leaseLength` (the CRM stores a term) · `schema-dts` (never) · dark mode (the firm asks) · splitting files by size (a feature next opens the file — then by command) · branch model (a second office) · follow-up sequences / SMS (measured >~20 leads/week **and** Phase 3 **and** a revised privacy promise) · composed OG card with a price (never) · portal syndication (licence numbers **and** a contract **and** Phase 5 — a lawyer's question first) · public shortlist service on `share_links` (never; own store at ≥~15 listings) · ft² (never) · generated locality pages (the firm writes them) · enquiry idempotency key (volume) · hard-blocking duplicate photographs (never) · saved views (never at two operators) · `overrides` for advisories (never) · a second by-reference function (never).

## 7. Migration sequence

| Number | Carries | Order |
|---|---|---|
| **0087** | enquiry door: resolve-first, revoke anon/authenticated, currency CHECK | route deploy **first**, then hosted apply |
| **0088** | `p_reference`, composite media FK, `content_sha256`, F3 columns if ready | hosted apply **before** merge (additive) |

The "next migration must carry the area-rename ETag segment" obligation recorded in DECISIONS `T-deferred-sweep` and HANDOFF is **discharged by Now #7** (validator derived from the body in the route) and should be struck when that ships.

## 8. Operator-owned, unchanged by any of the above

Real photographs for PAF0003 and PAF0004 (≥1600 px wide); PAF0002's title and description before it publishes; two principal names, roles, bios and portraits; the lawyer's view on Law 71(I)/2010 wording; the domain cut-over (`SITE_URL`); whether floor plans are held under confidentiality; the enquiry retention period.
