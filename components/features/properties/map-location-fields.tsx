"use client";

import { useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resolveMapsShortLink } from "@/lib/actions/geo";
import {
  isGoogleMapsShortLink,
  parseLocationPoint,
  parseMapsCoords,
  type LatLng,
} from "@/lib/utils/geo";

/**
 * Exact map location inputs for the Details form. Feeds the `location`
 * geography(point,4326) column (quality-score criterion "Exact map location").
 * Agents can type lat/lng directly or paste a Google Maps link to auto-fill —
 * including a maps.app.goo.gl short link, which is resolved server-side.
 */
export function MapLocationFields({ location }: { location?: unknown }) {
  const initial = parseLocationPoint(location);
  const [lat, setLat] = useState(initial ? String(initial.lat) : "");
  const [lng, setLng] = useState(initial ? String(initial.lng) : "");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  // Guards against an earlier short-link resolution landing after a newer paste.
  const requestSeq = useRef(0);

  function applyCoords(coords: LatLng) {
    setLat(String(coords.lat));
    setLng(String(coords.lng));
    setPasteError(null);
    setResolving(false);
  }

  async function handlePaste(value: string) {
    setPasteError(null);
    const text = value.trim();
    if (!text) {
      setResolving(false);
      return;
    }

    const direct = parseMapsCoords(text);
    if (direct) {
      applyCoords(direct);
      return;
    }

    if (isGoogleMapsShortLink(text)) {
      const seq = ++requestSeq.current;
      setResolving(true);
      try {
        const coords = await resolveMapsShortLink(text);
        if (seq !== requestSeq.current) return; // superseded by a newer paste
        if (coords) {
          applyCoords(coords);
        } else {
          setResolving(false);
          setPasteError(
            "Couldn’t open that short link. Open it in a browser, then copy the full maps.google.com address from the address bar and paste that.",
          );
        }
      } catch {
        if (seq !== requestSeq.current) return;
        setResolving(false);
        setPasteError(
          "Couldn’t reach Google to resolve that link. Check your connection, or paste the full maps.google.com address instead.",
        );
      }
      return;
    }

    setResolving(false);
    setPasteError("Couldn’t read coordinates from that. Paste a Google Maps link or “lat, lng”.");
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
          placeholder="Paste any Google Maps link (short links work)…"
          onChange={(e) => handlePaste(e.target.value)}
        />
        {pasteError ? (
          <p className="text-xs text-danger">{pasteError}</p>
        ) : resolving ? (
          <p className="text-xs text-text-3">Resolving link…</p>
        ) : (
          <p className="text-xs text-text-3">Fills latitude &amp; longitude automatically.</p>
        )}
      </div>
    </>
  );
}
