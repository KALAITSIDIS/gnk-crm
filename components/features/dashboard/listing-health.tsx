import Link from "next/link";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { daysOnMarket, isPriceReviewDue, PRICE_REVIEW_DAYS } from "@/lib/services/listing-health";
import { PUBLISH_THRESHOLD } from "@/lib/services/quality-score";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

/**
 * One line beside the cron banner: is anything public that should not be
 * (audit 2026-09-15, LST-03)?
 *
 * `published_below_threshold()` has existed since 0066 to keep one drift
 * visible — the feed deliberately does not re-check the score, so a public
 * listing whose score decayed (a mandate expired, a photo deleted) stays
 * live everywhere — and nothing rendered it. It reads the STORED score, which
 * the nightly recompute keeps current; the worklist computes fresh. Beside
 * it, the longest-standing public listing, because nothing said how long a
 * listing had been on the market and a price nobody has looked at in months
 * is the commonest portal complaint.
 *
 * Server component in the admin branch. The function is SECURITY INVOKER,
 * so the user's own client is right here (unlike cron_health, 0074).
 */
export async function ListingHealth() {
  const supabase = await createClient();
  const [below, live] = await Promise.all([
    supabase.rpc("published_below_threshold"),
    supabase
      .from("properties")
      .select("id, reference, published_at")
      .eq("visibility", "public")
      .eq("status", "available"),
  ]);

  if (below.error || live.error) {
    return (
      <div className="flex max-w-2xl items-center gap-2 rounded-[10px] border border-warning/30 bg-warning/10 px-4 py-3 text-sm font-medium text-warning">
        <ShieldAlert className="size-4 shrink-0" />
        Listing health: unreadable ({below.error?.message ?? live.error?.message}).
      </div>
    );
  }

  const now = new Date();
  const belowRows = below.data ?? [];
  const onMarket = (live.data ?? [])
    .filter((p): p is typeof p & { published_at: string } => Boolean(p.published_at))
    .map((p) => ({ ...p, days: daysOnMarket(p.published_at, now) }))
    .sort((a, b) => b.days - a.days || a.reference.localeCompare(b.reference));
  const due = onMarket.filter((m) => isPriceReviewDue(m.days));
  const longest = onMarket[0];
  const healthy = belowRows.length === 0 && due.length === 0;

  return (
    <div
      className={cn(
        "flex max-w-2xl items-start gap-2 rounded-[10px] border px-4 py-3 text-sm font-medium",
        healthy
          ? "border-success/30 bg-success/10 text-success"
          : "border-warning/30 bg-warning/10 text-warning",
      )}
    >
      {healthy ? (
        <ShieldCheck className="mt-0.5 size-4 shrink-0" />
      ) : (
        <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      )}
      <span>
        {belowRows.length === 0
          ? `Listing health: ${onMarket.length === 0 ? "nothing public" : `all ${onMarket.length} public ${onMarket.length === 1 ? "listing clears" : "listings clear"} the publish threshold`}.`
          : `Listing health: ${belowRows.length} public ${belowRows.length === 1 ? "listing scores" : "listings score"} below ${PUBLISH_THRESHOLD} — ${belowRows.map((r) => `${r.reference} (${r.quality_score})`).join(", ")}.`}
        {longest ? (
          <>
            {" "}
            Longest on the market: {longest.reference}, {longest.days}{" "}
            {longest.days === 1 ? "day" : "days"}
            {due.length > 0
              ? `; ${due.length} at ${PRICE_REVIEW_DAYS}+ days, due a price review`
              : ""}
            .
          </>
        ) : null}{" "}
        <Link href="/properties/worklist" className="underline underline-offset-2">
          Worklist
        </Link>
      </span>
    </div>
  );
}
