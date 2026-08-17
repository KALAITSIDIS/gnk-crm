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
