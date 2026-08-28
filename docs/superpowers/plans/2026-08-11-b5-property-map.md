> # ✅ COMPLETE — SHIPPED. DO NOT EXECUTE.
>
> Delivered as migration **0031** (`area_centroids`), live on hosted since
> 2026-08-11, with a second pass on 2026-08-20 adding click-through,
> clustering, fit-to-results and price. Radius draw was DECLINED by the
> operator. See IMPROVEMENTS.md B5.
>
> The checkboxes below were never ticked. **Their unticked state is
> bookkeeping, not outstanding work.**

# B5 Property Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A map view of the properties list where every listing appears immediately, positioned by its exact coordinate if it has one and by its area or district centroid otherwise.

**Architecture:** Migration 0031 adds a `centroid` to `districts` and `areas` and seeds 15 values. A pure module resolves each property to a position and emits GeoJSON. A server page reuses the existing properties-list query module so the map and list can never disagree, and a dynamically-imported MapLibre client renders OpenFreeMap tiles.

**Tech Stack:** PostGIS, MapLibre GL JS, OpenFreeMap tiles, Next.js App Router, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-11-b5-property-map-design.md`

---

## Preconditions

- Docker running, local stack healthy: `docker ps --filter name=supabase_db_gnk-crm`.
- Local migrations at 30: `select count(*) from supabase_migrations.schema_migrations`.
- Branch off `main` — do not work on `main`.

## Facts established before this plan (do not re-derive)

- `properties.location` is `geography`, PostGIS 3.3 enabled, and **0 of 2 rows are populated**.
- `districts`: `id, org_id, code, name (jsonb en/el/ru), sort_order`. `areas`: `id, org_id, district_id, name (jsonb)`. **Areas have no `code`** — they are matched by `name->>'en'`.
- Reusable exports in `lib/queries/properties-list.ts`: `parsePropertyFilters`, `applyPropertyListFilters`, `mandateEmbed`, `fetchMandateExcludeIds`.
- `lib/services/csp.ts` builds `img` and `connect` arrays; **`worker-src` already includes `blob:`** so MapLibre's workers need no change.
- `tests/e2e/csp.spec.ts` already collects `securitypolicyviolation` events — reuse that pattern, do not invent another.
- `maplibre-gl` is **not** currently a dependency.
- The seed org is `00000000-0000-0000-0000-000000000001`.

> **EWKT PUTS LONGITUDE FIRST.** `SRID=4326;POINT(lng lat)`. Getting this backwards puts every Cyprus property in Somalia, and it will look plausible in the database. Every coordinate in this plan is written **lng lat** in SQL and **{ lat, lng }** in TypeScript — check which one you are editing.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0031_area_centroids.sql` (create) | `centroid` columns + 15 seeded values |
| `lib/services/property-map.ts` (create) | **pure**: resolve a position, build GeoJSON |
| `lib/services/property-map.test.ts` (create) | unit tests for the resolver |
| `lib/services/csp.ts` (modify) | add the OpenFreeMap origin |
| `app/(app)/properties/map/page.tsx` (create) | server component; filters + fetch |
| `components/features/properties/map-view.tsx` (create) | client; MapLibre |
| `app/(app)/properties/page.tsx` (modify) | Map/List toggle |
| `tests/e2e/property-map.spec.ts` (create) | renders, no CSP violation, empty state |

---

### Task 1: Migration 0031 — centroids

**Files:**
- Create: `supabase/migrations/0031_area_centroids.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0031 — district and area centroids, so every property can be mapped.
--
-- IMPROVEMENTS B5 claimed properties.location was "already populated". It is
-- not: checked 2026-08-11, 0 of 2 rows have coordinates. The write path works
-- (map-location-fields.tsx -> lib/actions/properties.ts) and was simply never
-- used, so a map keyed on location alone would render zero pins indefinitely.
--
-- Centroids give every listing a position on day one. A property resolves to its
-- exact location if it has one, else its area centroid, else its district
-- centroid. Approximate pins render differently from exact ones so nobody reads
-- a centroid as a surveyed point.
--
-- Stored rather than computed: these are fixed Cyprus geography, and storing them
-- lets an admin correct one without a deploy.
--
-- COORDINATES ARE APPROXIMATE BY DESIGN. A few hundred metres out is fine; a pin
-- in the wrong village is not. The acceptance check is an operator looking at the
-- rendered map once.
--
-- FAM IS DELIBERATELY NOT FAMAGUSTA TOWN. Most of that district is in the north,
-- so a naive centroid lands in occupied territory. Operator decision 2026-08-11:
-- centre it on the FREE AREA — Paralimni / Protaras / Ayia Napa. Do not "correct"
-- this to the town.
--
-- EWKT IS `POINT(lng lat)` — LONGITUDE FIRST. Reversed, every property lands off
-- the Somali coast and still looks like valid data.

alter table districts add column if not exists centroid geography(point,4326);
alter table areas     add column if not exists centroid geography(point,4326);

comment on column districts.centroid is
  'Approximate centre of the district, used to place a property that has no exact '
  'location and no area centroid. FAM is the FREE AREA (Paralimni), not Famagusta '
  'town — see migration 0031.';
comment on column areas.centroid is
  'Approximate centre of the area, used to place a property that has no exact '
  'location. Preferred over the district centroid.';

update districts set centroid = case code
  when 'PAF' then 'SRID=4326;POINT(32.4245 34.7754)'::geography
  when 'LIM' then 'SRID=4326;POINT(33.0226 34.7071)'::geography
  when 'LAR' then 'SRID=4326;POINT(33.6201 34.9182)'::geography
  when 'NIC' then 'SRID=4326;POINT(33.3823 35.1856)'::geography
  when 'FAM' then 'SRID=4326;POINT(33.9832 35.0378)'::geography  -- Paralimni, free area
  else centroid
end
where code in ('PAF','LIM','LAR','NIC','FAM');

update areas a set centroid = v.pt
from (values
  ('Kato Paphos',        'SRID=4326;POINT(32.4090 34.7550)'),
  ('Universal',          'SRID=4326;POINT(32.4160 34.7690)'),
  ('Chloraka',           'SRID=4326;POINT(32.4100 34.7900)'),
  ('Geroskipou',         'SRID=4326;POINT(32.4600 34.7600)'),
  ('Peyia / Coral Bay',  'SRID=4326;POINT(32.3670 34.8830)'),
  ('Tala / Tsada',       'SRID=4326;POINT(32.4300 34.8300)'),
  ('City Centre / Molos','SRID=4326;POINT(33.0430 34.6750)'),
  ('Germasogeia',        'SRID=4326;POINT(33.0850 34.7180)'),
  ('Agios Athanasios',   'SRID=4326;POINT(33.0480 34.7080)'),
  ('Agios Tychonas',     'SRID=4326;POINT(33.1230 34.7160)')
) as v(name_en, pt)
where a.name->>'en' = v.name_en;
```

- [ ] **Step 2: Apply and verify every centroid landed**

```bash
cd "D:/dev/TSOPOZIDIS/gnk-crm" && npx supabase db reset
docker exec -i supabase_db_gnk-crm psql -U postgres -d postgres -c "
select 'districts' t, count(*) total, count(centroid) with_centroid from districts
union all
select 'areas', count(*), count(centroid) from areas;"
```

Expected: districts **5 / 5**, areas **10 / 10**. A mismatch means a name in the
`values` list does not match `name->>'en'` exactly — fix the name, not the query.

- [ ] **Step 3: Sanity-check the coordinates are actually in Cyprus**

```bash
docker exec -i supabase_db_gnk-crm psql -U postgres -d postgres -c "
select code, round(st_y(centroid::geometry)::numeric,4) lat,
              round(st_x(centroid::geometry)::numeric,4) lng
from districts order by sort_order;"
```

Expected: every `lat` between **34.5 and 35.7**, every `lng` between **32.2 and
34.6**. Anything outside that is the lng/lat swap — Cyprus is at roughly 35N 33E,
so a swapped pair reads as 33N 35E and is instantly recognisable.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0031_area_centroids.sql
git commit -m "0031: district and area centroids so every property can be mapped"
```

---

### Task 2: The pure resolver

**Files:**
- Create: `lib/services/property-map.ts`
- Create: `lib/services/property-map.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { resolvePosition, toGeoJson, type MappableProperty } from "./property-map";

const base: MappableProperty = {
  id: "p1",
  reference: "PAF-0001",
  location: null,
  areaCentroid: null,
  districtCentroid: null,
};

describe("resolvePosition", () => {
  it("prefers the exact location over both centroids", () => {
    expect(
      resolvePosition({
        ...base,
        location: { lat: 34.75, lng: 32.41 },
        areaCentroid: { lat: 34.9, lng: 32.3 },
        districtCentroid: { lat: 34.7, lng: 32.4 },
      }),
    ).toEqual({ lat: 34.75, lng: 32.41, precision: "exact" });
  });

  it("falls back to the area centroid before the district", () => {
    expect(
      resolvePosition({
        ...base,
        areaCentroid: { lat: 34.9, lng: 32.3 },
        districtCentroid: { lat: 34.7, lng: 32.4 },
      }),
    ).toEqual({ lat: 34.9, lng: 32.3, precision: "approximate" });
  });

  it("falls back to the district centroid last", () => {
    expect(
      resolvePosition({ ...base, districtCentroid: { lat: 34.7, lng: 32.4 } }),
    ).toEqual({ lat: 34.7, lng: 32.4, precision: "approximate" });
  });

  // Not a bug to paper over: a property with no location, no area and no
  // district genuinely cannot be placed, and inventing a position would be worse
  // than omitting it.
  it("returns null when there is nothing to place it by", () => {
    expect(resolvePosition(base)).toBeNull();
  });
});

describe("toGeoJson", () => {
  it("emits one feature per placeable property and omits the rest", () => {
    const fc = toGeoJson([
      { ...base, id: "a", location: { lat: 34.75, lng: 32.41 } },
      { ...base, id: "b", districtCentroid: { lat: 34.7, lng: 32.4 } },
      { ...base, id: "c" },
    ]);

    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(2);
    expect(fc.features.map((f) => f.properties.id)).toEqual(["a", "b"]);
  });

  // GeoJSON is [lng, lat] — the opposite order to how humans say it, and the
  // single easiest way to put Cyprus in the Indian Ocean.
  it("writes coordinates as [lng, lat]", () => {
    const fc = toGeoJson([{ ...base, id: "a", location: { lat: 34.75, lng: 32.41 } }]);
    expect(fc.features[0].geometry.coordinates).toEqual([32.41, 34.75]);
  });

  it("carries precision through so the pin can render differently", () => {
    const fc = toGeoJson([
      { ...base, id: "a", location: { lat: 1, lng: 2 } },
      { ...base, id: "b", areaCentroid: { lat: 3, lng: 4 } },
    ]);
    expect(fc.features.map((f) => f.properties.precision)).toEqual([
      "exact",
      "approximate",
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- property-map`
Expected: FAIL — cannot resolve `./property-map`.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Turning properties into map pins (IMPROVEMENTS B5).
 *
 * Pure and dependency-free so it can be unit tested without a database or a
 * browser: the page fetches, this decides, the client draws.
 *
 * WHY CENTROIDS EXIST AT ALL: properties.location is populated by hand and, as
 * of 2026-08-11, no production row had it set. Keying the map on exact
 * coordinates alone would have shipped a permanently empty screen.
 */

export type LatLng = { lat: number; lng: number };

export type MappableProperty = {
  id: string;
  reference: string;
  location: LatLng | null;
  areaCentroid: LatLng | null;
  districtCentroid: LatLng | null;
};

export type Precision = "exact" | "approximate";

export type Position = LatLng & { precision: Precision };

export type PropertyFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { id: string; reference: string; precision: Precision };
};

export type PropertyFeatureCollection = {
  type: "FeatureCollection";
  features: PropertyFeature[];
};

/**
 * Exact location wins, then the area centroid, then the district centroid.
 * Returns null when the property cannot be placed at all — the caller omits it
 * rather than inventing a position.
 */
export function resolvePosition(p: MappableProperty): Position | null {
  if (p.location) return { ...p.location, precision: "exact" };
  if (p.areaCentroid) return { ...p.areaCentroid, precision: "approximate" };
  if (p.districtCentroid) return { ...p.districtCentroid, precision: "approximate" };
  return null;
}

export function toGeoJson(properties: MappableProperty[]): PropertyFeatureCollection {
  const features: PropertyFeature[] = [];

  for (const p of properties) {
    const pos = resolvePosition(p);
    if (!pos) continue;
    features.push({
      type: "Feature",
      // GeoJSON is [lng, lat]. Opposite to how humans say it; getting it
      // backwards is the single most common way to lose a map.
      geometry: { type: "Point", coordinates: [pos.lng, pos.lat] },
      properties: { id: p.id, reference: p.reference, precision: pos.precision },
    });
  }

  return { type: "FeatureCollection", features };
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- property-map`
Expected: PASS, `Tests  7 passed (7)`.

- [ ] **Step 5: Commit**

```bash
git add lib/services/property-map.ts lib/services/property-map.test.ts
git commit -m "B5: pure resolver from property to map position"
```

---

### Task 3: The CSP origin and the MapLibre dependency

**Files:**
- Modify: `lib/services/csp.ts`
- Modify: `package.json` (via npm)
- Modify: `lib/services/csp.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `lib/services/csp.test.ts`, inside the existing top-level `describe`:

```ts
  // The policy is ENFORCED (C1, 2026-08-10). A missing tile origin does not warn
  // — it renders a blank map in production with nothing in the UI to say why.
  it("allows the OpenFreeMap tile origin on img-src and connect-src", () => {
    const csp = buildCsp({ nonce: "n", isDev: false });
    expect(directive(csp, "img-src")).toContain("https://tiles.openfreemap.org");
    expect(directive(csp, "connect-src")).toContain("https://tiles.openfreemap.org");
  });
```

`directive()` is the existing helper in that file — do not write another.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- csp`
Expected: FAIL — the origin is absent from both directives.

- [ ] **Step 3: Add the origin**

In `lib/services/csp.ts`, immediately after the `const img = [...]` / `const connect = [...]` declarations and before the `if (supabase)` block, add:

```ts
  // OpenFreeMap serves the style JSON, vector tiles, glyphs and sprites for the
  // property map (IMPROVEMENTS B5) from this one origin. No account, no key.
  // `worker-src` already allows blob:, which is what MapLibre's workers need.
  const TILES = "https://tiles.openfreemap.org";
  connect.push(TILES);
  img.push(TILES);
```

- [ ] **Step 4: Run the tests**

Run: `npm test -- csp`
Expected: PASS.

- [ ] **Step 5: Install MapLibre**

```bash
cd "D:/dev/TSOPOZIDIS/gnk-crm" && npm install maplibre-gl
```

- [ ] **Step 6: Commit**

```bash
git add lib/services/csp.ts lib/services/csp.test.ts package.json package-lock.json
git commit -m "B5: allow the OpenFreeMap origin and add maplibre-gl"
```

---

### Task 4: The map page

**Files:**
- Create: `app/(app)/properties/map/page.tsx`

- [ ] **Step 1: Write the page**

```tsx
import Link from "next/link";
import { List } from "lucide-react";
import { PropertyMap } from "@/components/features/properties/map-view";
import { Button } from "@/components/ui/button";
import {
  applyPropertyListFilters,
  parsePropertyFilters,
} from "@/lib/queries/properties-list";
import { toGeoJson, type MappableProperty } from "@/lib/services/property-map";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";

type SearchParams = { [key: string]: string | string[] | undefined };

/**
 * Map view of the properties list (IMPROVEMENTS B5).
 *
 * Deliberately a SECOND VIEW of the list rather than a new module: it reuses
 * parsePropertyFilters and applyPropertyListFilters so the two views cannot
 * disagree about what a filter set means.
 */
export default async function PropertiesMapPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const filters = parsePropertyFilters(sp);
  const supabase = await createClient();

  const query = applyPropertyListFilters(
    supabase
      .from("properties")
      .select(
        "id, reference, location, areas(centroid), districts(centroid)",
      ),
    filters,
  );

  const rows = unwrapRows(await query);

  const mappable: MappableProperty[] = rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    location: parsePoint(r.location),
    areaCentroid: parsePoint(r.areas?.centroid),
    districtCentroid: parsePoint(r.districts?.centroid),
  }));

  const geojson = toGeoJson(mappable);
  const search = new URLSearchParams(
    Object.entries(sp).flatMap(([k, v]) =>
      typeof v === "string" ? [[k, v] as [string, string]] : [],
    ),
  ).toString();

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Properties — map</h1>
        <Button asChild variant="outline">
          <Link href={`/properties${search ? `?${search}` : ""}`}>
            <List className="mr-2 size-4" />
            List
          </Link>
        </Button>
      </div>
      <PropertyMap data={geojson} />
    </div>
  );
}

/** PostGIS returns a point as EWKB hex or GeoJSON depending on the client; the
 *  REST API gives us GeoJSON-shaped objects. Anything else is treated as absent
 *  rather than guessed at. */
function parsePoint(value: unknown): { lat: number; lng: number } | null {
  if (!value || typeof value !== "object") return null;
  const coords = (value as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lng, lat] = coords;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return { lat, lng };
}
```

- [ ] **Step 2: Confirm it type-checks**

Run: `npm run typecheck`
Expected: clean. If `areas`/`districts` embed types complain, regenerate types:
`npx supabase gen types typescript --local > lib/supabase/database.types.ts`, then
re-run and commit the regenerated file with this task.

- [ ] **Step 3: Commit**

```bash
git add "app/(app)/properties/map/page.tsx" lib/supabase/database.types.ts
git commit -m "B5: map page reusing the properties list filters"
```

---

### Task 5: The MapLibre client component

**Files:**
- Create: `components/features/properties/map-view.tsx`

- [ ] **Step 1: Write the component**

```tsx
"use client";

import { useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import type { PropertyFeatureCollection } from "@/lib/services/property-map";

/**
 * MapLibre over OpenFreeMap tiles (IMPROVEMENTS B5).
 *
 * OpenFreeMap needs no account, no key and no rate limit, and permits commercial
 * use. Its origin is allowed in lib/services/csp.ts — the CSP is ENFORCED, so
 * removing that entry blanks this map in production with no UI error.
 *
 * Attribution is required and MapLibre renders it automatically from the style.
 */
function MapImpl({ data }: { data: PropertyFeatureCollection }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    let cancelled = false;
    let map: import("maplibre-gl").Map | undefined;

    void (async () => {
      const maplibre = await import("maplibre-gl");
      await import("maplibre-gl/dist/maplibre-gl.css");
      if (cancelled || !container.current) return;

      map = new maplibre.Map({
        container: container.current,
        style: "https://tiles.openfreemap.org/styles/liberty",
        center: [33.0, 34.9], // Cyprus, [lng, lat]
        zoom: 8,
      });

      map.on("load", () => {
        if (!map) return;
        map.addSource("properties", { type: "geojson", data });
        map.addLayer({
          id: "property-pins",
          type: "circle",
          source: "properties",
          paint: {
            "circle-radius": 7,
            // Exact and approximate must be visually distinct: an area centroid
            // is not a surveyed point and must not look like one.
            "circle-color": [
              "case",
              ["==", ["get", "precision"], "exact"],
              "#0f766e",
              "#f59e0b",
            ],
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
          },
        });
      });
    })();

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [data]);

  return (
    <div className="flex flex-1 flex-col gap-2">
      <div
        ref={container}
        data-testid="property-map"
        className="min-h-[480px] flex-1 rounded-[10px] border border-border"
      />
      <p className="text-xs text-text-2">
        Amber pins are approximate — positioned by area or district because the
        property has no exact coordinates. Set them on the property page.
      </p>
      {data.features.length === 0 && (
        <p data-testid="property-map-empty" className="text-sm text-text-2">
          No properties can be placed on the map yet. Add coordinates on a
          property, or set a centroid for its district in Settings.
        </p>
      )}
    </div>
  );
}

/** ssr:false keeps ~200 KB of MapLibre out of every other page's bundle. */
export const PropertyMap = dynamic(() => Promise.resolve(MapImpl), {
  ssr: false,
  loading: () => (
    <div className="min-h-[480px] flex-1 animate-pulse rounded-[10px] bg-surface-2" />
  ),
});
```

- [ ] **Step 2: Typecheck and lint**

```bash
npm run typecheck && npm run lint
```
Expected: both clean.

- [ ] **Step 3: Commit**

```bash
git add components/features/properties/map-view.tsx
git commit -m "B5: MapLibre view with exact and approximate pins"
```

---

### Task 6: The Map/List toggle

**Files:**
- Modify: `app/(app)/properties/page.tsx`

- [ ] **Step 1: Add the toggle next to the existing Export button**

In `app/(app)/properties/page.tsx`, add `Map` to the existing `lucide-react`
import.

The page already builds `exportHref` at roughly line 142 with exactly the logic
this needs — every active filter, `page` excluded. **Generalise it rather than
writing a second copy**, because two copies of "which params travel" will drift
and the two views will silently disagree. Replace the `exportHref` IIFE with:

```tsx
  // Both Export and Map carry the active filters but not pagination — the whole
  // filtered set, RLS-scoped to what this user can see. ONE source of truth for
  // which params travel: a second copy would drift from this one.
  const filterQuery = (() => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (k === "page") continue;
      const val = first(v);
      if (val) params.set(k, val);
    }
    const qs = params.toString();
    return qs ? `?${qs}` : "";
  })();

  const exportHref = `/properties/export${filterQuery}`;
  const mapHref = `/properties/map${filterQuery}`;
```

Then add this button immediately before the existing Export button in the header
actions:

```tsx
        <Button asChild variant="outline">
          <Link href={mapHref}>
            <Map className="mr-2 size-4" />
            Map
          </Link>
        </Button>
```

- [ ] **Step 2: Verify the round trip by hand**

```bash
npm run dev
```

Open `/properties`, apply a district filter, click **Map**, and confirm the URL
keeps the filter and the map shows only those properties. Click **List** and
confirm the filter survives the return trip.

- [ ] **Step 3: Commit**

```bash
git add "app/(app)/properties/page.tsx"
git commit -m "B5: Map/List toggle carrying the filters through"
```

---

### Task 7: E2E — renders, no CSP violation, empty state

**Files:**
- Create: `tests/e2e/property-map.spec.ts`

- [ ] **Step 1: Write the test**

```ts
import { test, expect } from "@playwright/test";

/**
 * The property map (IMPROVEMENTS B5).
 *
 * The CSP violation assertion is the point of this file. The policy has been
 * ENFORCED since 2026-08-10, so a missing tile origin does not warn — it renders
 * a blank map in production with nothing in the UI to explain it, and
 * check:csp-nonce cannot catch it because it only measures nonces.
 */
test("the map renders and provokes no CSP violation", async ({ page }) => {
  const violations: string[] = [];
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} ${e.blockedURI}`,
      );
    });
  });

  await page.goto("/properties/map", { waitUntil: "networkidle" });
  await expect(page.getByTestId("property-map")).toBeVisible();

  violations.push(
    ...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)),
  );
  expect(violations, `CSP blocked: ${violations.join(", ")}`).toEqual([]);
});

test("the filters survive the trip from list to map", async ({ page }) => {
  await page.goto("/properties?district=PAF", { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: /^map$/i }).click();
  await expect(page).toHaveURL(/\/properties\/map\?.*district=PAF/);
});
```

- [ ] **Step 2: Run it**

```bash
npx playwright test tests/e2e/property-map.spec.ts --project=desktop --reporter=line
```

Expected: PASS.

**If the CSP test fails**, read the reported directive — that is precisely the
failure this test exists to catch, and the fix is the missing origin in
`lib/services/csp.ts`, not a weaker assertion.

- [ ] **Step 3: Restore screenshots if touched**

```bash
git status -s tests/screenshots/ && git checkout HEAD -- tests/screenshots/
```

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/property-map.spec.ts
git commit -m "B5: E2E for the map, its CSP origin and filter round trip"
```

---

### Task 8: Full verification and docs

**Files:**
- Modify: `IMPROVEMENTS.md`
- Modify: `HANDOFF.md`

- [ ] **Step 1: Everything**

```bash
cd "D:/dev/TSOPOZIDIS/gnk-crm" && npm test && npm run test:rls && npm run typecheck && npm run lint && npm run build
```

Expected: unit up by 7, RLS **48 unchanged** (this feature adds no policy),
typecheck and lint clean, build succeeds.

- [ ] **Step 2: Correct the IMPROVEMENTS B5 entry**

Replace the "Depends on" sentence, which is false — it claims the location column
is "already populated… the data is sitting there unused". Record what shipped:
centroids on districts and areas, OpenFreeMap tiles with no account, the map as a
second view of the list, and that exact coordinates remain hand-entered.

- [ ] **Step 3: Add a HANDOFF §1 entry**

Dated, naming migration 0031, the FAM free-area decision, and that the CSP gained
one origin.

- [ ] **Step 4: Commit**

```bash
git add IMPROVEMENTS.md HANDOFF.md
git commit -m "docs: B5 property map shipped"
```

---

---

## One spec requirement this plan deliberately does NOT implement

**Radius draw.** The spec keeps it in scope ("client-side over the loaded set")
and B5's original wording asks for it. No task above builds it, and that is a
decision rather than an oversight — recorded here so the gap is visible instead
of being discovered later as a silent shortfall.

**Why:** production holds **2 properties**, all resolving to the same handful of
centroids. A radius filter over two co-located pins answers a question nobody has.
It is also the one part of B5 that is real interaction work — draw, drag, resize,
clear, and reconcile with the URL filters — so it would roughly double this plan
for the least-used control on the screen.

**When it becomes worth building:** once the desk has enough listings that
"everything within 2 km of the harbour" is a question they actually ask. At that
point it is additive — a client-side circle over the already-loaded GeoJSON, no
change to the migration, the resolver, the page or the CSP. If volume ever makes
client-side filtering wrong, `ST_DWithin` is already available.

**Action:** update IMPROVEMENTS B5 in Task 8 to say the map ships without radius
draw, so the roadmap does not imply a control that is not there.

## Definition of done

- [ ] `npm test` — 7 new unit tests pass
- [ ] `npm run test:rls` — 48, unchanged
- [ ] `npm run typecheck`, `npm run lint`, `npm run build` — clean
- [ ] `tests/e2e/property-map.spec.ts` — passes, **zero CSP violations**
- [ ] districts 5/5 and areas 10/10 have centroids, all within Cyprus bounds
- [ ] An operator has looked at the rendered map and confirmed no pin is in the
      wrong village — the acceptance check the coordinates cannot self-verify
- [ ] IMPROVEMENTS B5 no longer claims `location` is already populated
