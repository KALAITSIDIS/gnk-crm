# Portal syndication — choosing where a listing is advertised (design)

**Date:** 2026-09-14 · **Status:** design approved by the operator in conversation; implementation plan next
**Owner doc:** this file until the feature ships, then HANDOFF §0 and DECISIONS
**Phase note:** doc 01 §10 places "external portal XML feeds" in Phase 5 and makes the
Do-Not-Build list binding until then. The operator pulled this item forward on
2026-09-14. Record it in DECISIONS when the first migration lands.

## What this adds

Today a listing is advertised in exactly one place the CRM controls: the
marketing site, through the public feed (`/api/public/listings`). The operator
wants to choose, listing by listing, which external portals also carry it, and
to have those portals stay in step with the CRM without anyone re-typing a
sale, a price change or a withdrawal.

Every portal that matters for Cyprus stock is a paid membership the operator
holds outside the CRM. The CRM's job is therefore not "ten integrations"; it
is **one feed engine** that renders the same public listing data in each
portal's dialect, plus **one place to select** which listings each portal gets,
plus **one pull** for the single portal that returns leads through an API.

## Decisions taken

| question | decision |
|---|---|
| Which portals in year one | Bazaraki Pro, JamesEdition, Properstar (ListGlobally), Rightmove Overseas + Zoopla + OnTheMarket (through a feed provider), A Place in the Sun, RERA.cy, Thribee (Trovit/Mitula/Nestoria/Nuroa, free), Prian.ru. Spitogatos CY, home.cy, ImmoScout24, Green-Acres, Juwai are "later" (see appendix). |
| How the CRM reaches them | **Approach A, feed engine only.** The CRM publishes one pull feed per enabled portal at a tokenised URL. Push APIs (Rightmove RTDF, Zoopla RTL) are NOT built; a registered feed provider takes the CRM's Kyero feed and pushes for us. The dialect interface is the seam a push adapter would plug into later. |
| How a listing is chosen | **Per listing only.** No rules, no auto-include. A listing is on a portal iff someone selected it there. |
| What can leave | Only what the site feed would show: `visibility = 'public' and status = 'available'`. Not re-implemented — the portal route reads `public_listings` and keeps the selected references. A sold, withdrawn or archived listing drops off every portal at that portal's next pull with no extra code. |
| Coordinates | The public feed carries none. Portals get them ONLY for selected listings, through a separate function, and **an approximate location is never emitted as an exact coordinate**: RERA gets its `show_approximate_location=1`; dialects without such a flag get no coordinates for that listing. |
| Photos | Portal feeds reference a new **JPEG rendition** (`path_jpeg`, 1600 px, same watermark policy as `full`). RERA accepts JPEG/PNG only and four portals leave the format undocumented; WebP is a gamble the site can take and a portal cannot. |
| Leads back | **JamesEdition pulled through its Leads API; every other portal typed in by the agent** with a required "which portal" field. Inbound e-mail parsing is not built. |
| Where portal secrets live | Vercel environment, like every secret today (`JAMESEDITION_LEADS_TOKEN`, `CRON_SECRET`). Feed URLs carry a random path token; the data behind them is public anyway, so the token only makes the URL unguessable. |
| Where non-secret portal config lives | `portal_connections`, one row per org per portal, admin-write, same policy shape as `cyprus_config`. |
| Pull cadence for leads | Vercel Hobby runs a cron once a day, so the cron is the record-keeper and a "Fetch JamesEdition leads now" button is the fast path. A Pro plan makes the cron ten-minutely with a one-line schedule change. |
| Removal semantics | A **disabled** portal's URL answers `200` with an empty, valid document, never `404`. Every pull portal treats absence as removal; a 404 would leave stale listings on the portal. |
| Bazaraki and Prian | In the registry as `spec: "pending"`: they cannot be enabled until their serialisers exist. Bazaraki hands its XML spec to Pro accounts only; Prian sends its format on request to adv@prian.ru. |

## Components

```
lib/services/portals/
  registry.ts         one definition of each portal (id, dialect, requirements, spec status, settings schema)
  eligibility.ts      why a listing may or may not go to a portal — used by the feed AND the toggles
  feed-listing.ts     the shape dialects consume: public feed row + supplement (coords, jpeg images)
  dialects/
    kyero.ts          Kyero v3.9 — JamesEdition, A Place in the Sun, Properstar, UK feed provider
    rera.ts           RERA XML v2
    trovit.ts         Thribee (Trovit/Mitula/Nestoria/Nuroa)
    (bazaraki.ts, prian.ts — when their specs arrive)
  leads-jamesedition.ts   the Leads API pull
app/api/portals/[portal]/[token]/route.ts     the feed
app/api/cron/portal-leads/route.ts            the scheduled pull
lib/actions/portals.ts                        select / deselect / enable / disable / regenerate / pull-now
app/(app)/settings/portals/page.tsx           admin page
components/features/properties/portals-card.tsx
supabase/migrations/0095_portal_syndication.sql
scripts/media/backfill-jpeg.mts               one-off: JPEG rendition for existing photos
```

### Registry (`registry.ts`)

A `const` array, typed, exported once. A test pins the ids and a second test
asserts every id has a dialect that exists. Fields:

| field | meaning |
|---|---|
| `id` | `jamesedition`, `aplaceinthesun`, `properstar`, `uk_provider`, `rera`, `thribee`, `bazaraki`, `prian` |
| `name` | what the desk sees. `uk_provider` shows as "Rightmove, Zoopla & OnTheMarket (via feed provider)" — the provider fans one feed out to whichever UK memberships the operator holds; the CRM cannot pick Rightmove-yes/Zoopla-no, and says so. |
| `dialect` | `kyero` \| `rera` \| `trovit` \| `bazaraki` \| `prian` |
| `audience` | one line for the settings page (British, luxury international, Russian-speaking, …) |
| `spec` | `public` \| `pending`. Pending portals render with a badge and a disabled enable switch. |
| `requirements` | `minPhotos`, `needsCoords`, `languages` — consumed by `eligibility.ts` |
| `requiredSettings` | setting keys without which the enable switch refuses (`thribee`: `site_listing_url_template`) |
| `settingsSchema` | a zod object for the per-portal non-secret fields (below) |
| `pullCadence` | text for the desk ("three times a day", "daily 01:30 CET", "hourly") |
| `docsUrl` | the portal's own spec page |

Per-portal settings (all optional unless stated):

- Kyero dialect portals: `contact_number`, `whatsapp_number`, `email` (Kyero v3.7–3.9 nodes, emitted per property).
- `rera`: `agent_name`, `agent_phone`, `agent_email`.
- `thribee`: `site_listing_url_template` — in `requiredSettings`, so the portal cannot be enabled without it, e.g. `https://…/en/properties/{reference}`; Trovit needs the ad's URL on the agency's own site. Because enabling is refused without it, eligibility has no reason for it.

### Database (migration 0095)

**`portal_connections`**

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `org_id` | uuid → organizations | |
| `portal` | text | a registry id; validated in the app, pinned by test. No DB enum: the registry is the definition. |
| `enabled` | boolean default false | |
| `feed_token` | text unique | default `encode(gen_random_bytes(32),'hex')` |
| `settings` | jsonb default `{}` | validated by the registry's `settingsSchema` on write |
| `last_pulled_at`, `last_pulled_ua`, `last_pull_count` | timestamptz, text, int | written by the feed route on every pull |
| `leads_pulled_to` | timestamptz | JamesEdition only: the upper bound of the last successful pull |
| `created_at`, `updated_at`, `updated_by` | | |
| unique | `(org_id, portal)` | |

RLS: select for `org_id = current_org_id()`; insert/update by `current_role_gnk() = 'admin'`
only; the `require_aal2` restrictive policy like every table since 0029. No delete
policy (disable, don't delete).

**`portal_listings`**

| column | type | notes |
|---|---|---|
| `property_id` | uuid → properties on delete cascade | |
| `portal` | text | registry id |
| `org_id` | uuid | denormalised for RLS, same as everywhere |
| `selected_at`, `selected_by` | timestamptz, uuid → profiles | |
| pk | `(property_id, portal)` | |

RLS: org-scoped select; insert/delete by the same roles that may update a
property. Deselect is a `delete`; history lives in the events chain.

**`property_media.path_jpeg text`** — the fourth rendition. Null until backfilled.

**`leads`** — `portal text`, `external_ref text`, and
`check ((source = 'portal') = (portal is not null))` so a portal lead always
names its portal and a non-portal lead never does. Partial unique index
`(org_id, portal, external_ref) where external_ref is not null` makes a repeated
JamesEdition pull idempotent.

**Functions (SECURITY DEFINER, EXECUTE granted to `anon` by name, like 0066):**

- `portal_connection_by_token(p_portal text, p_token text)` → `(org_slug, enabled, settings)` or no row.
- `portal_supplement(p_token text)` → one row per selected listing that the site
  feed would show: `reference, lat, lng, location_approx, images jsonb`
  where `images` is `[{jpeg, alt}]` ordered cover-first then `sort_order`,
  photos only, `path_jpeg is not null`. This is the ONLY place coordinates
  leave the database for the public, and it answers only for selected rows.
- `note_portal_pull(p_token text, p_ua text, p_count int)` → updates the three
  "last pulled" columns.

`public_listings` and `public_listings_etag` are **untouched**: the site feed
stays byte-identical, RLS test 41's 36-column pin stays true, and "on a portal
⊆ on the site" is structural.

`submit_public_enquiry` gains four DEFAULTED parameters (the 0088 idiom, so a
pre-0095 database still answers the site): `p_source lead_source default
'website'`, `p_portal text default null`, `p_external_ref text default null`,
`p_received_at timestamptz default null` (coalesced into `received_at`). A
duplicate `(org_id, portal, external_ref)` returns `false` instead of raising.

### Eligibility (`eligibility.ts`)

`eligibilityFor(portal, listing, supplement, connection) → { ok: true } | { ok: false, reasons: Reason[] }`

Reasons, exhaustive and enumerated so the UI and the tests share them:

| reason | when |
|---|---|
| `not_public` | the listing is not in the site feed (visibility ≠ public or status ≠ available) — computed from the property row for the toggle; the feed never sees such rows at all |
| `no_price` | neither `asking_price` nor `rent_price_month` |
| `no_description_en` | `public_description.en` empty |
| `too_few_photos` | fewer than `minPhotos` JPEG renditions (JamesEdition: 2) |
| `no_coords` | portal `needsCoords` and no coordinates (RERA) |
| `type_unmapped` | the dialect has no mapping for this `property_type` |
| `city_unmapped` | RERA only: `district.en` / `area.en` does not resolve to one of its seven cities |
| `currency_unsupported` | RERA only: `currency` is not EUR |

The same function drives the feed (silently excludes) and the property card
(shows the reasons). One definition, two consumers, per the `isContainer` rule.

### The feed route

`GET /api/portals/[portal]/[token]` — public, unauthenticated by design;
`proxy.ts` exempts `/api/portals/` beside `/api/public/`. Anon client, exactly
like the listing feed.

1. `portal_connection_by_token`. No row → `404 {error}` with `no-store`. Bad
   `[portal]` for that token → `404` too (the token is bound to one portal).
2. Enabled `false` → `200`, the dialect's **empty document**, `Cache-Control: no-store`.
3. Page through `public_listings(org_slug, 100, offset)` up to the same
   `MAX_PAGES` ceiling gnk-web uses; keep rows whose `reference` is in
   `portal_supplement`. A valid token skips `note_public_listing_hit` — the
   token is the caller's proof. A wrong token costs one indexed lookup and a
   404 and is not metered: there is nothing behind it to protect, and a
   counter row would be the shared-lock problem REL-03 just removed.
4. Apply `eligibilityFor`; drop failures.
5. Serialise once with the dialect. `ETag = feedEtag(snapshot, body)` with the
   org's `public_listings_etag` snapshot, `Content-Type: application/xml;
   charset=utf-8`, `Cache-Control: public, max-age=300`, `304` on
   `If-None-Match`.
6. `after()`: `note_portal_pull(token, user-agent, count)`. A failed note never
   fails the feed.

Image URLs are `NEXT_PUBLIC_SUPABASE_URL + public media bucket + path_jpeg`,
absolutised the way `absolutizeListingImages` does today. Bucket paths are
stable per photo, which is what JamesEdition's crawler requires.

### Dialects

Each is a pure `(listings: FeedListing[], connection: Connection) => string`,
with its own `PROPERTY_TYPES` map and an `EMPTY` document. Common rules:

- UTF-8, the five XML specials escaped, all output through one `xml()` builder
  so no dialect concatenates strings.
- `id` = the listing `reference` (stable, unique per org, what the desk says on the phone).
- `date`/`lastmodified` = `updated_at`.
- Sale vs rent: `transaction_type = 'rent'` → the dialect's rent form with
  `rent_price_month`; `'sale'` or `'sale_or_rent'` → sale with `asking_price`.
  A listing marked sale-or-rent goes out once, as a sale (no portal in scope
  expresses both on one advert).
- Text: `title`, `short_description`, `public_description` JSON in `en`, `el`, `ru`.
  Emit the languages the dialect supports; `en` is required by eligibility.

| dialect | root | type map (from `property_type`) | text | coords | notes |
|---|---|---|---|---|---|
| `kyero` (v3.9) | `<root><kyero><feed_version>3</feed_version></kyero><property>…` | apartment→Apartment, villa→Villa, townhouse→Town House, house→House, land→Land, shop→Commercial, office→Commercial, building→Building, warehouse→Commercial, hotel→Hotel, mixed_use/other→unmapped | `<desc><en>`, `<ru>`; no Greek node in Kyero's list, so `el` is not emitted | `<location><latitude>/<longitude>` only when not approximate | `price_freq` sale/month; `beds`, `baths`, `surface_area><built>/<plot>`, `energy_rating`, `contact_number`, `whatsapp_number`, `email` from settings; max 50 images |
| `rera` (v2) | `<root><rera><feed_version>2</feed_version></rera><listing>…` | apartment→flat, villa/house/townhouse→house, land→land_plot, office→office, shop→trading_area, warehouse→warehouse, building→building, hotel→horeca, mixed_use/other→other (commercial) | English only (`<title>`, `<description>`); RERA translates | `<pin_map>` lat/lng required, `show_approximate_location` = `location_approx` | `deal_type` sale/rent, `offer_type` residential/commercial by type, `currency` EUR only (any other currency → reason `currency_unsupported`), `city` from `district.en`, overridden to Ayia Napa/Paralimni when `area.en` matches, `energy_class`, `full_area` = covered or plot |
| `trovit` | `<trovit><ad>…` | apartment/villa/townhouse/house/land/commercial per Thribee's `property_type` list | `<title>`, `<content>` in `en` | `<latitude>/<longitude>` only when not approximate | `<url>` from `site_listing_url_template`, `<type>` for_sale/for_rent, `<price>`, `<pictures><picture><picture_url>` |

Golden fixtures live beside each dialect; see Testing.

### Settings → Portals (admin)

`app/(app)/settings/portals/page.tsx`, one card per registry entry:

- enable/disable switch (disabled + badge when `spec: "pending"` or a required setting is missing);
- the feed URL with a copy button, and **Regenerate token** behind a confirm
  that says the portal must be given the new URL;
- the settings form from `settingsSchema`;
- the requirements list and pull cadence, in words;
- last pull: time, user agent, count — "never" until the portal has fetched once.

Actions in `lib/actions/portals.ts`: `setPortalEnabled`, `savePortalSettings`,
`regeneratePortalToken`. Each checks the affected row count and reports a
refusal instead of assuming RLS let it through (the recurring silent-update
defect). Each logs an event.

### Property page → Portals card

`components/features/properties/portals-card.tsx`, rendered on every property
page regardless of kind — the site feed shows any kind that is public and
available, and eligibility says the rest. For each **enabled** portal:

- a toggle; when `eligibilityFor` fails, disabled with the reasons in words;
- "selected by X on date" when on;
- the portal's last pull time, so "not selected" and "not yet fetched" read differently.

Actions: `selectPortal(propertyId, portal)` inserts; `deselectPortal` deletes;
both org-scoped, both check the affected count, both log an event with
`{ portal, reference }`. No `notifySite` — the site is unaffected by selection.

### Leads

**JamesEdition pull** (`leads-jamesedition.ts`):

- `GET https://jamesedition.com/api/leads?token=…&timestamp_from=…&timestamp_to=…`.
  Window: from `leads_pulled_to − 1 day` (overlap; dedupe absorbs it) to now, in
  ≤ 3-month chunks because the API refuses larger ranges. First run: 3 months back.
- Each lead → `submit_public_enquiry(org_slug, name, email, phone, message,
  listing.reference, 'portal', 'jamesedition', lead.id, created_at)`. Contact
  matching, consent basis, retention sweep and the permanent event come from
  the door, not from this file. Duplicates return `false` and are counted.
- No desk alert e-mail: JamesEdition already sent one.
- On success: `leads_pulled_to = now()`. On any failure the bound is not moved.
- `JAMESEDITION_LEADS_TOKEN` unset → skipped, loud once, same latch shape as `notifySite`.

Two callers: `app/api/cron/portal-leads/route.ts` (Vercel cron, `Authorization:
Bearer $CRON_SECRET`, `proxy.ts` exempts `/api/cron/`) and the server action
`pullPortalLeadsNow()` behind a button on the leads page, which returns
`{ created, duplicates, errors }` for a toast. `vercel.json` gains the cron at
`0 6 * * *` (Hobby: once a day).

**Manual entry**: `add-lead-dialog.tsx` shows a Portal select when Source is
"portal", required, options from the registry (all of them, not only enabled —
an agent may log a lead from a portal the operator lists on by hand). The
leads list gains a portal filter.

### Operations

- Env: `JAMESEDITION_LEADS_TOKEN`, `CRON_SECRET`. Set with the Vercel CLI
  (its own token lives in `~/.gnk-crm/backup.env`; a non-TTY shell cannot log
  in interactively); redeploy after, because Vercel binds env at build time.
- `proxy.ts`: exempt `/api/portals/` and `/api/cron/`.
- The cron-health banner counts pg_cron jobs and is untouched.
- Backfill: `scripts/media/backfill-jpeg.mts` re-derives `path_jpeg` from each
  photo's stored `full` rendition (no original needed), idempotent, prints
  counts. Run once on hosted after 0095.
- DECISIONS entry for the phase pull-forward; HANDOFF §0 row.

### Operator runbook (outside the code)

1. **JamesEdition**: buy a membership; ask the account manager to connect a
   Kyero-format feed at the CRM's URL; run their "Validate your feed" page on
   it; take the Leads API token from the Seller Dashboard into Vercel.
2. **A Place in the Sun**, **Properstar**: give each its own CRM feed URL (Kyero).
3. **Rightmove Overseas / Zoopla / OnTheMarket**: take the membership(s); pick a
   feed provider from Rightmove's supported list that accepts Kyero XML; give
   the provider the `uk_provider` URL; e-mail Zoopla Member Services the
   branch id so the provider may feed it.
4. **RERA.cy**: register; give them the `rera` URL. Their validator is "coming
   soon"; until then the golden test is the check.
5. **Thribee**: register at Trovit/Mitula for real estate; give the `thribee` URL.
6. **Bazaraki Pro**: open the account, obtain the XML spec, hand it to the next
   build; the `bazaraki` entry then loses its pending badge.
7. **Prian.ru**: write to adv@prian.ru for the XML format and the pay-per-contact
   terms; same path as Bazaraki.

## Testing

- **Dialects**: golden XML per dialect from fixtures of the shape production
  writes — a sale villa with three languages and exact coordinates, a rent
  apartment, a land plot, an approximate-location listing, a listing with one
  photo (must be absent for JamesEdition), a commercial unit. Assert
  well-formedness and every required tag; assert the approximate listing has no
  coordinates in `kyero`/`trovit` and `show_approximate_location=1` in `rera`.
- **Eligibility**: one test per reason; one that a listing passing everything
  returns `ok`.
- **RLS** (vitest.rls): `portal_connections` unreadable cross-org, unwritable
  by agent; `portal_listings` org-scoped; `anon` can execute exactly the three
  new functions and nothing else new; `portal_supplement` returns nothing for
  an unselected listing and nothing for a selected-but-not-public one.
- **Route**: bad token 404; disabled portal → the dialect's empty document with
  200; a sold listing absent; `If-None-Match` → 304; a valid token does not
  increment the public hit counter.
- **Mutation, read paths only** (never the events hash): comment out the
  selection join and prove a test goes red; comment out the eligibility call
  and prove a test goes red.
- **Leads**: a recorded Leads API JSON fixture; a second pull of the same
  fixture creates zero leads; a lead naming an unknown reference lands without
  a property; unset token → skipped.
- **e2e**: enable a portal in settings, select a listing, fetch the feed, see
  the reference; deselect, fetch, gone.

Assertions must fail on the day they are wrong, not rarely: no clock-dependent
windows in the dialect tests (fix `updated_at` in fixtures).

## Not built, on purpose

- Push adapters, an outbox, certificates, Rightmove/Zoopla provider registration by GNK.
- Inbound e-mail parsing for portals that only e-mail leads.
- Per-portal analytics, per-portal photo order or captions, per-portal price.
- Rules or auto-inclusion of new listings.
- Bazaraki and Prian serialisers before their documents exist.
- home.cy, Spitogatos CY, ImmoScout24, Green-Acres, Juwai (appendix).

## Milestones for the plan

1. Migration 0095 (tables, functions, `path_jpeg`, enquiry door params), registry,
   eligibility, Kyero dialect, feed route, settings page, property card, backfill.
   Ships JamesEdition, A Place in the Sun, Properstar and the UK provider.
2. RERA and Thribee dialects.
3. JamesEdition leads pull, cron, button, manual portal field and filter.

---

## Appendix — the portal landscape as researched 2026-09-14

Buyer mix: foreign buyers took 41% of Cyprus sale contracts Jan–Jul 2026 and
69.8% in Paphos; the largest groups are British, Russian, Israeli and Greek.

Traffic from Cyprus to real-estate sites, Semrush July 2026: bazaraki.com 883K
visits/month; offer.com.cy 102K; rightmove.co.uk 40K; spitogatos.gr 33K;
spitogatos.com.cy 20K; zoopla.co.uk 18K; home.cy self-reports 119K uniques in
March 2026 and 2,761 leads. buysellcyprus, altamira and dom.com.cy also rank
but are agencies' own sites.

| portal | buyers | connect | leads back | cost | evidence of Paphos agencies |
|---|---|---|---|---|---|
| Bazaraki Pro | Cyprus domestic | pulls your XML; spec to Pro accounts only | phone/e-mail on ad | Pro packages | — |
| JamesEdition | luxury international | pulls 3×/day (00:11, 08:11, 16:11 UTC); Kyero or JE XML 3.9; ≥2 photos; stable image URLs; UA `JamesEdition Feed Crawler 1.0` | **Leads Pull API** (token, ≤3-month windows) | Featured/Elite/Elite Plus; ~€3k per 7 months reported | SPM.estate, Zyprus, KW Seven Paphos, Cyprus Golden Properties, Elegant Cyprus Properties, Property Canvas, Aristo, Pafilia |
| A Place in the Sun | British | pulls XML (Kyero) | e-mail | quote | — |
| Properstar / ListGlobally | worldwide, 100+ portals | pulls Kyero, OpenImmo, Rightmove, Trovit… | dashboard | subscription | FOX, Cyprus Emerald; 4,065 Paphos results |
| Rightmove Overseas | British | push (RTDF JSON) via a supported feed provider, or manual in Rightmove Plus | e-mail campaigns | membership, quote | Cyprus101/Bettabilt, Cyprus Resale Properties, Cyprus Property Finder, Chestertons Global, WaterfrontCyprus, FOX |
| Zoopla Overseas | British | push (RTL JSON, mutual TLS, CSR + verbal verification) via provider | e-mail | membership | — |
| OnTheMarket Overseas | British; lists Cyprus | via provider | e-mail | membership | — |
| RERA.cy | Cyprus domestic | pulls hourly; RERA XML v2, EUR only, EN/EL/RU, cities enumerated, coordinates required with approximate flag | unknown | private startup, not the regulator | — |
| home.cy | Cyprus domestic | API / partner software; formats not public | leads dashboard | Standard/Plus/Premium | — |
| Spitogatos CY | Greek | agency back office; feed undocumented | assignment requests | contact | — |
| Prian.ru | Russian-speaking | their XML at a stable URL, sent to adv@prian.ru | pay per contact | unlimited listings | FOX, Bettabilt, Cyprus Sotheby's, John Taylor, TEKCE |
| Homesoverseas.ru, Realting.com | Russian-speaking | own XML / data export | — | — | 30 Cyprus agencies; Sotheby's Paphos on Realting |
| Thribee (Trovit, Mitula, Nestoria, Nuroa) | search engines | one free XML in Trovit format | click-through | free | — |
| ImmoScout24 | German-speaking; Cyprus section holds 3,400+ apartments | REST API, OAuth, contract | — | contract | — |
| Green-Acres | FR/BE/NL | own XSD, daily HTTP collection or FTP | e-mail | invoiced per listing | — |
| Juwai | Chinese | FTP, Juwai XML or Rightmove format, 4:3 JPEG | — | from ~$40/month | — |
| Tranio | investors | partnership: 30+ listings, 3 years, commission split, Tranio XML | — | commission | — |
| Israeli buyers | 3rd group | no portal found; BMBY is a sales system; reach is via Hebrew marketing agencies | — | — | gap |
| Kyero | ES/PT/FR/IT | does not list Cyprus; **its XML format is the lingua franca** | — | — | — |

Sources consulted: help.kyero.com XML import specification (V3.9, 2024-09-03);
docs.jamesedition.com (Getting Started, Real Estate single office, Leads Pull
API, Connect your CRM); help.properstar.com CRM compatibility;
xml.rera.cy import specification; pro.bazaraki.com; www.aplaceinthesun.com
list-your-properties; www.green-acres.fr GatewayInfo; support-docs.juwai.com;
www.zoopla.co.uk realtime-documentation; www.rightmove.co.uk overseas
advertise pages and adf.html; tranio.com/import; prian.ru/about; home.cy/pro/agents;
semrush.com trending-websites/cy/real-estate; cyprus-mail.com 2026-09-13 on
foreign buyers; cyprus-property-buyers.com on nationalities.
