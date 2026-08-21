# BACKLOG

Nice-to-haves and deferred items noticed during the build. Nothing here gets
built without explicit direction.

> ## ⚠️ AN ENTRY HERE IS A CLAIM, AND CLAIMS GO STALE SILENTLY
>
> **Three entries in this file described work that had already shipped.** One had
> said so for **18 days** and sent a session on 2026-08-11 to rebuild the CSV
> exports — six routes, five query modules and seven E2E specs that had existed
> since 2026-07-24. It was caught by a `ls` before any code was written, not by
> reading. The others: database-level 2FA (shipped that morning) and the
> Settings → Users 2FA column (shipped two days earlier).
>
> **So: RUN THE `VERIFY:` LINE BEFORE YOU START ANYTHING.** Every entry that
> describes buildable work carries one — a single command whose output settles
> whether the work exists. If an entry has no `VERIFY:`, treat it as unverified
> and check by hand before believing it.
>
> **When you ADD an entry, add its `VERIFY:` line, and run it first.** A check
> you have not executed is a guess. Writing these on 2026-08-11, the naive dark
> mode check (`grep next-themes`) reported a hit — from shadcn's toast
> boilerplate, not from any dark mode. The command has to distinguish the thing
> from things that merely mention it.
>
> **When you FINISH an entry, strike it through and say what shipped**, with the
> commit. Do not delete it: a struck-through entry is what stops the next person
> re-proposing the same work.

## Properties module audit — 2026-08-21

Fifteen findings from a full read of M1 (properties, mandates, units, media,
export) against the code, not against this file. **Ranked by cost to the desk.**
Every VERIFY line below was RUN before it was written down.

Two things are worth saying before the list. **The schema already models what
the desk needs and the application does not use it** — `owner_contact_id` and
`developer_contact_id` have existed since `0001` and no screen writes or reads
either. And **finding 1 is a defect, not a nice-to-have**: it locks agents out
of properties they are supposed to work, and the standing "build nothing new"
decision (HANDOFF §5) does not cover it.

- **1. A property can never be assigned to an agent — DEFECT.**
  `assigned_agent_id` is written in exactly one place, `lib/actions/properties.ts:67`,
  and only when the creator is an *agent* (self-assign, because the insert policy
  demands it). Nothing else in the app ever sets it: no picker, no bulk action,
  no import column. That column is load-bearing for RLS —
  `0002_rls_policies.sql:164` (properties_update) and `:173` (property_media_insert)
  both admit an agent only when `assigned_agent_id = auth.uid()`. **So every
  property created by an admin or a listing manager is permanently uneditable by
  every agent, and no agent can add a photo to it.** The save even returns
  "Nothing was saved — this property isn't assigned to you", an error whose cure
  does not exist in the product. Fix: an assignment control (admin + LM only —
  an agent must not be able to hand their own property away and lock themselves
  out, since the UPDATE with-check only tests `org_id`).
  **VERIFY:** `grep -rn "assigned_agent" components/features/properties` — any
  write means shipped. *(0 hits on 2026-08-21; one read at `app/(app)/properties/[id]/page.tsx:136`.)*

- **2. Owner and developer are unreachable from the UI.**
  `properties.owner_contact_id` is written only by `scripts/import/properties.mts:213`.
  `properties.developer_contact_id` is written by nothing — its only hit outside
  the generated types is `lib/actions/merge-contacts.ts:128` repointing a column
  no screen fills. Neither is displayed on the detail page, the list, the map or
  the export. The only owner the app knows is `mandates.owner_contact_id`, so a
  property with no mandate has no owner anywhere, and "everything this developer
  has" is unanswerable. Fix: a Parties section on the detail page, both columns
  in the create wizard, and a backfill of `owner_contact_id` from the active
  mandate's owner where null.
  **VERIFY:** `grep -rn "developer_contact_id" app components lib/actions | grep -v merge-contacts`
  — any hit means shipped. *(0 on 2026-08-21.)*

- **3. Units flood the properties list.**
  `propertyFiltersSchema` (`lib/validators/properties.ts:132`) has no `kind`
  field, so units, phases, projects and standalone listings share one list,
  ordered `created_at desc`, 25 per page. One 60-unit project buries two and a
  half pages of real listings, and does the same to the CSV export and the map.
  Fix is one enum in the schema, one `Select` in the filter bar, and a default
  scope of standalone + project so units are reached through their project.
  **VERIFY:** `grep -c "kind:" lib/validators/properties.ts` — `1` = only the
  create schema has it, so the filter is missing. *(1 on 2026-08-21.)*

- **4. Versioned price lists are write-only.**
  `createPriceListVersion` snapshots every unit price into
  `price_list_items.list_price` (`lib/actions/units.ts:200`). **That column is
  never selected again.** `app/(app)/properties/[id]/units/page.tsx:52` reads
  `price_list_items(unit_id)` purely for a count, so the UI can say version 3
  covers 40 units and cannot show one price in it. A snapshot nobody can read is
  storage, not a record — and "what did we quote in March" is the entire point of
  versioning for a developer. Fix: read a version, diff it against the previous
  one per unit, and apply a % or fixed uplift to a selection to mint the next.
  **VERIFY:** `grep -rn "list_price" app components` — 0 hits means still
  write-only. *(0 on 2026-08-21.)*

- **5. A unit inherits five fields from its project; everything else is retyped.**
  `createUnit` copies `transaction_type`, `district_id`, `area_id`, `address`,
  `postal_code` (`lib/actions/units.ts:63-68`). Not copied, and therefore blank
  on every unit forever unless typed 60 times: developer, owner, VAT status,
  currency, title-deed status, permit status, energy class, delivery date,
  construction status, features, amenities, coordinates, assigned agent,
  visibility, description. Doc 02 §C1 says units inherit "unless overridden";
  the implementation inherits five columns and has no override concept.
  Fix: widen the inherited set, and record which columns are still project-derived
  in a `properties.inherited_fields text[]` so a later project edit can offer
  "update the N units that still inherit this" without touching the ones somebody
  deliberately changed.
  **VERIFY:** `grep -c "project\." lib/actions/units.ts` — `16` on 2026-08-21
  (5 inherited columns plus the guard and event reads). A larger number means it was widened.

- **6. Mandates can only be retyped, never renewed.**
  `MANDATE_TRANSITIONS` (`lib/validators/mandates.ts:10-15`) is a dead end:
  `expired: []`, `terminated: []`. Renewing means a blank dialog and re-entering
  owner, type, commission, reminder days and notes, and the new row carries no
  link to the one it replaces. For a business whose commission evidence is a hash
  chain, an unlinked mandate history is a real loss. Fix: `renewed_from_id` plus
  a Renew action that copies the terms forward and shifts the dates by the same
  duration.
  **VERIFY:** `grep -rl "renewed_from" supabase/migrations lib` — any hit means
  shipped. *(none on 2026-08-21.)*

- **7. Nothing stops two active exclusive mandates on one property.**
  `saveMandate` inserts at `lib/actions/mandates.ts:151` with no pre-check, and
  every reader ("active wins the badge") just takes the first active row it
  finds. Two exclusives with different commission rates can coexist and the UI
  will show one of them arbitrarily. Fix: a partial unique index — one active
  mandate per property — so it is a database guarantee rather than a convention.
  It protects the number the business gets paid on.
  **VERIFY:** `grep -rn "unique.*mandates\|mandates.*unique" supabase/migrations`
  — *(0 on 2026-08-21.)*

- **8. An active mandate can have no owner.**
  `owner_contact_id` is `optionalUuid` in `saveMandateSchema`
  (`lib/validators/mandates.ts:48`) and `setMandateStatus` does not check it.
  A mandate is a contract with a person; one that names nobody is worth 10 points
  on the quality score and nothing in a dispute. Fix: require it on the
  `draft → active` transition, not at insert, so a half-entered draft still saves.
  **VERIFY:** `grep -n "owner_contact_id" lib/actions/mandates.ts` — a check
  inside `setMandateStatus` means shipped. *(only the two writes on 2026-08-21.)*

- **9. A contact record never shows its properties.**
  `app/(app)/contacts/[id]/page.tsx` has six tabs (Profile · Preferences · KYC ·
  Activity · Deals · Documents, lines 236-245) and queries `properties` in none
  of them. Open a developer and you get their phone number, not their inventory.
  This is the other half of finding 2 — once the two party columns are filled it
  is a single query and one tab.
  **VERIFY:** `grep -c 'from("properties")' "app/(app)/contacts/[id]/page.tsx"` —
  *(0 on 2026-08-21.)*

- **10. Three project columns are dead in the UI.**
  `construction_status` and `delivery_date` have zero references anywhere outside
  the schema and `database.types.ts`. `currency` is read once
  (`app/(app)/share-links/page.tsx:33`) and written by nothing, so every listing
  is silently EUR. Delivery date is the most-asked question about an off-plan
  unit and it is already a column.
  **VERIFY:** `grep -rn "delivery_date\|construction_status" app components lib/actions`
  — *(0 on 2026-08-21.)*

- **11. `phase` is a kind that cannot be created.**
  The enum has four kinds. `CREATABLE_KINDS` offers two
  (`lib/validators/properties.ts:174`) and `createUnit` hardcodes the third, so
  nothing can produce a `phase` — yet three read paths branch on it
  (`properties/[id]/page.tsx:293`, `units/page.tsx:33`, `units.ts:47`). Either
  build phase creation (a large project genuinely sells in phases, with separate
  price lists and delivery dates) or delete the branches. **A code path nobody can
  reach is a claim, and claims here go stale silently** — same rule as this file's
  own header.
  **VERIFY:** `grep -rn '"phase"' lib/validators lib/actions` — a creatable kind
  means shipped. *(only the `createUnit` guard on 2026-08-21.)*

- **12. Every contact picker searches every contact — ENABLER.**
  `searchEntities("contact", …)` (`lib/actions/entity-search.ts:23-36`) has no
  type filter, so the "Owner contact" picker on a mandate offers buyers, lawyers
  and bankers. The query already exists one file away —
  `lib/queries/contacts-list.ts:78` filters with `.contains("contact_types", [type])`.
  Small alone, but it is the prerequisite for the party model in finding 2:
  "choose the developer" only works if the picker knows what a developer is.
  **VERIFY:** `grep -c "contact_types" lib/actions/entity-search.ts` — *(0 on 2026-08-21.)*

- **13. No duplicate guard when creating a property.**
  Contacts block duplicates live on `phone_e164` and warn on email. Properties
  have no equivalent, so the same villa entered twice yields two references, two
  mandates and two photo sets — and both burn a `reference_counters` value that
  can never be reissued. The indexes for the check already exist:
  `properties_location_gix` (GiST on the point) makes "within 30 m" cheap and
  `properties_ref_trgm` covers fuzzy matching. Warn, never block: two genuinely
  different units do share a building.
  **VERIFY:** `grep -rci "duplicate" lib/actions/properties.ts` — *(0 on 2026-08-21.)*

- **14. The CSV export omits every relationship.**
  Seventeen columns (`lib/services/property-export.ts:52-72`), none of which say
  who owns it, who built it, who is responsible for it, whether it is a unit or a
  project, or where it is. An export that cannot be grouped by developer is not
  much use in a developer conversation. Add: kind, owner, developer, assigned
  agent, coordinates, deed + permit status.
  **VERIFY:** `grep -c "Owner\|Developer\|Kind" lib/services/property-export.ts` —
  *(0 on 2026-08-21.)*

- **15. The quality score never asks who is responsible.**
  Eleven weighted items (`lib/services/quality-score.ts:49-89`) covering photos,
  copy, price, area, coordinates and legal status. None covers an assigned agent
  or a linked owner — reasonably, since neither is currently fillable. Once 1 and
  2 land they are the obvious additions, and the score is the mechanism that
  actually gets the desk to fill them in. **Do not do this before 1 and 2** — a
  score item for a field with no input is a permanent deduction.
  **VERIFY:** `grep -c "agent\|owner" lib/services/quality-score.ts` — *(0 on 2026-08-21.)*

### Proposals that came out of the same read

Not defects — features the audit argued for, all following one rule: **the
system already knows something, so stop asking a person for it.** Sizes are
relative (S = an afternoon, M = a few days). Nothing here gets built without
explicit direction.

- **Party defaults, S→M.** A developer's standard commission, mandate type and
  duration, usual VAT treatment, district, boilerplate and payment plan, stored
  on the contact as `party_defaults jsonb` (the same pattern the row already uses
  for `preferences`, `kyc`, `banking_readiness`), with an office-level fallback in
  `cyprus_config` — which already carries `verified_at` and `source_note`, the
  right shape for a number somebody has to stand behind. Resolution order:
  unit ← project ← party ← office. **Every prefill stays editable; a default is a
  suggestion, not a lock.**
- **Bulk unit generator, M.** "Block A, floors 1–5, units 01–04, 2-bed, 85 m²,
  €250k base +€5k per floor" creates twenty units with correct references in one
  submit. The single biggest reason a developer project is painful to enter today.
- **Unit type templates, M.** Define type A1 once (2 bed, 85 m², 20 m² veranda,
  €/m² rate) and stamp it onto any unit; price computes from area. Real projects
  repeat four or five layouts across every floor.
- **Create similar, S.** Duplicate any property as a starting point, minus the
  reference and the unit-specific fields.
- **Area centroid as a coordinate fallback, S.** Migration 0031 already ships
  district and area centroids and the map already falls back to them. Offer the
  same on save, flagged as approximate, so a listing reaches the map today and
  earns exact coordinates later.
- **VAT treatment derived, not remembered, M — NEEDS AN OPERATOR DECISION.**
  Reduced-rate eligibility follows from covered area, price and buyer status; the
  calculators exist and `cyprus_config` is built to hold verified thresholds.
  Suggest the status and show the rule that produced it. **The thresholds must
  come from the operator — a CRM must not invent tax law**, which is the same
  reason B4's reservation agreements are parked (HANDOFF §5).
- **Owner net ↔ asking ↔ commission, shown, S.** All three are already columns.
  Show the arithmetic so an agent negotiating knows the floor. Admin + assigned
  agent only, matching how `mandates_safe` masks commission.
- **Quality-score worklist, S.** `computeQualityScore` already returns a
  `missing` array per property and it is thrown away after rendering one ring.
  Aggregate it across the list — "19 missing deed status, 12 missing coordinates"
  — so one category can be cleared in a sitting.
- **Portfolio tab on a contact, S.** Finding 9, from the other side.
- **Project availability share link, M.** `share_links` already mints, opens and
  revokes with full evidence. Point the same machinery at a project and a
  developer or partner agent gets a live availability matrix instead of
  yesterday's PDF.
- **Construction progress + delivery date, S.** Finding 10, made useful: a
  milestone % and an expected delivery on the project header, which is also the
  raw material for the M13 developer dashboard.
- **Sales velocity per project, M.** Units sold per month and absorption rate,
  computed from `status_changed` events already being written and read by nothing
  but the timeline. No new data collection at all.
- **Keys follow the mandate, S.** Terminating or expiring a mandate should prompt
  to recall keys still checked out on that property. Both sides are evented;
  nothing connects them.

- ~~**THE PROPERTY MAP (B5) RENDERS BLANK — SHIPPED, THEN HIDDEN.**~~
  **WITHDRAWN 2026-08-20: THE MAP WAS NEVER BROKEN.** Verified working against
  the real bundle — 9 `/planet/*.pbf` vector tiles, `load` fired, `loaded: true`,
  Cyprus drawn with roads and bilingual labels, headless and headed alike. The
  Map link is restored and both E2E tests are un-fixmed.

  **Everything in the original entry below was measured through two broken
  instruments, and every "ruled out by direct measurement" line it contains is
  worthless.** Keep it as the cautionary tale it is.

  1. **`requestAnimationFrame` does not run in a hidden tab.** MapLibre requests
     tiles from inside its rAF render loop and fires `load` from there too. Every
     "blank map" observation was taken through browser automation, where
     `document.visibilityState === "hidden"` and `document.hasFocus() === false` —
     including the checks against production. A hidden tab cannot render ANY map,
     working or not, so those checks could only ever produce the symptom they
     found. **Check `document.visibilityState` before believing anything about a
     canvas.**
  2. **A worker's fetches never appear in the window's resource timeline.**
     Vector tiles are fetched by MapLibre's worker. Measured on the same working
     page at the same moment: 9 tiles at the network level, **0** via
     `performance.getEntriesByType("resource")`, and 11 `.pbf` glyphs (fetched on
     the main thread) which is what made the ORIGINAL any-`.pbf` assertion pass.
     So the first assertion passed for the wrong reason and the "fixed" one could
     never pass at all. Count tiles with `page.on("request")`.

  **Both traps are written up permanently in `docs/ENGINEERING_NOTES.md` §7.**

  The sequence is the point: an assertion that could not fail was replaced with
  one that could not pass, the red CI was then read as proof the feature was
  broken, and a working feature was hidden from users on that basis. Each step
  was reasonable given the step before, and the whole chain was wrong, because
  nobody validated the instrument. The real bug fixed along the way was the
  effect-churn in `map-view.tsx` (the map was torn down and rebuilt on every
  render) — genuine, worth keeping, and never the cause of anything blank.

  The original entry follows.

  - **THE PROPERTY MAP (B5) RENDERS BLANK — SHIPPED, THEN HIDDEN (2026-08-11).**
    Everything except the tiles works: the style, TileJSON, sprites and font glyphs
    all load, the canvas is correctly sized (1390x729), WebGL2 is supported, blob
    workers run, nothing is CSP-blocked and nothing errors in the console. MapLibre
    requests **zero** map tiles (`/planet/*.pbf`). Ruled out by direct measurement,
    not by reasoning: the CSP origin is present on `img-src` and `connect-src`; a
    `.pbf` fetched by hand from the page returns 200/119157 bytes; `resize()`
    changes nothing; the real effect-churn bug (the map was being torn down and
    rebuilt on every render) was found and fixed and was NOT the cause. Downgrading
    `maplibre-gl` 6.4.0 -> 5.24.0 changed the symptom (glyphs began loading) but not
    the outcome. Remaining suspect, UNPROVEN: MapLibre's worker under Next 16 /
    Turbopack, which is the thing that actually fetches tiles.

    Route `/properties/map` and migration 0031 (district/area centroids) stay —
    both are harmless. What was removed is the **way in**: the Map link on
    `/properties` is commented out, so nobody reaches a grey rectangle. Two E2E
    tests are `test.fixme` — the `/planet/` tile assertion and the link round-trip.

    **The tile assertion is the real lesson here.** The original version counted any
    `.pbf` request. Font glyphs are also `.pbf`, so it passed in CI, on a build
    whose map was blank in production. A test that cannot fail is worse than no
    test: it spends the credibility of a green run on nothing. Do not weaken it
    back — fix the map.

    **RE-VERIFIED IN PRODUCTION 2026-08-20** (gnk-crm.vercel.app on 9e2ddc9, real
    signed-in browser): still blank. 0 `/planet/*.pbf`, 11 glyph `.pbf`, 15
    OpenFreeMap requests (style, TileJSON, sprites json+png, glyphs), canvas
    1390x729, WebGL2 supported, and **not one console message** on a fresh reload.

    **THE CLUE THAT NARROWS THIS, found on that run: `property-map-empty` is NOT in
    the DOM**, so `data.features.length > 0` — the resolver and the district-centroid
    fallback both work. The pins are a `circle` layer fed from LOCAL GeoJSON: they
    need no tiles and would paint over a blank background. Nothing paints. So this
    is not "the basemap fails and the pins survive" — `map.on("load")` almost
    certainly never fires, and the handler that calls addSource/addLayer never runs.

    That fits the worker hypothesis and sharpens it: `load` waits on sources,
    sources are fetched by the worker, so a dead worker stalls `load` forever —
    silently, which is exactly the signature (no error, correct canvas, style and
    glyphs fine). It also EXONERATES a whole branch: the resolver, the GeoJSON
    coordinate order, the layer paint properties and the styling are all fine, so
    do not spend time there.

    Next step if picked up: reproduce in a bare Vite build to isolate whether this
    is MapLibre or the bundler, since that single fact splits the search space.
    Instrument `map.on("load")`, `map.on("error")` and `map.on("sourcedata")`
    FIRST — confirming load never fires (or catching the error it swallows) is
    cheaper than any further network archaeology.

    VERIFY: `grep -c "^test.fixme(" tests/e2e/property-map.spec.ts` — `2` means
    still broken and parked. `0` means someone fixed it and this entry is stale.
    (Anchored at `^` and including the paren ON PURPOSE: the unanchored
    `grep -c "test.fixme"` returns `3`, because a comment in that file explains the
    markers. That wrong number was written here first and caught by running it.)

- **Property map, the rest of the shortlist (proposed 2026-08-20).** Click-to-open
  popups, fit-to-results and clustering shipped; these four did not, and are
  listed in the order I would do them.

  - ~~**Price on the pin.**~~ **SHIPPED 2026-08-20.** Not as originally
    described, though: a label on every pin is destroyed by the stacking, because
    MapLibre resolves a label collision by HIDING one, so a price drawn over
    shared-centroid pins shows one arbitrary property out of however many are
    underneath. The value is on the CLUSTER, which is what you mostly see here —
    `clusterProperties` aggregates a minimum as the worker clusters, so the badge
    reads `3 · from €380.000`. Lone pins carry their own price below the marker.
    Verified on a visible page: correct minimum, and an all-unpriced cluster shows
    its count with NO price rather than `from €0`.

    **Two traps worth keeping.** `["to-number", x, fallback]` does NOT fall back
    for null — the spec converts null to 0 successfully — so the first version
    would have read `from €0` for any cluster holding one unpriced property.
    Hence the explicit `hasPrice` flag: a style expression has nothing else safe
    to branch on. And the console warnings this map logs are **not ours**: they
    were measured identical with our layers removed entirely, come from the
    OpenFreeMap Liberty style, and vary with zoom rather than with our data.

  - ~~**Map viewport in the URL.**~~ **DECIDED AGAINST 2026-08-20** (operator).
    Fit-to-results largely obsoleted it: the filters already live in the URL and
    the map fits to the filtered set, so a link already reproduces a meaningful
    view — one derived from the data rather than frozen coordinates. Adding
    `?lat=&lng=&zoom=` would buy little and cost a precedence rule plus a way for
    a shared link to disagree with what it shows. Revisit only if someone wants to
    send *this exact view* rather than *these results*. Original entry: `?lat=&lng=&zoom=` alongside the existing filter
    params, so Map↔List stops throwing the view away and a map position can be
    sent to a colleague. Fits the pattern `parsePropertyFilters` already sets.
    VERIFY: `grep -c "moveend" components/features/properties/map-view.tsx` — `0` = not built.
  - **Hover sync between list and map.** Hovering a list row highlights its pin.
    Only worth it once list and map are visible together, which they are not today.
  - ~~**Draw-a-polygon "search this area".**~~ **DECLINED 2026-08-20 by the
    operator** — not wanted, and it was the only L on the shortlist. The technical
    note is kept because it stays true if that ever changes. Original entry: The genuinely valuable one for real
    estate, and the largest. `properties.location` is already
    `geography(point,4326)`, so the query is `ST_Covers` behind the SAME RLS and
    the SAME filter parser both views share — the work is the drawing UI and
    getting the polygon into the filter object, not the spatial SQL.
    VERIFY: `ls supabase/migrations | grep -ci area_search` — `0` = not built.

  NOT worth building: a map picker on the property form.
  `components/features/properties/map-location-fields.tsx` already accepts lat/lng
  AND resolves a pasted Google Maps link, short links included, which is faster
  than dragging a pin.

- Forgot-password flow on `/login` (doc 05): Supabase `resetPasswordForEmail` +
  reset page + email template. Natural fit with Phase 2 Resend integration.
  **VERIFY:** `grep -rl resetPasswordForEmail app lib` — any hit means shipped.
  *(0 files on 2026-08-11.)*
- Dark mode (doc 06 lists it as backlog).
  **VERIFY:** `grep -c "dark:" app/globals.css` — 0 means not started.
  *(0 on 2026-08-11. Do NOT check with `grep next-themes`: `components/ui/sonner.tsx`
  imports `useTheme` as shadcn boilerplate and reports a false hit.)*
- Restore `app/(app)/properties/loading.tsx` skeleton once Next.js fixes the
  queued-suspense-reveal hydration bug (see DECISIONS 2026-07-12 · T3.5).
  Re-test: property detail tabs must stay clickable with the file present.
  **VERIFY:** `ls "app/(app)/properties/loading.tsx"` — exists means restored.
  *(absent on 2026-08-11.)*
- Keys i18n: register/movement dialog strings are hardcoded English (Phase 1
  ships English; the transfer/mark_lost/edit/history UI landed in the
  2026-07-20 keys audit, T-audit).
  **VERIFY:** `grep -rl useTranslations components/features/keys` — 3 of 3
  components means done. *(0 of 3 on 2026-08-11.)*
- Settings/users: invite emails, self-service password reset and "reset 2FA"
  (doc 05) — all ride the Phase 2-3 email integration; Phase 1 invites hand
  over a one-time password (DECISIONS 2026-07-14 · T5.4).
  **VERIFY:** `grep -rl inviteUserByEmail app lib` — any hit means shipped.
  *(0 files on 2026-08-11.)*

- Audit remaining `z.string().uuid()` usages (leads.ts, units.ts,
  properties.ts required ids) for the Zod 4 strict-RFC-4122 trap: Postgres
  accepts any 32-hex uuid but Zod 4 `.uuid()` rejects e.g. the seeded
  `11111111-…` fixture ids. `optionalUuid` in deals/properties validators
  already fixed to `z.guid()` (T3.2); the rest only ever see
  `gen_random_uuid()` values today so they are safe in practice.
  **VERIFY:** `grep -rn 'z\.string()\.uuid()' lib | wc -l` — 0 means the audit
  is finished. *(4 usages on 2026-08-11.)*
- ~~Dashboard SQL-side aggregates~~ — **DONE 2026-07-23** (audit PERF-3,
  migration 0018 `admin_dashboard_stats`). The SUMS no longer undercount past
  the caps; proven with a rolled-back 2,100-deal probe (old capped sum was
  €122,000 light). 9 dashboard round trips became 4. RLS test 22 pins the
  SECURITY INVOKER org scoping.
- Dashboard KPI deltas vs the previous period (7d vs prior 7d, month vs last
  month) — same queries with a shifted window.
- "Lost this month" counter beside "Won this month" for honest pipeline health.
- Admin visibility into org-wide overdue tasks and unassigned leads (agents
  see only their own).
- "View all →" footer links on the admin Latest-events and Mandates-expiring
  cards once a canonical events/mandates list page exists to link to.
- Property importer `photo_folder` support (doc 09): ingest photos from
  `import-media/<folder>/` through the T1.4 media pipeline. T5.6 imports all
  other columns; photo ingestion deferred.
- `/leads/[id]` lead detail page (doc 05): lead summary + editable fields +
  conversation/event history (EventTimeline) + convert panel. The inbox now
  covers link contact / assign / correct / reopen / convert / close inline
  (2026-07-15), so the standalone page is deferred as a nice-to-have. A
  converted lead links out to its deal via "View deal →".
- Leads inbox: pagination past the current 100-row slice (header counts are
  already exact DB counts, 2026-07-16). The status filter half of this line
  shipped 2026-07-21 — see DECISIONS T-list-scope.
- List scope follow-ups (T-list-scope): deals/viewings/offers lists should get
  the same scope treatment their terminal statuses already imply. (The
  property Archive/Restore button half of this line shipped 2026-07-21 — see
  DECISIONS T-property-archive.)
- `JWT issued at future` resilience (seen on prod 2026-07-19 and again
  2026-07-21, count 1 each, route `/properties/[id]`; also hit locally on
  2026-07-21 where the Docker VM clock had drifted while the host clock was
  fine). A slightly future-dated access token makes PostgREST reject the query
  and the user gets the "Couldn't load properties" boundary until they reload
  or re-login. Not a code defect and rare, but it is user-visible and
  self-inflicted-looking. ~~Options: a one-shot retry on that specific PostgREST
  message, or nudging GoTrue/Supabase clock-skew tolerance.~~ **Both measured out
  2026-08-08 — see the third-sighting entry below for the numbers.** Diagnosis
  note: the local fix is clearing cookies + re-login to mint a fresh token, NOT
  restarting the Supabase stack.
- Retention-expiry view (T-contact-erasure follow-up): erasure stamps
  `contacts.retention_until` (erasure date + 5y AML duty) but nothing yet acts
  on it, so retained KYC documents would sit in the bucket forever — which is
  the GDPR storage-limitation problem in slow motion. Needs an admin view
  listing contacts whose `retention_until` has passed (the partial index
  `contacts_retention_idx` from 0017 already supports the query) plus a
  "purge retained documents" action reusing the erasure action's guarded
  delete + storage-removal path. Deliberately deferred: the earliest real
  expiry is 2031.
- Erasure coverage gaps (T-contact-erasure): `deals.commission_notes` and
  `viewings.notes` are free text that may name the data subject; both are
  retained today under the legal-claims basis. If a data subject disputes that,
  they need a review path. Also `leads.lost_reason` is left intact.
- Add-lead dialog: optional property link (schema + createLead already accept
  `property_id`; the form never sends it) and an optional backdated
  `received_at` for leads entered after the fact, so the response-time KPI
  reflects reality.
- RLS follow-up: read the contacts/properties/viewings/tasks UPDATE policies
  with the client and decide whether cross-member hand-off should be locked
  down like leads/deals (0009) or stays intentional collaboration.
- Event log durability: logEvent runs after its mutation commits, so a failed
  event insert surfaces as an action error the user retries (risking a
  duplicate mutation). Long-term: write event + mutation in one transaction
  via RPC or trigger.
- Pipeline board: filter bar (agent, expected-value range) and a board-level
  open-value total in the header.
- Pipeline board: stale-deal highlighting — tint cards whose
  `stage_entered_at` tenure exceeds a per-stage threshold (column is in place
  since 0011).
- Properties list: column sorting (price, score, updated) — currently fixed
  `created_at desc` only — plus a `?tab=` param on the detail page so
  Media/Documents tabs are deep-linkable.
- Property media: drag-and-drop photo reorder with dnd-kit (pin `DndContext
  id`, see pipeline board) replacing the up/down arrows; re-watermark
  renditions when visibility changes (watermark currently applies only at
  upload time, so a private→public flip publishes unwatermarked images).
- Rent price history: the 0005 trigger only tracks `asking_price`; tracking
  `rent_price_month` needs a `price_type` discriminator column on
  `price_history` (schema change, not just a trigger edit).
- Properties module i18n (en/el/ru) for consistency with the dashboard pass —
  the module ships hardcoded English per the Phase 1 spec.
- Search index follow-up: `properties_ref_trgm` covers `reference` only;
  `address` / `title->>en` ilike scans are unindexed (fine at internal scale).
- Bulk list actions (multi-select → status/visibility change) and CSV export,
  if the team asks for them.
- Contacts follow-ups (T-audit-contacts): merge as a SECURITY DEFINER RPC for
  true atomicity (current app-side merge is archive-first + idempotent-resume);
  additional_phones add/remove UI (today they only originate from merges);
  contacts module i18n (en/el/ru); CSV export of the filtered list; filter
  inputs don't re-sync on browser back/forward (applied filters do); email
  uniqueness is advisory-only (no partial unique index like phone — add one if
  duplicate emails start appearing); `/contacts?tab=` deep-links.
- Viewings follow-ups (T-audit-viewings): reschedule/edit action
  (`checkViewingConflicts` already takes `excludeId` for it; must clear the
  route stamp when the day changes); optional deal picker in the create dialog
  (`deal_id` is accepted by the schema/validator but no UI sends it); admin-only
  "reopen to scheduled" recovery for mis-clicked terminal statuses; decide the
  fate of the unused `viewings.owner_notified` column (Phase 2 owner
  notifications?); calendar hint when paging past the 90-day/500-row fetch
  window; route save as a single RPC for atomicity (currently N sequential
  updates); "Mark completed" one-tap on the slip-signed success panel.
- Tasks follow-ups (T-audit-tasks): edit / delete / reschedule-due-date UI
  (delete RLS exists but nothing uses it; auto renewal tasks can only be
  completed, never dismissed or snoozed); entity-linked tasks — `contact_id` /
  `deal_id` columns exist (contact-merge even repoints them) but no UI sets or
  displays them; "Add task" buttons on property/contact/deal detail pages;
  admin section on /tasks for org-wide overdue + unassigned tasks with a
  claim/assign control (0012's admin fallback prevents new orphans, but an
  explicit surface beats a fallback); tasks module i18n (en/el/ru); feedback
  nudge rows could show the contact name next to the property ref.
- Settings follow-ups (T-audit-settings): admin "Reset password" button on the
  users table (regenerate a temp password via the existing admin API + the
  credentials-shown-once dialog — closes the no-SMTP lockout gap until Phase 2
  email); force password change on first login (user_metadata flag + redirect);
  delete-unused-area button (the areas_delete RLS policy exists but no UI calls
  it); per-stage deal counts in the stages editor so delete refusals are
  predictable; "verified N months ago / never verified" staleness badge on
  cyprus-config cards; settings module i18n (en/el/ru); org-scoped branding
  paths if multi-org ever ships (branding/logo.png is global today).
- ~~Reports follow-ups (T-audit-reports)~~ — ALL SHIPPED: deal filter,
  generated-reports list, verify-a-report and the nightly chain cache as
  T-audit-reports-2 (migrations 0015/0016); module i18n as T-audit-reports-3.
- ~~Event-line vocabulary i18n (`describeEvent`)~~ — SHIPPED as
  T-audit-events-i18n: `describeEvent` takes a translator; `EventTimeline`
  passes the request-locale one so every general timeline translates; the
  evidence record passes a pinned English one so preview + PDF stay English.
  `events` namespace in en/el/ru. The event PAYLOAD values (names, section
  keys, channels, stage names, user-typed reasons, file names) deliberately
  stay as-stored — only the template text translates.

- ~~**CSV export — remaining lists.**~~ **ALL SHIPPED 2026-07-24, the day after contacts** — properties (`0e57f5c`), leads (`0e6544d`), deals (`8624e59`), viewings (`bd8bf50`), keys (`04b4d4f`), tasks (`a29a222`, whose message says "completes the rollout"). Seven export routes under `app/(app)/*/export/route.ts`, five extracted `lib/queries/*-list.ts` modules each with a colocated unit test, and seven E2E specs (`tests/e2e/*-export.spec.ts`). Exactly the plan this entry described, executed in full.

  **This entry stayed open for 18 days and sent a session off to rebuild finished work on 2026-08-11.** It was caught by globbing `app/**/export/**/route.ts` before writing anything. **The lesson is the file's, not the reader's:** an entry describing work to do is a claim, and claims here go stale silently. Before starting anything from BACKLOG, check whether it already exists.
- ~~**Export audit logging (decision needed).**~~ **Resolved 2026-07-23: yes, log exports.** Built in `lib/services/export-audit.ts` (org-level `export`/`exported` event, written before the CSV is returned). Contacts export logs; the remaining lists inherit it via `logListExport`. See DECISIONS `T-export-audit`.
- ~~**Database-level 2FA enforcement (security, follow-up to C2).**~~ **SHIPPED AND APPLIED TO HOSTED 2026-08-11** — migration 0029 `require_aal2`, exactly the opt-in template this entry prescribed, on all 29 RLS-enabled tables. Evidence in IMPROVEMENTS C2, reasoning in DECISIONS `T-aal2-rls`, rollback in `docs/superpowers/plans/2026-08-10-c2-db-2fa-enforcement.md`.
- **A dormant admin has no second factor** — ~~open~~ **REVIEWED AND KEPT 2026-08-09, operator decision: he needs admin access.** Production has
  two active admins. `nontari@` enrolled TOTP on 2026-08-09 (factor `verified`).
  `gerasimos@` is also a full admin — same reach over client KYC and the
  evidence chain — with **no verified factor and no sign-in since 2026-07-15**.
  A dormant privileged account protected by a password alone is the cheapest way
  into this system, and it is also the account that would carry the blast radius.
  Operator call, not an engineering one: enrol it, downgrade it to `agent`, or
  deactivate it until it is needed. Deliberately not changed by an agent — it is
  someone's account. Note it doubles as the lockout safety net for C2's
  DB-level enforcement, so decide it BEFORE that lands.

  **Decision (2026-08-09): left as admin, deliberately.** Two consequences to
  carry forward. (1) He should enrol TOTP at `/security` next time he signs in —
  the account is otherwise password-only. (2) He is currently the ONLY other
  admin, which makes him the lockout safety net for C2's DB-level 2FA
  enforcement; that is an argument for keeping him, not against, but it means
  C2 must not assume every admin has a factor.
- ~~**Settings → Users cannot show who has 2FA — which is why the dormant admin
  went unnoticed (noticed 2026-08-09).**~~ **SHIPPED THE SAME DAY** — migration
  0028 `org_mfa_status()` plus a `2FA` column in
  `components/features/settings/users-panel.tsx`, which also renders an explicit
  "could not read 2FA status" state rather than letting a failed query read as
  "nobody has 2FA". This entry stayed open in BACKLOG for two days after the work
  landed; it was found on 2026-08-11 by checking the component instead of reading
  the note. The write-up below is kept because the reasoning still explains the
  shape of the solution.

  **Not a five-minute job, which is why it is written down rather than done.**
  There is no public admin API for another user's factors in `@supabase/auth-js`
  2.x — `listFactors` exists only on a user's OWN client, and the admin variant
  is private. So it needs a `SECURITY DEFINER` function over `auth.mfa_factors`,
  roughly:

  ```sql
  create function org_mfa_status()
  returns table(profile_id uuid, has_verified_factor boolean)
  language sql security definer set search_path = public, auth as $$
    select p.id,
           exists (select 1 from auth.mfa_factors f
                    where f.user_id = p.id and f.status = 'verified')
      from profiles p
     where p.org_id = current_org_id() and current_role_gnk() = 'admin';
  $$;
  ```

  Treat it as a security change, not a UI one: **HANDOFF §4.3 — a new security
  definer function is anon-executable by default**, so it needs the explicit
  `revoke … from public, anon` and a `get_advisors` pass, which is precisely
  what migration 0021 got wrong. Then a "2FA" column and an RLS test that a
  non-admin gets nothing back.
- **RLS helper functions are called ONCE PER ROW — counted, 2026-08-11.**
  ~~**FIXED ON THE 7 LIST TABLES**~~ — **DONE AND APPLIED TO HOSTED 2026-08-11**,
  migration 0030. 24 policies hoisted, 0 bare, 115 policies before and after,
  `get_advisors` clean. Design and plan under `docs/superpowers/`; rollback is
  `docs/superpowers/plans/2026-08-11-rls-hoist-rollback.sql`; the reasoning is
  DECISIONS `T-rls-hoist`.

  **VERIFY — two checks, because "built" and "applied" are different states:**

  ```
  in the repo:  ls supabase/migrations/0030_hoist_rls_helpers.sql
  on hosted:    select public.rls_hoisted_policy_count();   -- 24 = applied, error = not
  ```

  *On 2026-08-11 after the apply: present in the repo, and 24 on hosted.*

  **62 permissive policies remain bare on purpose** — 36 on config/staff-bounded
  tables, 26 read a few rows at a time. Widening to those is a separate decision,
  not an oversight.

  What landed locally: 24 permissive policies on `contacts`, `deals`, `events`,
  `leads`, `properties`, `tasks`, `viewings` rewritten with both helpers wrapped
  in `(select …)`. **62 permissive policies remain bare on purpose** (36 on
  config/staff-bounded tables, 26 read a few rows at a time).

  **Verified, and the meaning-preservation twice over:** the migration's own
  equivalence check (0 changed on an untouched database, exactly 1 when a policy
  was deliberately weakened), plus an independent out-of-band diff that stripped
  the wrappers back out of the migration and compared against the rollback script
  — byte-identical for all 24. `EXPLAIN` shows `InitPlan … loops=1`; 48 RLS tests
  pass with the 44 pre-existing unchanged; 115 policies before and after.

  **Three traps found while building it, all worth keeping.** `pg_policies.qual`
  is deparsed by `pg_get_expr()` against the CALLER's `search_path`, so with
  `pg_catalog` pinned the call renders `public.current_org_id()` and an
  unqualified literal silently inverts the guard — the fix normalises the
  qualification away rather than depending on a path. The equivalence check must
  normalise BOTH sides identically, or a re-run against an already-hoisted
  database reports "changed 24 predicates" when nothing changed. And
  `rls_hoisted_policy_count()` matches `current_org_id()` only, so it is complete
  only alongside `rls_bare_helper_calls()`.

  Original finding follows.

  83 of the 115 policies call `current_org_id()`; 62 call `current_role_gnk()`.

  **The measurement, on a purpose-built 20-row probe table:**

  | policy predicate | calls for one 20-row scan |
  |---|---|
  | `org_id = probe_fn()` | **21** |
  | `org_id = (select probe_fn())` | **1** |

  The probe was a `stable security definer plpgsql` function — the same shape as
  `current_org_id()` — that raised a `NOTICE` per invocation; the notices were
  counted. It scales with rows, so the cost is linear in result-set size on every
  query against 26 tables.

  **Two false starts worth recording, because both produced confident wrong
  readings.** `pg_stat_user_functions` does not track here: three explicit calls
  moved the counter by 0, so an early "0 calls" reading was the instrument, not
  the truth — **validate a counter by making it move before trusting a zero.**
  And `set local role authenticated` outside a transaction block is a no-op
  warning, so the first probe ran as `postgres`, which bypasses RLS entirely and
  evaluated no policy at all.

  Plan shape alone does NOT settle this — `current_org_id()` appears as an
  `Index Cond` in some plans (evaluated once, as a scan key) and a `Filter` in
  others. An earlier version of this entry read one plan and generalised. Count
  calls, don't read shapes.

  **The fix** is Supabase's documented `(select …)` wrapper; 0029 already writes
  its own predicate that way. **Still not urgent** — the largest table holds tens
  of rows, so 21 calls versus 1 is currently microseconds. It becomes real when
  the desk puts volume in. Each rewrite is a drop-and-recreate of a live security
  policy (there is no `create or replace policy`), so it wants its own session
  with the RLS suite green before and after.
- ~~**Sentry has no source maps and no release tracking (noticed 2026-08-09).**~~
  **SHIPPED 2026-08-11 (`70e4ceb`) — one acceptance check still open.**

  `next.config.ts` now wraps with `withSentryConfig`. The deploy uploaded **751
  files in two bundles**, both bound to release `70e4ceb9205d` (Sentry →
  Settings → Source Maps), and that release is the first carrying a
  `vercel-production` deploy marker instead of sitting unfinalized.

  **STILL UNVERIFIED, deliberately: that a real stack trace resolves to a
  filename.** Maps being present does not prove they MATCH the deployed
  bundles — mismatched paths are the classic silent failure, and no local build
  can show it. Operator decision 2026-08-11 was to wait for a genuine client
  error rather than manufacture one. **When the next client error appears, read
  its top frame.** A path like `components/features/…` means this worked;
  another `chunks/44sdjkbb-9351.js` means the maps do not match and this
  reopens.

  Two claims in the original entry below were wrong — both corrected by checking
  the dashboard rather than reading the note. `SENTRY_ORG` is in Vercel too (not
  just AUTH_TOKEN and PROJECT), and **releases were already being created and
  attached**: the Vercel integration did that, which is why 2026-08-10 issues
  read `release 7b9c11c213c7`. What was missing was source maps and *finalized*
  releases, not release names.

  Build behaviour proven three ways before shipping — no token (0 maps, exit 0),
  bad token (**exit 0**, 401s logged, so an expired credential cannot break
  deploys), upload enabled (60 client maps). `.map` files are deleted after
  upload *even when the upload fails*, and production still answers 403 for a
  `.js.map`. Reasoning in the commit; the original entry follows.

- **[HISTORICAL — SUPERSEDED BY THE ENTRY ABOVE, WHICH SHIPPED. Not open work.]**
  **Sentry has no source maps and no release tracking (noticed 2026-08-09).**
  Delivery is fixed and alerting is proven, but the DATA is poor. `next.config.ts`
  does not wrap with `withSentryConfig`, so stack traces arrive minified — the
  2026-08-03 production error read
  `.next/server/chunks/ssr/[root-of-the-server]__1852x8s._.js:1:6032`, which
  names no file and no line — and no release is attached, so an issue cannot be
  tied to the deploy that caused it. With several deploys a day that is the
  difference between "this broke today" and "this broke, somewhere, sometime".

  The prerequisites are ALREADY in Vercel and unused: `SENTRY_AUTH_TOKEN`,
  `SENTRY_PROJECT` and `VERCEL_GIT_COMMIT_SHA` exist (added Aug 3 by the Sentry
  integration) — they are exactly what the build plugin needs. So this is
  `withSentryConfig` plus a release derived from the commit SHA.

  Treat as a BUILD change, not a config tweak: it alters the production build and
  uploads source maps at build time, so it wants a green CI run and a check that
  the deploy still succeeds before it is trusted. Verify by reading a real stack
  trace in Sentry afterwards, not by the plugin being present.
- **Mandatory 2FA (decision, follow-up to C2).** Enrolment is currently opt-in. If the client wants it required, the Supabase guide gives "enforce for all users" and "enforce for new users only" variants. Do the DB-level enforcement above first, and plan a recovery path — Supabase issues no recovery codes, so the practical answer is a second enrolled factor per user plus an admin who can delete a factor via the GoTrue admin API.
- ~~**Deal-scoped "Log contact" action (follow-up to B7).**~~ **SHIPPED
  2026-08-07 (migration 0025).** It was worse than this entry described: the
  edit did not merely buy 14 days of quiet, it CLOSED the open chase-up
  immediately via `deals_supersede_nudges` and logged
  `reason: deal_contacted_or_closed` against the editing user — the log asserted
  contact nobody had claimed. Silence now has its own column, `last_contact_at`,
  written only by `logDealContact` and by `logConversation` on a converted lead;
  `last_activity_at` still drives the health score and is still bumped by edits.
  The trigger's `WHEN` clause had to move with the predicate — it fired on
  `last_activity_at or status`, so the function alone would have been correct
  while the feature stayed broken. RLS test 27 and the reworked E2E nudge spec
  pin both directions. See DECISIONS `T-deal-contact`.
- **Configurable nudge thresholds (decision, follow-up to B7).** 14 days and 48
  hours are hardcoded in `create_followup_nudges()`. 14 is deliberately the
  health score's own activity cliff (doc 02 §C5), so making it independently
  editable risks the two disagreeing silently about what "stale" means. If the
  desk wants to tune them, put them in `cyprus_config` with a `coalesce` default
  so the cron survives a missing key, add the settings row + validation + its
  event, and decide explicitly whether the health score follows.
- ~~**Nudges can land on a deactivated assignee (B7 + 0012).**~~ **RESOLVED
  2026-08-02 (migration 0024).** Every arm of the three-armed fallback is now
  active-only in all three system kinds (`deal_no_contact`, `viewing_feedback`,
  `mandate_renewal`) — previously only arm 3 checked `is_active`, so the guard
  stopped exactly where the fallback started. Fixing the arms alone was not
  enough: the cycle guards refuse to re-mint a task for a boundary that already
  has one, and deactivation usually happens *after* assignment, so the re-home
  is stated as an invariant and self-healed nightly as step 5 of
  `create_followup_nudges` (which runs 03:15, after expire-mandates at 03:00, so
  one place owns it for all three kinds) plus a one-time backfill. RLS test 26
  pins it. Note the test asserts the assignee **as minted**, read from the
  `followup_task_created` event: step 5 re-homes within the same invocation, so
  asserting on `tasks.assignee_id` alone passes even with the arms reverted —
  verified by reverting them and watching it still pass.
- ~~**Human-assigned tasks are still stranded by deactivation.**~~ **RESOLVED
  2026-08-09 — "Needs an owner" on `/tasks`, admin-only.** No migration: RLS
  already granted admins the whole org on `tasks_select`/`tasks_update`, so this
  was a missing SURFACE, not a missing permission.

  It covers **both** invisibilities, not just the one this entry named. A NULL
  assignee is equally unreachable and is genuinely possible — `create_followup_nudges`
  ends its three-arm coalesce at "oldest active admin", so an org with no active
  admin mints one. Reassign is explicit and admin-only, and logs the existing
  `assigned` event (`to_name`), so no new event type or i18n key was needed.

  **The precondition is the subtle part.** `toggleTaskDone`'s pattern folds the
  no-op check into the write so a double submit cannot log twice, but a bare
  `.neq("assignee_id", to)` evaluates to NULL for an unassigned row and PostgREST
  drops it — silently refusing the exact case this feature exists for. It is
  `.or("assignee_id.is.null,assignee_id.neq.<id>")`, and `stranded-tasks.spec.ts`
  reassigns the orphan specifically to pin that path.

  Original entry: 0024's sweep is
  deliberately scoped to system-generated rows (`kind is not null`); a task one
  person assigned to another by hand still sits invisible if the assignee is
  deactivated. Re-homing those silently would overwrite a human's deliberate
  choice, so it wants a surface (an admin "tasks held by deactivated users" list
  with an explicit reassign) rather than a cron rule. Pairs naturally with the
  org-wide overdue/unassigned admin view already in this file.
- ~~**`csp.spec.ts` depends on test residue.**~~ **RESOLVED 2026-08-02.** The
  two detail tests asserted `expect(href).toBeTruthy()` on the first row of
  `/properties` and `/contacts`, which only `happy-path.spec.ts` creates — so
  against a freshly reset database both FAILED on run 1 and passed on run 2.
  Of the two fixes offered here, **seeding** was chosen over self-skipping:
  these are the heaviest client routes in the app (tabbed forms, media grid),
  and dropping their CSP evidence silently on a fresh database is the worse
  trade. The spec now prefers a real row when one exists — real data exercises
  media and documents a bare fixture does not — and seeds its own property and
  contact when the list is empty, removing them in `afterAll`. Cleanup is
  marker-based (`reference like 'CSP-FIXTURE-%'`; `contacts.notes`, since
  `properties` has no `notes` column) so a crashed run is swept by the next one
  rather than leaking rows. Seeding needs the service key, so against a
  non-local base URL the tests still self-skip rather than assert falsely.
  Verified without a `db reset` by forcing the empty-list branch, confirming
  both rows were really created, and watching the marker sweep remove them.
  **The real proof was finally taken 2026-08-08** — the substitute was only ever
  used because disk was down to 9.3 GB, and after the workspace and Docker moved
  to `D:` the reset cycle became affordable. `supabase db reset` (all 25
  migrations from scratch, leaving `properties=0 contacts=0`) then **run 1** of
  `csp.spec.ts`: 31 passed / 3 skipped, with `property detail` and `contact
  detail` — the two that used to fail on run 1 — both green via the seeding
  path, and `CSP-FIXTURE-%` / `csp-detail-fixture` counts back to 0 afterwards.
- **CSP report delivery cannot be confirmed "later" — Vercel log retention is
  ~1 hour on this plan (C1).** `/api/csp-report` sinks to stdout, and HANDOFF
  told the operator to browse production and then grep the runtime logs for
  `[csp]`. A 7-day query returns *"the requested window likely exceeds your
  plan's runtime-log retention (Hobby 1h, Pro 1 day…)"*, so any check made more
  than an hour after browsing will find nothing — and "no `[csp]` lines" would
  be misread as "the policy is clean" when it may mean "reports were never
  delivered, or expired". Those two must not be confused before anyone promotes
  the policy from Report-Only to enforced. Fix: browse and grep inside the same
  hour, or give the endpoint a durable sink (configure the Sentry DSN, which the
  handler already writes to, or add a Vercel Log Drain). Found 2026-07-29.
- ~~**Hosted has `service_role` EXECUTE grants that no migration produces (schema
  drift).**~~ **RESOLVED 2026-07-29 (migration 0022).** Diagnosed from the ACLs:
  hosted carried explicit `service_role=X/postgres` entries on `current_org_id`,
  `current_role_gnk` and `expire_mandates` — hand-applied, not role inheritance
  and not a platform default. Revoked rather than captured as a migration,
  because nothing needs them: the first two are RLS helpers and `service_role`
  bypasses RLS, and `expire_mandates` is pg_cron-only, run as `postgres`, which
  keeps its own grant (0007 §1 said exactly that). Verified no caller exists in
  app code, scripts or tests. `verify-restore.sql`'s expectations, which had
  encoded the drift, were corrected — a migration-built database now passes all
  25 invariants, where four failed before.
- ~~**`lib/supabase/client.ts` is dead code — and that is currently a security
  asset.**~~ **RESOLVED 2026-08-08 — deleted, and the property it provided is now
  ENFORCED instead of accidental.** The file was the only thing that would have
  put a Supabase credential in the browser, and nothing imported it, so "no
  Supabase key ships" was true by luck. `security.spec.ts` did not cover it
  either: it blocks `service_role` / `sb_secret_` and explicitly *permits*
  `sb_publishable_`, so the publishable key could have started shipping with the
  suite still green. The bundle-hygiene test now asserts **no Supabase key of any
  kind** reaches the browser, in both formats (`sb_*` prefix scan and a
  JWT-shaped scan for the legacy anon key), with a note telling whoever trips it
  that adding a browser client is legitimate and they should relax the assertion
  deliberately rather than delete the file it protects.

  **The guard was proved by a negative control, not assumed:** referencing
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` from a client component made the test fail, and
  reverting made it pass. Worth doing given this file's own §2b entry lists four
  ways a green test proved nothing.

  Original entry: `createBrowserClient` is called there and nowhere else; no module
  imports the exported `createClient`. Verified 2026-08-03: no JWT-shaped string
  and no `supabase.co` appears in any of the 63 chunks of a production
  `.next/static` build, so the browser receives no Supabase credential at all.
  Deleting it is the tidy answer, but note the consequence of the opposite
  choice: the day someone imports it, `NEXT_PUBLIC_SUPABASE_ANON_KEY` starts
  shipping to the browser. That is normal and safe for an anon/publishable key —
  it is *designed* to be public — but it should be a conscious decision rather
  than a side effect, and it changes what HANDOFF §2b step 4 can verify. Keep or
  delete deliberately; do not let it happen by accident.
- **`JWT issued at future` — third sighting, now with a deployment stamp.** Seen
  again on prod 2026-08-03T17:07:18Z, route `/properties`, count 1, users 1, on
  deployment `dpl_D3WRnCp…`. Same shape as 2026-07-19 and 2026-07-21: a
  slightly future-dated access token makes PostgREST reject the query and the
  user gets the "Couldn't load properties" boundary until they reload or
  re-login. Unrelated to the key rotation — this is the session JWT's `iat`, not
  the API key. It is now the only recurring runtime error in production, and
  `get_runtime_errors` on the Vercel connector makes it cheap to keep counting.

  **MEASURED 2026-08-08, and it rules the retry option OUT.** PostgREST already
  carries its own future-`iat` leeway, so the two options this entry had been
  carrying since 2026-07-19 are not equivalent — one of them cannot work.
  Swept a hand-signed token against the local stack at increasing offsets:

  | `iat` offset | result |
  |---|---|
  | +0s, +5s, +10s, +20s | **HTTP 200** — accepted |
  | +31s, +60s, +120s, +300s, +3600s | **HTTP 401** `PGRST303` `JWT issued at future` |

  The tolerance is ~30s. **So every rejection we have actually seen means the
  token was more than 30 seconds ahead** — which is a broken clock, not the
  sub-second blip the "one-shot retry" idea assumed. A retry would have to sleep
  30+ seconds to land past the boundary, which hangs the page for far longer than
  the error costs; capped at anything sane it never fires at all. A retry wrapper
  was written, unit-tested, and then **deleted rather than committed**, because
  it could only ever have been dead code (DECISIONS 2026-08-08).

  Also now known precisely: the code is **`PGRST303`** at **401**, so detection
  needs no message matching. And note Next redacts server-component error
  messages before they reach `app/(app)/error.tsx` — the browser gets a `digest`,
  not the text — so anything that branches on this must do so **server-side**.

  **Graceful degradation SHIPPED 2026-08-08.** `unwrapRows` routes `PGRST303` to
  a new `/session-clock` page instead of the boundary — it says the clock is
  ahead, that reloading will not help, and offers one button wired to the
  existing `logout()` server action. No auto sign-out (that needs a GET endpoint
  with a side effect, i.e. a logout-CSRF surface) and the page sits outside the
  `(app)` group, because that layout builds its own client and would loop.

  Confirmed by replaying a re-signed session against the running app: +0s/+20s
  render normally, **+31s through +120s land on `/session-clock`**. Which
  incidentally explains why this bug exists — **there are two tolerances.**
  PostgREST refuses from ~31s while GoTrue still calls the user authenticated at
  +120s, so the session passes `proxy.ts` and fails every query. Widening
  tolerance is not available: PostgREST's JWT settings are not exposed on
  Supabase.

  Still open, and now the only part: the underlying clock. This page makes the
  failure legible and one click from recovery; it does not stop a machine whose
  clock drifts half a minute.
- ~~**The signed slip PDF has no recorded hash anywhere.**~~ **RESOLVED
  2026-08-08 (migration 0026).** `viewing_slips.pdf_sha256` is written at signing
  time and the same value goes into the hash-chained `viewing_slip_signed`
  payload, which is the half that cannot be edited afterwards — a column alone
  would be as forgeable as the file. **Left NULL for the one pre-existing slip,
  deliberately:** hashing the bytes in Storage today would assert they are the
  bytes that were signed, which nobody can vouch for, and it would be
  indistinguishable from a hash taken at signing. A null says "unknown", which is
  true. Verified by signing a real slip through the real canvas, then
  re-downloading the PDF and re-hashing it — `sha256Hex(pdf)` returning the hash
  of its argument is trivially true and proves nothing about whether the stored
  value describes the stored file (`tests/e2e/slip-pdf-hash.spec.ts`).

  Originally diagnosed during the
  2026-08-05 Storage restore drill (BACKUP_RESTORE §4c). `viewing_slips` stores
  `signature_sha256` for the signature PNG, and event 60's payload carries that
  same hash — so a corrupted or substituted signature image is detectable. The
  slip **PDF** (`viewing_slips.pdf_path`) has no hash in the row and none in the
  event, so nothing can prove a restored slip PDF is byte-identical to the one
  that was signed. Evidence reports do not share the gap: their generation event
  carries `pdf_sha256`, and that is what made the drill's end-to-end proof
  possible. Fix is small — hash the PDF at generation and put it in the row and
  the `viewing_slip_signed` payload — but it is only forward-looking: the one
  existing slip stays unhashable, so the change wants a decision about whether to
  backfill from the current bytes (which asserts they are the right bytes) or
  leave it null.
