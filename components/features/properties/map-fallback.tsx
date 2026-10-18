import Link from "next/link";
import { AlertTriangle, ExternalLink, List } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  featurePriceText,
  type MapFailure,
  type PropertyFeature,
} from "@/lib/services/property-map";
import { mapsSearchUrl } from "@/lib/utils/geo";

/**
 * What the properties map shows when it cannot draw, and the list it carries
 * under itself when it can (F08).
 *
 * Before this, a browser without WebGL2 (a remote desktop, a virtual machine,
 * hardware acceleration off) or a base map that would not load got a 480px
 * empty box and a legend for pins that did not exist — the error went to the
 * console as an unhandled rejection and the screen said nothing. Now the page
 * says why, links to the same filtered list, and lists the properties the map
 * would have shown, each with a way to its record and to its location.
 *
 * Detects; never forces. No text here advises a browser flag or turning a
 * security feature off.
 */

const REASON: Record<MapFailure, string> = {
  unsupported:
    "This browser can't draw the map — WebGL2 is turned off or unavailable here " +
    "(common on remote desktops, virtual machines, or with hardware acceleration off).",
  failed: "The map couldn't load. Reloading the page may help.",
};

export function PropertyMapFallback({
  reason,
  listHref,
  features,
}: {
  reason: MapFailure;
  /** The properties list with the map's own filters — the page builds it. */
  listHref: string;
  features: PropertyFeature[];
}) {
  return (
    <div className="flex flex-col gap-3">
      <div
        role="alert"
        data-testid="property-map-unavailable"
        data-reason={reason}
        className="flex flex-col gap-3 rounded-[10px] border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-text-1 sm:flex-row sm:items-center sm:justify-between"
      >
        <p className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <span>
            {REASON[reason]}
            {features.length > 0 ? " The properties it would show are listed below." : null}
          </span>
        </p>
        <Button asChild variant="outline" className="self-start sm:self-auto">
          <Link href={listHref}>
            <List className="mr-2 size-4" aria-hidden />
            Open as list
          </Link>
        </Button>
      </div>
      {features.length > 0 ? <PropertyMapList features={features} /> : null}
    </div>
  );
}

/**
 * The map's pins as a list: the reference to the record, the title, the price,
 * whether the point is only an area or district centre, and the point in Google
 * Maps. Also a keyboard and screen-reader way through what the canvas shows.
 */
export function PropertyMapList({ features }: { features: PropertyFeature[] }) {
  return (
    <ul
      data-testid="property-map-list"
      className="divide-y divide-border rounded-[10px] border border-border"
    >
      {features.map((f) => {
        const p = f.properties;
        const [lng, lat] = f.geometry.coordinates;
        return (
          <li
            key={p.id}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-[13px]"
          >
            <Link
              href={`/properties/${p.id}`}
              className="font-medium text-brand-700 hover:underline"
            >
              {p.reference}
            </Link>
            {p.title ? <span className="min-w-0 truncate text-text-2">{p.title}</span> : null}
            <span className="text-text-1">{featurePriceText(p.price, p.isRent)}</span>
            {p.precision === "approximate" ? (
              <span className="text-xs text-text-3">Approximate — area/district centre</span>
            ) : null}
            <a
              href={mapsSearchUrl({ lat, lng })}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-xs text-brand-700 hover:underline"
            >
              Open in Google Maps
              <span className="sr-only">: {p.reference} (opens in a new tab)</span>
              <ExternalLink className="size-3" aria-hidden />
            </a>
          </li>
        );
      })}
    </ul>
  );
}
