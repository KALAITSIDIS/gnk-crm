"use client";

import { useCallback, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/utils/format";
import { publicMediaUrl } from "@/lib/utils/storage";
import {
  boundsOf,
  PRICE_ABSENT,
  type PropertyFeatureCollection,
} from "@/lib/services/property-map";
import "maplibre-gl/dist/maplibre-gl.css";

/**
 * MapLibre over OpenFreeMap tiles (IMPROVEMENTS B5).
 *
 * OpenFreeMap needs no account, no key and no rate limit, and permits commercial
 * use. Its origin is allowed in lib/services/csp.ts — the CSP is ENFORCED, so
 * removing that entry blanks this map in production with no UI error.
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
 * the load handler, and push later changes through setData() on the existing
 * source. Do not reintroduce `data` as a dependency here.
 *
 * ⚠️ WHY CLUSTERING IS NOT COSMETIC HERE. resolvePosition falls back to the AREA
 * then the DISTRICT centroid, so every property in one area resolves to the
 * IDENTICAL coordinate — not "near", exactly the same point. Un-clustered, forty
 * listings draw as one circle and the map understates the whole portfolio. It
 * also means a cluster of identical points CAN NEVER BE SPLIT by zooming, so the
 * click handler below lists the cluster's leaves instead of zooming forever.
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
    price.textContent =
      f.price === null
        ? "—"
        : f.isRent
          ? `${formatMoney(f.price)} / month`
          : formatMoney(f.price);
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

function MapImpl({ data }: { data: PropertyFeatureCollection }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("maplibre-gl").Map | null>(null);
  const popupRef = useRef<import("maplibre-gl").Popup | null>(null);
  const readyRef = useRef(false);

  // The load handler runs asynchronously, so it must read the CURRENT data
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

    void (async () => {
      const maplibre = await import("maplibre-gl");
      if (cancelled || !container.current) return;

      const map = new maplibre.Map({
        container: container.current,
        style: "https://tiles.openfreemap.org/styles/liberty",
        // Cyprus, [lng, lat]. Replaced by fitBounds as soon as there is data.
        center: [33.0, 34.9],
        zoom: 8,
      });
      mapRef.current = map;

      const popup = new maplibre.Popup({ closeButton: true, maxWidth: "none" });
      popupRef.current = popup;

      const showPopup = (lngLat: import("maplibre-gl").LngLatLike, feats: Feat[]) => {
        popup
          .setLngLat(lngLat)
          .setDOMContent(buildPopup(feats, (id) => openRef.current(id)))
          .addTo(map);
      };

      map.on("load", () => {
        map.addSource("properties", {
          type: "geojson",
          data: dataRef.current,
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
          source: "properties",
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
          source: "properties",
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
          source: "properties",
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
          source: "properties",
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
          source: "properties",
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

        readyRef.current = true;
        fitToData(map, dataRef.current);
      });

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
        const source = map.getSource("properties") as import("maplibre-gl").GeoJSONSource;

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
  // also owns dataRef, so the async load handler above always reads the latest.
  useEffect(() => {
    dataRef.current = data;
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const source = map.getSource("properties");
    if (source && "setData" in source) {
      (source as import("maplibre-gl").GeoJSONSource).setData(data);
      fitToData(map, data);
    }
  }, [data, fitToData]);

  return (
    <div className="flex flex-1 flex-col gap-2">
      <div
        ref={container}
        data-testid="property-map"
        className="min-h-[480px] flex-1 rounded-[10px] border border-border"
      />
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
      {data.features.length === 0 && (
        <p data-testid="property-map-empty" className="text-sm text-text-2">
          No properties can be placed on the map yet. Add coordinates on a
          property, or set a centroid for its district in Settings.
        </p>
      )}
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
