"use client";

import { useState } from "react";
import { MapPin } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { parseLocationPoint, parseMapsCoords } from "@/lib/utils/geo";

/**
 * Exact map location inputs for the Details form. Feeds the `location`
 * geography(point,4326) column (quality-score criterion "Exact map location").
 * Agents can type lat/lng directly or paste a Google Maps link to auto-fill.
 */
export function MapLocationFields({ location }: { location?: unknown }) {
  const initial = parseLocationPoint(location);
  const [lat, setLat] = useState(initial ? String(initial.lat) : "");
  const [lng, setLng] = useState(initial ? String(initial.lng) : "");
  const [pasteError, setPasteError] = useState<string | null>(null);

  function handlePaste(value: string) {
    setPasteError(null);
    if (!value.trim()) return;
    const coords = parseMapsCoords(value);
    if (!coords) {
      setPasteError("Couldn’t read coordinates from that. Paste a Google Maps link or “lat, lng”.");
      return;
    }
    setLat(String(coords.lat));
    setLng(String(coords.lng));
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="latitude">Latitude</Label>
        <Input
          id="latitude"
          name="latitude"
          type="number"
          step="any"
          inputMode="decimal"
          placeholder="34.7720"
          value={lat}
          onChange={(e) => setLat(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="longitude">Longitude</Label>
        <Input
          id="longitude"
          name="longitude"
          type="number"
          step="any"
          inputMode="decimal"
          placeholder="32.4297"
          value={lng}
          onChange={(e) => setLng(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2 sm:col-span-2 lg:col-span-1">
        <Label htmlFor="maps_paste" className="flex items-center gap-1.5">
          <MapPin className="size-3.5 text-text-3" /> Paste Google Maps link
        </Label>
        <Input
          id="maps_paste"
          type="text"
          placeholder="Paste a maps.google.com link…"
          onChange={(e) => handlePaste(e.target.value)}
        />
        {pasteError ? (
          <p className="text-xs text-danger">{pasteError}</p>
        ) : (
          <p className="text-xs text-text-3">Fills latitude &amp; longitude automatically.</p>
        )}
      </div>
    </>
  );
}
