import Link from "next/link";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { AlertTriangle, CheckCircle2, ShieldAlert, ShieldCheck } from "lucide-react";
import { fetchQualityWorklist } from "@/lib/queries/quality-worklist";
import { listingHealthVerdict, PRICE_REVIEW_DAYS } from "@/lib/services/listing-health";
import { PUBLISH_THRESHOLD } from "@/lib/services/quality-score";
import type { Worklist } from "@/lib/services/quality-worklist";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

/**
 * Listing health, beside the cron banner on the admin dashboard (audit
 * 2026-09-15 LST-03; F03).
 *
 * F03: it reads the worklist's FRESH computation (fetchQualityWorklist — the
 * same one /properties/worklist renders), not `published_below_threshold()`,
 * which compares the STORED column with a hard-coded 70. The two screens can
 * no longer disagree. And it states four things separately, because they are
 * not one another (listingHealthVerdict):
 *   1. website essentials — a public listing with no cover photo, English
 *      title or price is named, whatever its score;
 *   2. completeness — public listings below the publish threshold;
 *   3. the market — the longest-standing listing, any due a price review;
 *   4. data warnings across the live inventory — build contradictions (with
 *      how many rows they are corrected on) and shared photographs. Amber,
 *      but they never decide the verdict.
 * Green only when 1 and 2 are clean and no price review is due.
 *
 * Server component in the admin branch, on the admin's own RLS client. A
 * failed read says so — it is never painted as "nothing to report".
 * Strings: next-intl `dashboard.listingHealth.*` (en, el, ru).
 */
export async function ListingHealth() {
  const t = await getTranslations("dashboard.listingHealth");
  const supabase = await createClient();

  let worklist: Worklist;
  try {
    worklist = await fetchQualityWorklist(supabase);
  } catch (err) {
    return (
      <div className="flex max-w-2xl items-center gap-2 rounded-[10px] border border-warning/30 bg-warning/10 px-4 py-3 text-sm font-medium text-warning">
        <ShieldAlert className="size-4 shrink-0" />
        {t("unreadable", { message: err instanceof Error ? err.message : String(err) })}
      </div>
    );
  }

  const v = listingHealthVerdict(worklist);
  const essentialLabel = (key: string, container: boolean | undefined): string =>
    key === "price" && container
      ? t("essential.unitsPriced")
      : key === "cover" || key === "title_en" || key === "price"
        ? t(`essential.${key}`)
        : key;

  const lines: { key: string; ok: boolean; text: ReactNode }[] = [];
  if (v.publicCount === 0) {
    lines.push({ key: "essentials", ok: true, text: t("nothingPublic") });
  } else {
    lines.push(
      v.essentials.length === 0
        ? { key: "essentials", ok: true, text: t("essentialsClean", { count: v.publicCount }) }
        : {
            key: "essentials",
            ok: false,
            text: t("essentialsMissing", {
              count: v.essentials.length,
              list: v.essentials
                .map(
                  (e) =>
                    `${e.property.reference} (${e.missing
                      .map((m) => essentialLabel(m.key, e.property.container))
                      .join(", ")})`,
                )
                .join(", "),
            }),
          },
    );
    lines.push(
      v.belowThreshold.length === 0
        ? {
            key: "completeness",
            ok: true,
            text: t("completenessClean", { count: v.publicCount, threshold: PUBLISH_THRESHOLD }),
          }
        : {
            key: "completeness",
            ok: false,
            text: t("completenessBelow", {
              count: v.belowThreshold.length,
              threshold: PUBLISH_THRESHOLD,
              list: v.belowThreshold.map((p) => `${p.reference} (${p.score})`).join(", "),
            }),
          },
    );
  }
  if (v.longest) {
    lines.push({
      key: "market",
      ok: v.priceReviewDue === 0,
      text: (
        <>
          {t("longest", { ref: v.longest.property.reference, days: v.longest.days })}
          {v.priceReviewDue > 0
            ? ` ${t("priceReview", { count: v.priceReviewDue, days: PRICE_REVIEW_DAYS })}`
            : null}
        </>
      ),
    });
  }
  const warningParts = [
    ...(v.dataWarnings.buildConflicts > 0
      ? [
          t("buildConflicts", {
            count: v.dataWarnings.buildConflicts,
            total: v.dataWarnings.buildConflictSources,
          }),
        ]
      : []),
    ...(v.dataWarnings.sharedPhotos > 0
      ? [t("sharedPhotos", { count: v.dataWarnings.sharedPhotos })]
      : []),
  ];
  lines.push(
    warningParts.length === 0
      ? { key: "warnings", ok: true, text: t("noDataWarnings") }
      : { key: "warnings", ok: false, text: t("dataWarnings", { list: warningParts.join(" · ") }) },
  );

  return (
    <section
      aria-labelledby="listing-health-heading"
      data-listing-health={v.healthy ? "healthy" : "attention"}
      className={cn(
        "flex max-w-2xl flex-col gap-1.5 rounded-[10px] border px-4 py-3 text-sm",
        v.healthy ? "border-success/30 bg-success/10" : "border-warning/30 bg-warning/10",
      )}
    >
      <div className="flex items-center gap-2">
        {v.healthy ? (
          <ShieldCheck className="size-4 shrink-0 text-success" aria-hidden />
        ) : (
          <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden />
        )}
        <h2
          id="listing-health-heading"
          className={cn("font-medium", v.healthy ? "text-success" : "text-warning")}
        >
          {t("title")}
          {v.publicCount > 0 || !v.healthy ? ` — ${v.healthy ? t("ready") : t("attention")}` : null}
        </h2>
        <Link
          href="/properties/worklist"
          className="ml-auto text-xs font-medium text-text-2 underline underline-offset-2 hover:text-text-1"
        >
          {t("worklist")}
        </Link>
      </div>
      <ul className="flex flex-col gap-1">
        {lines.map((line) => (
          <li key={line.key} data-line={line.key} className="flex items-start gap-1.5 text-text-2">
            {line.ok ? (
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
            ) : (
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
            )}
            <span>{line.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
