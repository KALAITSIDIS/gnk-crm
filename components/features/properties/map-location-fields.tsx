"use client";

import { useRef, useState } from "react";
import { Crosshair, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchLocationFallback, resolveMapsShortLink } from "@/lib/actions/geo";
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
export function MapLocationFields({
  location,
  propertyId,
  isApproximate = false,
}: {
  location?: unknown;
  /** omitted on create — there is no row to look an area centroid up from yet */
  propertyId?: string;
  isApproximate?: boolean;
}) {
  const initial = parseLocationPoint(location);
  const [lat, setLat] = useState(initial ? String(initial.lat) : "");
  const [lng, setLng] = useState(initial ? String(initial.lng) : "");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  /**
   * Whether the coordinates currently in the boxes are a CENTROID rather than a
   * surveyed point (0054). It starts from what is stored and then follows what
   * the user does: taking the centre sets it, and ANY other way of putting
   * numbers in these boxes clears it. That is why `setLat`/`setLng` are wrapped
   * rather than called directly below — a hand-typed digit over a centroid is
   * the user asserting a real coordinate, and the flag has to notice.
   */
  const [approx, setApprox] = useState(isApproximate);
  const [centre, setCentre] = useState<{ label: string; source: string } | null>(
    isApproximate ? { label: "", source: "" } : null,
  );
  const [placing, setPlacing] = useState(false);

  const editLat = (v: string) => {
    setLat(v);
    setApprox(false);
  };
  const editLng = (v: string) => {
    setLng(v);
    setApprox(false);
  };
  // Guards against an earlier short-link resolution landing after a newer paste.
  const requestSeq = useRef(0);

  function applyCoords(coords: LatLng) {
    setLat(String(coords.lat));
    setLng(String(coords.lng));
    setPasteError(null);
    setResolving(false);
    // a pasted Maps link is a real place, so it clears the approximate flag
    setApprox(false);
  }

  /** Take the area's centre (0031/0054) — explicitly, and labelled as such. */
  async function useCentre() {
    if (!propertyId) return;
    setPlacing(true);
    setPasteError(null);
    try {
      const fallback = await fetchLocationFallback(propertyId);
      if (!fallback) {
        setPasteError(
          "No centre is on file for this property's area or district, so there is nothing to fall back to.",
        );
        return;
      }
      setLat(String(fallback.lat));
      setLng(String(fallback.lng));
      setCentre({ label: fallback.label, source: fallback.source });
      setApprox(true);
    } finally {
      setPlacing(false);
    }
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

  // The constraint in 0054 refuses an approximate flag with no point, so the
  // posted value has to agree: clearing the boxes clears the flag.
  const approxNow = approx && lat.trim() !== "" && lng.trim() !== "";

  return (
    <>
      <input type="hidden" name="location_approx" value={approxNow ? "on" : ""} />
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
          onChange={(e) => editLat(e.target.value)}
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
          onChange={(e) => editLng(e.target.value)}
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

      {/* The fallback, offered rather than applied. Nothing is stored until the
          form is saved, and what IS stored says it is approximate — the quality
          score does not count it and the map draws it as an approximate pin. */}
      {propertyId ? (
        <div className="flex flex-col gap-2 sm:col-span-2 lg:col-span-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={useCentre}
              disabled={placing}
            >
              <Crosshair className="size-3.5" />
              {placing ? "Finding centre…" : "Use the area centre"}
            </Button>
            {approxNow ? (
              <span className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs text-warning">
                Approximate
                {centre?.label ? ` — centre of ${centre.label}` : ""}
              </span>
            ) : null}
          </div>
          <p className="text-xs text-text-3">
            {approxNow
              ? "Saved as approximate: it puts the listing on the map without claiming a surveyed point, and it does not count toward the quality score. Type real coordinates over it whenever you have them."
              : "No exact coordinates yet? Take the centre of the area so the listing still appears on the map, marked approximate."}
          </p>
        </div>
      ) : null}
    </>
  );
}
