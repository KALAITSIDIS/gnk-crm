import Link from "next/link";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { TabLink } from "@/components/features/properties/property-tabs";
import { essentialNoun, fixHref, fixLocation, fixTab } from "@/lib/services/quality-worklist";
import {
  PUBLISH_THRESHOLD,
  type QualityScoreItem,
  type QualityScoreResult,
} from "@/lib/services/quality-score";
import { cn } from "@/lib/utils";

/**
 * Is this listing ready for the website — said as three separate things,
 * in visible text, on the property page itself (F03).
 *
 * Until now the only account of a listing's readiness was the score ring's
 * hover tooltip: unreachable by keyboard or touch, and one number for three
 * different questions. A public listing with no photograph scored 85 and
 * read green.
 *
 *   1. WEBSITE ESSENTIALS — a cover photo, an English title, a price
 *      (WEBSITE_ESSENTIALS). When the listing is public and available — on
 *      the website — and one is missing, that is said plainly. Nothing
 *      changes on its own; whether a missing one should block publishing is
 *      the operator's open decision (BACKLOG LST-09).
 *   2. COMPLETENESS — the score and every missing item with its points.
 *   3. DATA WARNINGS — a build contradiction or a shared photograph: no
 *      points, but something is wrong, not missing. A unit whose
 *      contradiction is its project's says where it is fixed.
 *
 * Every gap links to the tab it is fixed on (TabLink: `?tab=`, switching in
 * place), or to the Units page for a container's units. Per-portal
 * requirements stay on the Portals card (Marketing tab) — not re-derived here.
 *
 * Server component: the result is the one the ring shows, computed through
 * buildQualityInput by the page.
 */
export function ListingReadiness({
  propertyId,
  visibility,
  status,
  container,
  quality,
  buildSource,
}: {
  propertyId: string;
  visibility: string;
  status: string;
  /** a project or phase: its prices are its units', fixed on the Units page */
  container: boolean;
  quality: QualityScoreResult;
  /** the row this one's build contradiction is inherited from, if it is (worklist rule) */
  buildSource: { id: string; reference: string } | null;
}) {
  const onWebsite = visibility === "public" && status === "available";
  const essentials = quality.items.filter((i) => i.essential === true);
  const essentialsMissing = quality.essentialsMissing;
  const buildConflict = quality.warnings.find((w) => w.key === "build_conflict") ?? null;
  const sharedPhoto = quality.warnings.find((w) => w.key === "shared_photo") ?? null;
  const belowThreshold = quality.score < PUBLISH_THRESHOLD;
  const emptyContainer = container && quality.missing.some((i) => i.key === "units");

  return (
    <section
      aria-labelledby="listing-readiness-heading"
      data-listing-readiness=""
      // inside the page's Tabs root (gap-2), above the strip: mb-2 makes the page's gap-4
      className="mb-2 rounded-[10px] border border-border bg-surface p-4"
    >
      <h2 id="listing-readiness-heading" className="text-sm font-semibold text-text-1">
        Listing readiness
      </h2>
      <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-3">
        {/* 1. what the website cannot show the listing without */}
        <div>
          <h3 className="text-[13px] font-semibold text-text-1">Website essentials</h3>
          {essentialsMissing.length === 0 ? (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-text-2">
              <CheckCircle2 className="mt-px size-3.5 shrink-0 text-success" aria-hidden />
              <span>
                All in place: {essentials.map((i) => essentialNoun(i.key, { container })).join(", ")}.
              </span>
            </p>
          ) : (
            <div
              className={cn(
                "mt-1 flex items-start gap-1.5 text-xs",
                onWebsite ? "text-danger" : "text-text-2",
              )}
            >
              <XCircle
                className={cn("mt-px size-3.5 shrink-0", onWebsite ? "text-danger" : "text-warning")}
                aria-hidden
              />
              <div>
                <p className={onWebsite ? "font-medium" : undefined}>
                  {onWebsite ? "Public on the website without:" : "Needed before it goes on the website:"}{" "}
                  {essentialsMissing.map((item, i) => (
                    <span key={item.key}>
                      <FixLink
                        propertyId={propertyId}
                        container={container}
                        item={item}
                        className="underline underline-offset-2"
                      >
                        {essentialNoun(item.key, { container })}
                      </FixLink>
                      {i < essentialsMissing.length - 1 ? ", " : "."}
                    </span>
                  ))}
                </p>
                {onWebsite ? (
                  <p className="mt-0.5 text-text-2">
                    It stays public until someone changes it — add what is missing, or take it
                    private until it is.
                  </p>
                ) : null}
              </div>
            </div>
          )}
        </div>

        {/* 2. how complete the listing is — the score, item by item */}
        <div>
          <h3 className="text-[13px] font-semibold text-text-1">
            Completeness <span className="tabular-nums">{quality.score}/100</span>
          </h3>
          <p className="mt-1 text-xs text-text-2">
            {/* the gate refuses an empty container whatever its score, and no
                override clears that (lib/actions/properties.ts) — so it is not
                told an admin's override would publish it */}
            {emptyContainer && visibility !== "public"
              ? "No units yet: it cannot be published whatever its score, and no override changes that — add its units first."
              : belowThreshold
                ? visibility === "public"
                  ? `Public below the publish threshold of ${PUBLISH_THRESHOLD}.`
                  : `Below the publish threshold of ${PUBLISH_THRESHOLD}: going public needs an admin's override.`
                : `Clears the publish threshold of ${PUBLISH_THRESHOLD}.`}
          </p>
          {quality.missing.length === 0 ? (
            <p className="mt-1 text-xs text-text-2">All criteria met.</p>
          ) : (
            <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Missing criteria">
              {quality.missing.map((item) => (
                <li key={item.key}>
                  <FixLink
                    propertyId={propertyId}
                    container={container}
                    item={item}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text-1"
                  >
                    {item.label}
                    <span className="tabular-nums text-text-3">+{item.points}</span>
                  </FixLink>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 3. wrong rather than missing: no points, said apart */}
        <div>
          <h3 className="text-[13px] font-semibold text-text-1">Data warnings</h3>
          {!buildConflict && !sharedPhoto ? (
            <p className="mt-1 text-xs text-text-2">None.</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-1.5 text-xs text-text-2">
              {buildConflict ? (
                <li className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
                  <span>
                    {buildConflict.label}{" "}
                    {buildSource ? (
                      <>
                        Inherited from{" "}
                        <Link
                          href={`/properties/${buildSource.id}?tab=details`}
                          className="font-medium text-text-1 underline underline-offset-2"
                        >
                          {buildSource.reference}
                        </Link>{" "}
                        — correct it there, then sync from its{" "}
                        <Link
                          href={`/properties/${buildSource.id}/units`}
                          className="underline underline-offset-2"
                        >
                          Units page
                        </Link>
                        .
                      </>
                    ) : (
                      <>
                        Correct it on the{" "}
                        <TabLink
                          propertyId={propertyId}
                          tab="details"
                          className="underline underline-offset-2"
                        >
                          Details tab
                        </TabLink>
                        .
                      </>
                    )}
                  </span>
                </li>
              ) : null}
              {sharedPhoto ? (
                <li className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
                  <span>
                    {sharedPhoto.label}. Check it is the right picture on the{" "}
                    <TabLink
                      propertyId={propertyId}
                      tab="media"
                      className="underline underline-offset-2"
                    >
                      Media tab
                    </TabLink>
                    .
                  </span>
                </li>
              ) : null}
            </ul>
          )}
        </div>
      </div>
      <p className="mt-3 border-t border-border/60 pt-2 text-xs text-text-3">
        Each portal&apos;s own requirements are on the Portals card of the{" "}
        <TabLink propertyId={propertyId} tab="marketing" className="underline underline-offset-2">
          Marketing tab
        </TabLink>
        .
      </p>
    </section>
  );
}

/** One gap, linked to where it is fixed: a tab in place, or a container's Units page. */
function FixLink({
  propertyId,
  container,
  item,
  className,
  children,
}: {
  propertyId: string;
  container: boolean;
  item: QualityScoreItem;
  className?: string;
  children: ReactNode;
}) {
  const where = fixLocation(item.key, { container });
  const tab = fixTab(item.key, { container });
  const title = where ? `Fixed on the ${where}${where.endsWith(" page") ? "" : " tab"}` : undefined;
  if (tab) {
    return (
      <TabLink propertyId={propertyId} tab={tab} title={title} className={className}>
        {children}
      </TabLink>
    );
  }
  const href = fixHref({ id: propertyId, container }, item.key);
  if (!href) return <span className={className}>{children}</span>;
  return (
    <Link href={href} title={title} className={className}>
      {children}
    </Link>
  );
}
