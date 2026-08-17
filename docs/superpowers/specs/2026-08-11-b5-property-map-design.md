# B5 — Map view for properties (design)

**Date:** 2026-08-11 · **Status:** design approved, not implemented
**Owner doc:** IMPROVEMENTS B5

## The premise in IMPROVEMENTS B5 is wrong, and that shaped this design

B5 says the `location geography(point,4326)` column is *"already populated by
`map-location-fields.tsx`… the data is sitting there unused."*

Checked on hosted 2026-08-11:

| claim | reality |
|---|---|
| the column exists | ✅ true — `geography`, PostGIS 3.3 enabled |
| already populated | ❌ **0 of 2 properties have coordinates** |
| data sitting there unused | ❌ there is no data; the **pipeline** is unused |

The write path works — `map-location-fields.tsx` takes lat/lng or a pasted
Google Maps link, and `lib/actions/properties.ts` converts it to EWKT, writes
`location`, and logs a readable coordinate diff to the hash-chained event log. It
was built and never used, which matches §0: every row in production is operator
test data.

**So a map built on `location` alone renders zero pins**, and would keep doing so
until someone hand-enters coordinates for every listing. That is the problem this
design solves first.

## Decisions taken

| question | decision |
|---|---|
| Where do coordinates come from? | **District/area centroids**, not a geocoding service |
| Precise coordinates | Still supported — the existing paste-a-link field is unchanged |
| Tile provider | **OpenFreeMap** — no account, no key, no limits, commercial use allowed |
| Filters | **Reuse `lib/queries/properties-list.ts`** so map and list cannot disagree |
| Radius draw | Client-side over the loaded set |

### Why centroids rather than geocoding

The obvious answer is to geocode the street address each property already has.
Two providers were checked rather than assumed:

- **Nominatim (public OSM instance)** — 1 request/second, 4/minute for anything
  bulk, a real `User-Agent` required, results **must** be cached, and
  *"commercial applications whose primary function involves geocoding … must run
  their own service."* A CRM's primary function is not geocoding, so it is
  arguably allowed — but "arguably" is not a basis for a commercial product.
- **Keyed free tiers** (Geoapify, LocationIQ) — clean terms, at the cost of an
  account, a key and a provider dependency.

Neither is worth it **at this scale**: 5 districts, 10 areas, 2 properties.
Street-level precision buys almost nothing when the alternative is 15 coordinates
entered once, and "every listing appears in the right part of Paphos on day one"
is the entire point of the screen.

**This is not a one-way door.** Geocoding can be added later with no rework: it
would populate the same `location` column, and the map would not change.

## Data model

Migration **`0031_area_centroids.sql`** adds `centroid geography(point,4326)` to
`districts` and `areas`, and seeds 15 values:

```
PAF Paphos      Chloraka · Geroskipou · Kato Paphos · Peyia/Coral Bay ·
                Tala/Tsada · Universal
LIM Limassol    Agios Athanasios · Agios Tychonas · City Centre/Molos ·
                Germasogeia
LAR Larnaca     (no areas)
NIC Nicosia     (no areas)
FAM Famagusta   (no areas)
```

**`FAM` is centred on the FREE AREA — Paralimni / Protaras / Ayia Napa — not on
Famagusta town.** Most of the district is in the north; a naive centroid lands in
occupied territory, which is wrong for a Republic-of-Cyprus agency both
commercially and politically. **Operator decision, 2026-08-11.** The migration
comment must say so, or someone will later "fix" it to the town.

Centroids live on the reference tables rather than being computed, so an admin can
correct one without a deploy. They are **deliberately approximate** — that is what
a centroid is — and the map itself is the check: a wrong one is obvious on sight.

**Where the 15 numbers come from:** public geography, written into the migration
as literals. They are approximate by design, so being a few hundred metres out is
not a defect — but a pin in the wrong village is, and the acceptance step is an
operator looking at the rendered map once. The implementation plan carries the
actual coordinates; they are not reproduced here so there is a single source of
truth for them.

### Position resolution

```
exact `properties.location`  →  else area centroid  →  else district centroid  →  else absent
```

A pin renders differently for **exact** versus **approximate**, so nobody mistakes
an area centroid for a surveyed point. A property with no location, no area and no
district does not appear, and that is correct rather than a bug to paper over.

## Components

| File | Responsibility |
|---|---|
| `supabase/migrations/0031_area_centroids.sql` | centroid columns + the 15 seeds |
| `lib/services/property-map.ts` | **pure**: resolve a position, build GeoJSON |
| `app/(app)/properties/map/page.tsx` | server component; parses filters, fetches rows |
| `components/features/properties/map-view.tsx` | client; MapLibre, dynamically imported |

**The map reuses `lib/queries/properties-list.ts`** — same `propertyFiltersSchema`,
same `resolvePropertyScope`, same rows. The map and the list therefore cannot
disagree about what a given filter set means. Filters travel in the **URL**, as
they do on the list: B1 already paid for the lesson that client-state filters over
a paged array silently lie.

**MapLibre is dynamically imported with `ssr: false`** — roughly 200 KB gzipped,
and it belongs on one screen rather than in every page's bundle.

**How anyone reaches it:** a **Map / List toggle on the properties list page**,
carrying the current filters straight through in the URL. Not a new sidebar
entry — the map is a second view of the properties list, not a second module, and
`modules.spec.ts` asserts the sidebar reaches every module without a dead link.
Switching view must preserve the filters, or the two views appear to disagree.

**Radius draw filters client-side** over the loaded set. PostGIS `ST_DWithin` is
available if volume ever justifies it; with 2 properties, a server round-trip per
circle drag is ceremony.

## CSP — the part that will bite

Add `https://tiles.openfreemap.org` to **`img-src`** and **`connect-src`** in
`lib/services/csp.ts`. The style JSON, vector tiles, glyphs and sprites all come
from that one origin.

**`worker-src` already allows `blob:`** — verified — so MapLibre's web workers
need no change.

**The policy has been ENFORCED since 2026-08-10.** A missing origin means a blank
map in production with nothing in the UI to explain it. `check:csp-nonce` will not
catch this — it only measures nonces. The check is: load the map page and assert
**zero CSP violations**, using the pattern already in `tests/e2e/csp.spec.ts`.
That test ships **with** the feature, not after it.

## Testing

1. **Unit — `lib/services/property-map.ts`.** Resolution order (exact beats area
   beats district), a property with none of the three is omitted, exact versus
   approximate is flagged, and the GeoJSON shape is correct.
2. **E2E — the map page.** It renders, it plots the seeded properties, and it
   reports **no CSP violation**.
3. **E2E — the empty state.** Today every property resolves to a centroid; the
   moment a district ships without one, a map with no pins must say why rather
   than render a blank grey rectangle.
4. **RLS — nothing new.** The map reads `properties` through the existing
   policies, including `require_aal2` from 0029. No new policy, no new grant.

## Out of scope

- **Geocoding from street addresses** — see above; addable later without rework.
- **Drawing/saving search areas as polygons.** B5 says "draw a radius"; persisting
  drawn shapes is a different feature.
- **Clustering.** Irrelevant at 2 properties, and premature before the desk has
  real volume.
- **A map on the buyer proposal pages (`/p/*`).** Those are anonymous and
  CSP-sensitive; adding a third-party origin to that surface is its own decision.
