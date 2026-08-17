"use client";

import { useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import type { PropertyFeatureCollection } from "@/lib/services/property-map";
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
 * with map.remove() and started a new one — which shipped to production as a
 * completely BLANK map on 2026-08-11: the style, TileJSON and sprites loaded,
 * the attribution control rendered, and not one vector tile was ever requested.
 * Nothing errored, nothing was CSP-blocked, and the E2E passed because the
 * container was visible.
 *
 * So: create in an effect with NO dependencies, hold the latest data in a ref for
 * the load handler, and push later changes through setData() on the existing
 * source. Do not reintroduce `data` as a dependency here.
 */
function MapImpl({ data }: { data: PropertyFeatureCollection }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import("maplibre-gl").Map | null>(null);
  const readyRef = useRef(false);

  // The load handler runs asynchronously, so it must read the CURRENT data
  // rather than whatever was captured when the effect first ran. Assigned in an
  // effect below, never during render.
  const dataRef = useRef(data);

  useEffect(() => {
    if (!container.current) return;
    let cancelled = false;

    void (async () => {
      const maplibre = await import("maplibre-gl");
      if (cancelled || !container.current) return;

      const map = new maplibre.Map({
        container: container.current,
        style: "https://tiles.openfreemap.org/styles/liberty",
        center: [33.0, 34.9], // Cyprus, [lng, lat]
        zoom: 8,
      });
      mapRef.current = map;

      map.on("load", () => {
        map.addSource("properties", { type: "geojson", data: dataRef.current });
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
        readyRef.current = true;
      });
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // New data updates the existing source instead of rebuilding the map. This
  // also owns dataRef, so the async load handler above always reads the latest.
  useEffect(() => {
    dataRef.current = data;
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    const source = map.getSource("properties");
    if (source && "setData" in source) {
      (source as import("maplibre-gl").GeoJSONSource).setData(data);
    }
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

/** ssr:false keeps MapLibre off the server render; the library itself is still
 *  code-split by the dynamic `import("maplibre-gl")` inside the effect. */
export const PropertyMap = dynamic(() => Promise.resolve(MapImpl), {
  ssr: false,
  loading: () => (
    <div className="min-h-[480px] flex-1 animate-pulse rounded-[10px] bg-surface-2" />
  ),
});
