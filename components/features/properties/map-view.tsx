"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { publicMediaUrl } from "@/lib/utils/storage";
import {
  boundsOf,
  featurePriceText,
  MAP_SLOW_AFTER_MS,
  mapErrorOutcome,
  mapFailureReason,
  PINS_SOURCE_ID,
  PRICE_ABSENT,
  startVisibleTimer,
  type MapFailure,
  type MapStatus,
  type PropertyFeatureCollection,
} from "@/lib/services/property-map";
import { PropertyMapFallback, PropertyMapList } from "./map-fallback";
import "maplibre-gl/dist/maplibre-gl.css";

/**
 * MapLibre over OpenFreeMap tiles (IMPROVEMENTS B5).
 *
 * OpenFreeMap needs no account, no key and no rate limit, and permits commercial
 * use. Its origin is allowed in lib/services/csp.ts — the CSP is ENFORCED, so
 * removing that entry stops the style loading in production; since F08 the page
 * then SAYS so (see below) instead of showing an empty box.
 *
 * Attribution is required and MapLibre renders it automatically from the style.
 *
 * ⚠️ THE MAP IS CREATED ONCE AND NEVER REBUILT ON DATA CHANGE. The first version
 * of this file put `data` in the effect's dependency array. `data` is a fresh
 * object from toGeoJson() on every render, so every re-render tore the map down
 * with map.remove() and started a new one. That is wasteful and racy and is
 * rightly fixed — but it was NOT, as an earlier version of this comment claimed,
 * the cause of a blank map in production. THERE WAS NO BLANK MAP: that was an
 * artefact of observing the page through automation on a HIDDEN tab, where
 * requestAnimationFrame never runs, so MapLibre never renders and never requests
 * a tile. Verified working 2026-08-20: 9 vector tiles, `load` fired, Cyprus drawn.
 *
 * So: create in an effect with NO dependencies, hold the latest data in a ref for
 * the style handler, and push later changes through setData() on the existing
 * source. Do not reintroduce `data` as a dependency here.
 *
 * ⚠️ WHY CLUSTERING IS NOT COSMETIC HERE. resolvePosition falls back to the AREA
 * then the DISTRICT centroid, so every property in one area resolves to the
 * IDENTICAL coordinate — not "near", exactly the same point. Un-clustered, forty
 * listings draw as one circle and the map understates the whole portfolio. It
 * also means a cluster of identical points CAN NEVER BE SPLIT by zooming, so the
 * click handler below lists the cluster's leaves instead of zooming forever.
 *
 * ⚠️ WHEN THE MAP CANNOT DRAW (F08). Initialisation used to be treated as
 * infallible: the whole set-up ran in a `void` async function with no catch, no
 * `error` listener and no state, so
 *   - a browser with no WebGL2 (remote desktop, VM, hardware acceleration off,
 *     a GPU-blocklisted browser) threw GPUInitializationError from the Map
 *     constructor into an unhandled rejection, and the user saw an empty box;
 *   - a style that never loaded (OpenFreeMap down, a CSP regression) did the
 *     same, silently;
 *   - and the pins waited for the WHOLE basemap: they were added on `load`,
 *     which MapLibre fires only once every source's tiles are in, so a tile
 *     outage hid the local GeoJSON pins too.
 * Now: `status` (loading → ready | unsupported | failed); the pins go on at
 * `style.load` (the style JSON parsed — no tiles needed for a circle); a failed
 * map shows why, the filtered list link, and the pins as a list
 * (map-fallback.tsx); and a map that has drawn no pins after
 * MAP_SLOW_AFTER_MS of VISIBLE time says so and offers the list — never
 * counting hidden-tab time, which is exactly how a working map was once
 * reported broken. `unsupported` is the browser's environment, not a fault,
 * and is not reported to Sentry; every `failed` is, once.
 */

type Feat = {
  id: string;
  reference: string;
  title: string | null;
  price: number | null;
  hasPrice: boolean;
  isRent: boolean;
  thumb: string | null;
  precision: "exact" | "approximate";
};

/** Popup body built with DOM APIs, never innerHTML: every string here is
 *  agent-entered content out of the database, and this is the one place it would
 *  otherwise reach the page unescaped. */
function buildPopup(features: Feat[], onOpen: (id: string) => void): HTMLElement {
  const root = document.createElement("div");
  root.className = "flex max-h-64 w-60 flex-col gap-1 overflow-y-auto";

  if (features.length > 1) {
    const heading = document.createElement("p");
    heading.className = "px-1 text-xs font-medium text-text-2";
    heading.textContent = `${features.length} properties here`;
    root.append(heading);
  }

  for (const f of features) {
    const row = document.createElement("button");
    row.type = "button";
    row.className =
      "flex w-full items-center gap-2 rounded-[6px] p-1 text-left hover:bg-surface-2";
    row.addEventListener("click", () => onOpen(f.id));

    if (f.thumb) {
      const img = document.createElement("img");
      img.src = publicMediaUrl(f.thumb);
      img.alt = "";
      img.className = "size-10 shrink-0 rounded-[4px] object-cover";
      row.append(img);
    }

    const col = document.createElement("div");
    col.className = "min-w-0 flex-1";

    const ref = document.createElement("p");
    ref.className = "truncate text-xs font-semibold text-text-1";
    ref.textContent = f.reference;
    col.append(ref);

    if (f.title) {
      const title = document.createElement("p");
      title.className = "truncate text-xs text-text-2";
      title.textContent = f.title;
      col.append(title);
    }

    const price = document.createElement("p");
    price.className = "text-xs text-text-1";
    price.textContent = featurePriceText(f.price, f.isRent);
    col.append(price);

    if (f.precision === "approximate") {
      const approx = document.createElement("p");
      approx.className = "text-[10px] text-text-3";
      approx.textContent = "Approximate location";
      col.append(approx);
    }

    row.append(col);
    root.append(row);
  }

  return root;
}

/** The pins: one GeoJSON source and its layers. Circles need no tiles, sprites
 *  or glyphs; only the count and price labels need the style's glyph server. */
function addPropertyLayers(map: import("maplibre-gl").Map, data: PropertyFeatureCollection) {
  map.addSource(PINS_SOURCE_ID, {
    type: "geojson",
    data,
    cluster: true,
    clusterRadius: 45,
    clusterMaxZoom: 14,
    // Aggregated as the worker clusters. Branches on `hasPrice`, NOT on
    // `["to-number", …, fallback]`: to-number converts null to 0 rather
    // than falling back, so that version made any cluster holding one
    // unpriced property read "from €0" and fed a raw null to number-format.
    clusterProperties: {
      // `coalesce` is the operator that actually handles null here.
      // `["to-number", x, fallback]` does NOT: the spec converts null to 0
      // successfully, so the fallback never fires and any cluster holding
      // one unpriced property would read "from €0".
      minPrice: ["min", ["coalesce", ["get", "price"], PRICE_ABSENT]],
    },
  });

  map.addLayer({
    id: "property-clusters",
    type: "circle",
    source: PINS_SOURCE_ID,
    filter: ["has", "point_count"],
    paint: {
      // Deliberately NEITHER teal nor amber. A cluster can hold a mix of
      // exact and approximate properties, so painting it teal would claim
      // a precision it cannot vouch for — which is exactly what the first
      // version did while holding three approximate pins.
      "circle-color": "#334155",
      // `point_count` is ABSENT on an unclustered pin, so this read is
      // coalesced rather than bare — `step` needs a number. Defensive, not
      // a fix for the console warnings this map logs: those were MEASURED
      // on 2026-08-20 to be identical with these layers removed entirely,
      // and come from the OpenFreeMap Liberty style. Their count varies
      // with zoom, not with our data. Do not chase them here.
      "circle-radius": [
        "step",
        ["coalesce", ["get", "point_count"], 0],
        16,
        10,
        22,
        50,
        28,
      ],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#ffffff",
    },
  });

  map.addLayer({
    id: "property-cluster-count",
    type: "symbol",
    source: PINS_SOURCE_ID,
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-font": ["Noto Sans Bold"],
      "text-size": 12,
    },
    paint: { "text-color": "#ffffff" },
  });

  map.addLayer({
    id: "property-pins",
    type: "circle",
    source: PINS_SOURCE_ID,
    filter: ["!", ["has", "point_count"]],
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

  // Price is what an agent actually scans a map for — but it belongs
  // BELOW the marker, not inside it. Labels collide, and MapLibre resolves
  // a collision by HIDING one, so a price drawn on top of a stacked pin
  // would show one arbitrary property out of however many are underneath.
  // The cluster carries "from €X" because clusters are what you mostly see
  // here: shared centroids mean most properties never draw as lone pins.
  const priceText = (key: string) => [
    "concat",
    "from €",
    [
      "number-format",
      ["coalesce", ["get", key], 0],
      { locale: "de-DE", "max-fraction-digits": 0 },
    ],
  ];

  map.addLayer({
    id: "property-cluster-price",
    type: "symbol",
    source: PINS_SOURCE_ID,
    // Hidden when NOTHING in the cluster is priced — the aggregate is then
    // still the sentinel, and "from €1.000.000.000.000" is not a price.
    filter: [
      "all",
      ["has", "point_count"],
      // `minPrice` exists only on clusters, so coalesce before comparing.
      ["<", ["coalesce", ["get", "minPrice"], PRICE_ABSENT], PRICE_ABSENT],
    ],
    layout: {
      "text-field": priceText("minPrice") as unknown as import("maplibre-gl").ExpressionSpecification,
      "text-font": ["Noto Sans Bold"],
      "text-size": 11,
      "text-offset": [0, 1.9],
      "text-anchor": "top",
      "text-allow-overlap": false,
    },
    paint: {
      "text-color": "#0f172a",
      // The basemap underneath is busy; without a halo the label is unreadable.
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.5,
    },
  });

  map.addLayer({
    id: "property-pin-price",
    type: "symbol",
    source: PINS_SOURCE_ID,
    filter: ["all", ["!", ["has", "point_count"]], ["get", "hasPrice"]],
    layout: {
      // The filter already excludes unpriced features; the coalesce keeps
      // the expression total rather than relying on that.
      "text-field": [
        "concat",
        "€",
        [
          "number-format",
          ["coalesce", ["get", "price"], 0],
          { locale: "de-DE", "max-fraction-digits": 0 },
        ],
      ] as unknown as import("maplibre-gl").ExpressionSpecification,
      "text-font": ["Noto Sans Bold"],
      "text-size": 11,
      "text-offset": [0, 1.2],
      "text-anchor": "top",
    },
    paint: {
      "text-color": "#0f172a",
      "text-halo-color": "#ffffff",
      "text-halo-width": 1.5,
    },
  });
}

type MapProps = {
  data: PropertyFeatureCollection;
  /** The properties list under the map's own filters — built by the page. */
  listHref: string;
  /** Rows the filters matched that have no location and no area or district
   *  centre to fall back on: in the list, never on the map. */
  unplaced: number;
};

function MapImpl({ data, listHref, unplaced }: MapProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("maplibre-gl").Map | null>(null);
  const popupRef = useRef<import("maplibre-gl").Popup | null>(null);
  // the pins' source and layers exist (set at `style.load`)
  const readyRef = useRef(false);

  const [status, setStatus] = useState<MapStatus>("loading");
  // The pins' source has LOADED — they are on the canvas. Not the same as
  // `ready`: GeoJSON is cut into tiles in MapLibre's WORKER, and a worker that
  // never answers (the 2026-09-13 worker-URL breakage: style and sprites in,
  // zero tiles, no console error) leaves a drawn style with every pin missing
  // and nothing anywhere saying so. The watchdog below waits for THIS.
  const [pinsDrawn, setPinsDrawn] = useState(false);
  const [slow, setSlow] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const listRef = useRef<HTMLDetailsElement>(null);

  // The style handler runs asynchronously, so it must read the CURRENT data
  // rather than whatever was captured when the effect first ran. Assigned in an
  // effect below, never during render.
  const dataRef = useRef(data);

  // `data` is a new object on every render. Refitting on object identity would
  // yank the viewport back while the user is panning — the same class of bug as
  // rebuilding the map. Refit only when the placed set actually CHANGES.
  const fitKeyRef = useRef<string>("");

  // Held in a ref so the popup's click handler always calls the CURRENT router
  // without the map effect having to depend on it. Assigned in an effect, never
  // during render — same rule as dataRef above.
  const router = useRouter();
  const openRef = useRef<(id: string) => void>(() => {});
  useEffect(() => {
    openRef.current = (id: string) => router.push(`/properties/${id}`);
  }, [router]);

  const fitToData = useCallback(
    (map: import("maplibre-gl").Map, fc: PropertyFeatureCollection) => {
      const bounds = boundsOf(fc);
      if (!bounds) return;
      const key = JSON.stringify(bounds);
      if (key === fitKeyRef.current) return;
      fitKeyRef.current = key;
      // maxZoom matters: a single property gives a DEGENERATE box, and without a
      // cap fitBounds zooms to the tightest zoom available and lands in a garden.
      map.fitBounds(bounds, { padding: 56, maxZoom: 14, duration: 0 });
    },
    [],
  );

  useEffect(() => {
    if (!container.current) return;
    let cancelled = false;
    let gaveUp = false;

    // One failure per map: the first names it, and Sentry hears of it once.
    const giveUp = (reason: MapFailure, err: unknown, stage: string) => {
      if (cancelled || gaveUp) return;
      gaveUp = true;
      setStatus(reason);
      if (reason === "failed") {
        Sentry.captureException(err, { tags: { area: "property-map", stage } });
      }
    };

    void (async () => {
      let maplibre: typeof import("maplibre-gl");
      try {
        maplibre = await import("maplibre-gl");
      } catch (err) {
        // the library's chunk did not arrive (a dropped connection, a deploy
        // that replaced it under an open tab)
        giveUp("failed", err, "chunk");
        return;
      }
      if (cancelled || !container.current) return;

      // maplibre-gl 6 (2026-09-13) spawns a MODULE worker from a URL it derives
      // from `import.meta.url`, and Turbopack gets that wrong in BOTH modes,
      // silently: in `next dev` the value is not http(s), MapLibre's default
      // becomes "" and `new Worker("")` fetches this page as its script; in
      // `next build` the worker is emitted under /_next/static/media with a
      // hashed name but imports `./maplibre-gl-shared.mjs` unhashed — a 404.
      // Symptom either way: style and sprites load, zero tiles, no console
      // error, and property-map.spec.ts fails twice. scripts/copy-maplibre-
      // worker.mjs (predev/prebuild) places the two files under public/maplibre/
      // so the worker is a plain same-origin URL inside `worker-src 'self'` and
      // its relative import resolves next to it. DECISIONS T-deps-2026-09-13.
      maplibre.setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

      let map: import("maplibre-gl").Map;
      try {
        map = new maplibre.Map({
          container: container.current,
          style: "https://tiles.openfreemap.org/styles/liberty",
          // Cyprus, [lng, lat]. Replaced by fitBounds as soon as there is data.
          center: [33.0, 34.9],
          zoom: 8,
        });
      } catch (err) {
        // GPUInitializationError when there is no WebGL2 context. MapLibre has
        // already taken its canvas back out of the container.
        giveUp(mapFailureReason(err), err, "init");
        return;
      }
      mapRef.current = map;

      // The pins' own source failed (F08 review): never "drawn" after this —
      // MapLibre counts an errored source as loaded, which `idle` would read
      // as the pins being on the canvas.
      let pinsFailed = false;

      // A listener here switches off MapLibre's own console.error for an error
      // nobody listens to — so what does not stop the map is still logged.
      map.on("error", (e) => {
        // MapLibre adds `sourceId` to an error a source raised (typed only as ErrorEvent)
        const pins = (e as { sourceId?: unknown }).sourceId === PINS_SOURCE_ID;
        if (pins) pinsFailed = true;
        const outcome = mapErrorOutcome(e, readyRef.current);
        if (outcome) giveUp(outcome, e.error, pins ? "pins" : "style");
        else console.error(e.error);
      });

      // The pins go on as soon as the STYLE is in — not on `load`, which waits
      // for every basemap tile, so a tile outage used to hide them as well.
      // `once`: style.load fires again on setStyle (never called here), and the
      // source must not be added twice.
      map.once("style.load", () => {
        if (cancelled) return;
        try {
          addPropertyLayers(map, dataRef.current);
        } catch (err) {
          giveUp("failed", err, "layers");
          return;
        }
        readyRef.current = true;
        setStatus((s) => (s === "loading" ? "ready" : s));
        fitToData(map, dataRef.current);
      });

      // the worker has answered the pins' GeoJSON: MapLibre fires this
      // `metadata` event only on a load that succeeded, never on one that failed
      let pinsParsed = false;
      const markDrawn = () => {
        if (pinsFailed) return;
        map.off("sourcedata", onSourceData);
        map.off("idle", onIdle);
        if (!cancelled) setPinsDrawn(true);
      };
      const onSourceData = (e: import("maplibre-gl").MapSourceDataEvent) => {
        if (e.sourceId !== PINS_SOURCE_ID) return;
        if (e.sourceDataType === "metadata") pinsParsed = true;
        if (pinsParsed && e.isSourceLoaded) markDrawn();
      };
      // the same answer by another road, in case the last tile's event came
      // before the source counted itself loaded — and only once the worker
      // parsed the pins: an ERRORED source also reads loaded
      const onIdle = () => {
        if (
          pinsParsed &&
          readyRef.current &&
          map.getSource(PINS_SOURCE_ID) &&
          map.isSourceLoaded(PINS_SOURCE_ID)
        ) {
          markDrawn();
        }
      };
      map.on("sourcedata", onSourceData);
      map.on("idle", onIdle);

      const popup = new maplibre.Popup({ closeButton: true, maxWidth: "none" });
      popupRef.current = popup;

      const showPopup = (lngLat: import("maplibre-gl").LngLatLike, feats: Feat[]) => {
        popup
          .setLngLat(lngLat)
          .setDOMContent(buildPopup(feats, (id) => openRef.current(id)))
          .addTo(map);
      };

      // A pin is smaller than a fingertip, and pins sharing a centroid sit
      // exactly on top of one another — so collect EVERY feature under the
      // click, not just the top one, or the popup opens an arbitrary property.
      map.on("click", "property-pins", (e) => {
        const hits = map.queryRenderedFeatures(e.point, { layers: ["property-pins"] });
        const feats = hits.map((h) => h.properties as unknown as Feat);
        if (feats.length) showPopup(e.lngLat, feats);
      });

      map.on("click", "property-clusters", (e) => {
        const hit = map.queryRenderedFeatures(e.point, {
          layers: ["property-clusters"],
        })[0];
        const clusterId = hit?.properties?.cluster_id;
        if (clusterId === undefined) return;
        const source = map.getSource(PINS_SOURCE_ID) as import("maplibre-gl").GeoJSONSource;

        void (async () => {
          const leaves = await source.getClusterLeaves(clusterId, 100, 0);
          const coords = leaves.map((l) =>
            JSON.stringify((l.geometry as GeoJSON.Point).coordinates),
          );
          // Every leaf on one point: zooming can never separate these, so the
          // popup IS the only way to reach them. This is the COMMON case here,
          // because area and district centroids are shared exactly.
          if (new Set(coords).size === 1) {
            showPopup(
              e.lngLat,
              leaves.map((l) => l.properties as unknown as Feat),
            );
            return;
          }
          const zoom = await source.getClusterExpansionZoom(clusterId);
          map.easeTo({ center: e.lngLat, zoom });
        })();
      });

      for (const layer of ["property-pins", "property-clusters"]) {
        map.on("mouseenter", layer, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layer, () => {
          map.getCanvas().style.cursor = "";
        });
      }
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      popupRef.current?.remove();
      popupRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [fitToData]);

  // New data updates the existing source instead of rebuilding the map. This
  // also owns dataRef, so the async style handler above always reads the latest.
  useEffect(() => {
    dataRef.current = data;
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const source = map.getSource(PINS_SOURCE_ID);
    if (source && "setData" in source) {
      (source as import("maplibre-gl").GeoJSONSource).setData(data);
      fitToData(map, data);
    }
  }, [data, fitToData]);

  const failure: MapFailure | null =
    status === "unsupported" || status === "failed" ? status : null;

  // The silent stall: nothing errors and nothing draws. Runs until the pins
  // are drawn or the map has failed outright, across loading → ready (the
  // dependency is this boolean, so that step does not restart the count), and
  // counts VISIBLE time only (startVisibleTimer). It never replaces the map —
  // it only says so and offers the list; a late map clears it.
  const watching = !pinsDrawn && failure === null;
  useEffect(() => {
    if (!watching) return;
    return startVisibleTimer(
      MAP_SLOW_AFTER_MS,
      () => document.visibilityState === "visible",
      () => setSlow(true),
    );
  }, [watching]);

  const showAsList = () => {
    setListOpen(true);
    // after the <details> has opened
    requestAnimationFrame(() => {
      listRef.current?.scrollIntoView({ block: "start" });
      listRef.current?.querySelector("summary")?.focus();
    });
  };

  const placed = data.features.length;

  return (
    <div className="flex flex-1 flex-col gap-2">
      {failure ? (
        <PropertyMapFallback reason={failure} listHref={listHref} features={data.features} />
      ) : null}

      {!failure && slow && !pinsDrawn ? (
        <div
          role="status"
          data-testid="property-map-slow"
          className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-warning/30 bg-warning/10 px-4 py-2 text-sm text-text-1"
        >
          <span>The map is taking longer than usual to draw.</span>
          {placed > 0 ? (
            <button
              type="button"
              onClick={showAsList}
              className="text-sm font-medium text-brand-700 hover:underline"
            >
              Show as a list
            </button>
          ) : null}
        </div>
      ) : null}

      <div className={failure ? "hidden" : "relative flex min-h-[480px] flex-1 flex-col"}>
        <div
          ref={container}
          data-testid="property-map"
          data-status={status}
          data-pins={pinsDrawn ? "drawn" : "pending"}
          className="min-h-[480px] flex-1 rounded-[10px] border border-border"
        />
        {status === "loading" ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p
              aria-live="polite"
              className="rounded-md bg-surface/90 px-3 py-1.5 text-sm text-text-2 shadow-sm"
            >
              Loading map…
            </p>
          </div>
        ) : null}
      </div>

      {!failure ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-2">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-[#0f766e]" aria-hidden />
            Exact location
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-[#f59e0b]" aria-hidden />
            Approximate — placed by area or district. Set exact coordinates on the
            property page.
          </span>
        </div>
      ) : null}

      {placed === 0 ? (
        <p data-testid="property-map-empty" className="text-sm text-text-2">
          {/* "can't be placed" and "nothing matched" are different facts */}
          {unplaced > 0
            ? "None of these properties can be placed on the map yet. Add coordinates on a property, or set a centroid for its district in Settings."
            : "No properties match."}
        </p>
      ) : null}

      {!failure && placed > 0 ? (
        <details
          ref={listRef}
          open={listOpen}
          onToggle={(e) => setListOpen(e.currentTarget.open)}
          className="text-sm"
        >
          <summary className="cursor-pointer text-text-2">
            Show {placed} as a list
          </summary>
          <div className="mt-2">
            <PropertyMapList features={data.features} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** ssr:false keeps MapLibre off the server render; the library itself is still
 *  code-split by the dynamic `import("maplibre-gl")` inside the effect. */
export const PropertyMap = dynamic(() => Promise.resolve(MapImpl), {
  ssr: false,
  loading: () => (
    <div className="min-h-[480px] flex-1 animate-pulse rounded-[10px] bg-surface-2" />
  ),
});
