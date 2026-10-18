import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { essentialNoun, fixHref, fixLocation, type Worklist } from "@/lib/services/quality-worklist";
import { PRICE_REVIEW_DAYS } from "@/lib/services/listing-health";
import { PUBLISH_THRESHOLD } from "@/lib/services/quality-score";
import { propertyTabHref } from "@/lib/services/property-tabs";
import { cn } from "@/lib/utils";

/**
 * The quality-score worklist.
 *
 * Server component — everything shown is derived, nothing is interactive.
 *
 * Ordered by POINTS RECOVERABLE rather than by how common a gap is, because the
 * question is "where does an afternoon buy the most", not "what is most
 * frequent". The count is shown beside it so the reader can disagree.
 *
 * F03: every listing named links to the place it is fixed — the property
 * page's tab (`?tab=`), or a container's Units page — rather than to the top
 * of the page with the tab named in words.
 */

/** At most this many references inline before the row just states the rest. */
const SHOWN_PER_CATEGORY = 12;

const CHIP =
  "flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-text-2 transition-colors hover:bg-surface-2 hover:text-text-1";

function ScorePill({ score }: { score: number }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-0.5 text-[11px] tabular-nums",
        score >= PUBLISH_THRESHOLD
          ? "bg-success/10 text-success"
          : score >= 40
            ? "bg-warning/10 text-warning"
            : "bg-danger/10 text-danger",
      )}
    >
      {score}
    </span>
  );
}

export function QualityWorklist({ worklist }: { worklist: Worklist }) {
  const w = worklist;

  if (w.total === 0) {
    return (
      <section className="rounded-[10px] border border-border bg-surface p-5">
        <p className="text-sm text-text-2">
          No live listings to check. Draft, available, reserved and under-offer properties appear
          here; sold, rented, withdrawn and archived ones do not.
        </p>
      </section>
    );
  }

  if (
    w.categories.length === 0 &&
    w.publicMissingEssentials.length === 0 &&
    w.sharedPhotos.length === 0 &&
    w.buildConflicts.length === 0 &&
    w.onMarket.length === 0
  ) {
    return (
      <section className="flex items-start gap-2 rounded-[10px] border border-success/30 bg-success/5 p-5">
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
        <p className="text-sm text-text-2">
          All {w.total} live {w.total === 1 ? "listing scores" : "listings score"} full marks.
          Nothing to chase.
        </p>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-2 gap-4 rounded-[10px] border border-border bg-surface p-5 sm:grid-cols-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs uppercase tracking-wide text-text-3">Live listings</span>
          <span className="text-xl font-semibold tabular-nums text-text-1">{w.total}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs uppercase tracking-wide text-text-3">Complete</span>
          <span className="text-xl font-semibold tabular-nums text-success">{w.complete}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs uppercase tracking-wide text-text-3">Average score</span>
          <span className="text-xl font-semibold tabular-nums text-text-1">
            {w.averageScore ?? "—"}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs uppercase tracking-wide text-text-3">Points to recover</span>
          <span className="text-xl font-semibold tabular-nums text-text-1">{w.recoverable}</span>
        </div>
      </section>

      {/* F03. A score is compensatory — a listing with no photograph at all
          can clear the threshold on its paperwork — so what the website
          cannot show a listing without is said on its own, first. Reported,
          never acted on: nothing here unpublishes anything. */}
      {w.publicMissingEssentials.length > 0 ? (
        <section className="rounded-[10px] border border-danger/40 bg-danger/5 p-5">
          <h2 className="text-sm font-semibold text-text-1">
            Public without website essentials: {w.publicMissingEssentials.length}{" "}
            {w.publicMissingEssentials.length === 1 ? "listing" : "listings"}
          </h2>
          <p className="mt-1 text-xs text-text-3">
            On the website now without a cover photo, an English title or a price. Nothing is
            unpublished on its own: add what is missing, or take the listing private until it is.
          </p>
          <ul className="mt-3 flex flex-col gap-1.5">
            {w.publicMissingEssentials.map((e) => (
              <li key={e.property.id} className="flex flex-wrap items-center gap-1.5 text-xs text-text-2">
                <Link
                  href={`/properties/${e.property.id}`}
                  title={e.property.title ?? e.property.reference}
                  className="font-medium text-text-1 hover:underline"
                >
                  {e.property.reference}
                </Link>
                <ScorePill score={e.property.score} />
                <span>lacks</span>
                {e.missing.map((m, i) => {
                  const href = fixHref(e.property, m.key);
                  return (
                    <span key={m.key}>
                      {href ? (
                        <Link href={href} className="text-text-1 underline underline-offset-2">
                          {essentialNoun(m.key, { container: e.property.container })}
                        </Link>
                      ) : (
                        essentialNoun(m.key, { container: e.property.container })
                      )}
                      {i < e.missing.length - 1 ? "," : ""}
                    </span>
                  );
                })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Audit 2026-09-15, LST-03. The feed does not re-check the score, so a
          public listing whose score has decayed stays live on the site and
          every portal; this is where that drift is seen. Fresh scores — the
          same computation the dashboard's Listing health reads (F03). */}
      {w.belowThreshold.length > 0 ? (
        <section className="rounded-[10px] border border-danger/40 bg-danger/5 p-5">
          <h2 className="text-sm font-semibold text-text-1">
            {w.belowThreshold.length} public{" "}
            {w.belowThreshold.length === 1 ? "listing scores" : "listings score"} below the
            publish threshold of {PUBLISH_THRESHOLD}
          </h2>
          <p className="mt-1 text-xs text-text-3">
            Live on the site and on every portal. Complete the listing, or take it private
            until it is complete.
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {w.belowThreshold.map((p) => (
              <Link
                key={p.id}
                href={`/properties/${p.id}`}
                title={p.title ?? p.reference}
                className={CHIP}
              >
                <span className="font-medium">{p.reference}</span>
                <ScorePill score={p.score} />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <div className="flex flex-col gap-3">
        {w.categories.map((c) => {
          const shown = c.properties.slice(0, SHOWN_PER_CATEGORY);
          const rest = c.properties.length - shown.length;
          // "Units priced" and "Price set" share a key: a mixed category names
          // both places it is fixed
          const places = [
            ...new Set(c.properties.map((p) => fixLocation(c.key, { container: p.container }))),
          ].filter((t): t is string => t !== null);
          return (
            <section key={c.key} className="rounded-[10px] border border-border bg-surface p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold text-text-1">
                  {c.count} {c.count === 1 ? "listing is" : "listings are"} missing:{" "}
                  <span className="font-normal text-text-2">{c.label}</span>
                </h2>
                <span className="text-xs tabular-nums text-text-3">
                  {c.points} points each · {c.recoverable} recoverable
                </span>
              </div>

              {places.length > 0 ? (
                <p className="mt-1 text-xs text-text-3">
                  Fixed on the{" "}
                  {places.map((place, i) => (
                    <span key={place}>
                      {i > 0 ? " or the " : null}
                      <span className="font-medium text-text-2">{place}</span>
                      {/* a container's units live on their own page, not a tab */}
                      {place.endsWith(" page") ? "" : " tab"}
                    </span>
                  ))}
                  . Each listing below opens there.
                </p>
              ) : null}

              <div className="mt-3 flex flex-wrap gap-1.5">
                {shown.map((p) => (
                  <Link
                    key={p.id}
                    href={fixHref(p, c.key) ?? `/properties/${p.id}`}
                    title={p.title ?? p.reference}
                    className={CHIP}
                  >
                    <span className="font-medium">{p.reference}</span>
                    <ScorePill score={p.score} />
                  </Link>
                ))}
                {rest > 0 ? (
                  <span className="self-center text-xs text-text-3">and {rest} more</span>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>

      {/* Audit 2026-09-15, LST-03: how long each public listing has been on
          the market. Nothing used to say, and a price nobody has looked at in
          months is the commonest portal complaint. */}
      {w.onMarket.length > 0 ? (
        <section className="rounded-[10px] border border-border bg-surface p-5">
          <h2 className="text-sm font-semibold text-text-1">
            {w.onMarket.length} public {w.onMarket.length === 1 ? "listing" : "listings"} on the
            market
          </h2>
          <p className="mt-1 text-xs text-text-3">
            Days since publishing. A listing at {PRICE_REVIEW_DAYS} days or more is due a price
            review.
          </p>
          <ul className="mt-3 flex flex-col gap-1.5">
            {w.onMarket.map((m) => (
              <li key={m.property.id} className="flex items-center gap-2 text-xs text-text-2">
                <Link
                  href={`/properties/${m.property.id}`}
                  className="font-medium text-text-1 hover:underline"
                >
                  {m.property.reference}
                </Link>
                <span className="tabular-nums">
                  {m.days} {m.days === 1 ? "day" : "days"}
                </span>
                {m.priceReviewDue ? (
                  <span className="rounded-full bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning">
                    price review due
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* 0088. Warnings, not points: the score does not move — a development's
          units share exteriors — but a picture on two listings is something the
          desk should decide about, not discover on the site. */}
      {w.sharedPhotos.length > 0 ? (
        <section className="rounded-[10px] border border-warning/40 bg-warning/5 p-5">
          <h2 className="text-sm font-semibold text-text-1">
            {w.sharedPhotos.length}{" "}
            {w.sharedPhotos.length === 1 ? "listing carries" : "listings carry"} a photograph that
            is also on another listing
          </h2>
          <p className="mt-1 text-xs text-text-3">
            No points are withheld — a development&apos;s units share exteriors. Check that each
            picture is the right one for each listing.
          </p>
          <ul className="mt-3 flex flex-col gap-1.5">
            {w.sharedPhotos.map((s) => (
              <li key={s.property.id} className="text-xs text-text-2">
                <Link
                  href={propertyTabHref(s.property.id, "media")}
                  className="font-medium text-text-1 hover:underline"
                >
                  {s.property.reference}
                </Link>{" "}
                shares a photograph with {s.withReferences.join(", ")}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Audit CRM-05. A build year beside a pre-completion status or a
          pending delivery date: the public site withholds the construction
          fields when a year settles them, and the record should say why.
          F03: one row per SOURCE. A unit inheriting its project's build
          details carries the project's contradiction, and used to be listed
          — and told to fix it on its own Details tab — once per unit. */}
      {w.buildConflicts.length > 0 ? (
        <section className="rounded-[10px] border border-warning/40 bg-warning/5 p-5">
          <h2 className="text-sm font-semibold text-text-1">
            {w.buildConflicts.length}{" "}
            {w.buildConflicts.length === 1 ? "listing declares" : "listings declare"} build details
            that contradict each other
            {w.buildConflictGroups.length < w.buildConflicts.length
              ? ` — ${w.buildConflictGroups.length} to correct`
              : null}
          </h2>
          <p className="mt-1 text-xs text-text-3">
            No points are withheld. Correct the year built, the construction status or the delivery
            date — whichever is not true — on the Details tab of the listing named first. Listings
            that inherit those details from it follow once synced from its Units page.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {w.buildConflictGroups.map(({ source, inheritedBy }) => (
              <li key={source.property.id} className="text-xs text-text-2">
                <Link
                  href={propertyTabHref(source.property.id, "details")}
                  className="font-medium text-text-1 hover:underline"
                >
                  {source.property.reference}
                </Link>{" "}
                {source.label}
                {inheritedBy.length > 0 ? (
                  <span className="mt-0.5 block">
                    Inherited by {inheritedBy.length} {inheritedBy.length === 1 ? "listing" : "listings"}{" "}
                    under it (
                    {inheritedBy
                      .slice(0, SHOWN_PER_CATEGORY)
                      .map((p) => p.reference)
                      .join(", ")}
                    {inheritedBy.length > SHOWN_PER_CATEGORY
                      ? ` and ${inheritedBy.length - SHOWN_PER_CATEGORY} more`
                      : ""}
                    ): fix it on{" "}
                    {source.property.reference}, then sync them from its{" "}
                    <Link
                      href={`/properties/${source.property.id}/units`}
                      className="text-text-1 underline underline-offset-2"
                    >
                      Units page
                    </Link>
                    .
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
