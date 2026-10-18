import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card, CardEmpty } from "@/components/features/dashboard/card";
import {
  RETIRED_INVENTORY_HREF,
  inventoryListHref,
  parseInventoryCounts,
  summarizeInventory,
} from "@/lib/services/property-inventory";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";

/**
 * The admin dashboard's Inventory card (F04-C), in place of "Listings by
 * status". Every number opens the list that shows the same rows.
 *
 * SQL (doc 02 §C9 — every dashboard number reproducible by documented SQL):
 *   select * from property_inventory_counts();   -- migration 0153
 *   = select kind, status, count(*) from properties
 *      where visibility <> 'archived' and status <> 'withdrawn'
 *      group by kind, status;
 * SECURITY INVOKER, so under the caller's RLS — the same rows the list reads.
 *
 * - A status total is a count of RECORDS of every kind and opens
 *   /properties?status=S&kind=all; each kind chip opens ?status=S&kind=K.
 * - "Saleable available" is available listings + available units: a project or
 *   phase is a container, never stock beside its own units (the F04 double
 *   count). Rules in lib/services/property-inventory.ts.
 * - Withdrawn and archived records are outside the live scope by definition;
 *   the footer link opens them, so they are one click away, not lost.
 *
 * A failed read, an answer without rows, or a row the function cannot have
 * answered throws to the segment's error boundary — never a zero.
 */
export async function InventoryCard() {
  const t = await getTranslations("dashboard.admin");
  const supabase = await createClient();

  const counts = parseInventoryCounts(
    unwrapRows(await supabase.rpc("property_inventory_counts"), "inventory counts"),
  );
  const { statuses, saleableAvailable } = summarizeInventory(counts);
  const max = Math.max(1, ...statuses.map((s) => s.total));

  const part = (kind: "standalone" | "unit", count: number) => {
    const label = t(`inventory.kinds.${kind}`, { count });
    // a zero opens nothing: a link to an empty list is not a destination
    return count > 0 ? (
      <Link href={inventoryListHref("available", kind)} className="text-brand-700 hover:underline">
        {label}
      </Link>
    ) : (
      <span>{label}</span>
    );
  };

  return (
    <Card title={t("inventory.title")}>
      {statuses.length === 0 ? (
        <CardEmpty text={t("inventory.empty")} href="/properties" action={t("actions.properties")} />
      ) : (
        <>
          <p className="mb-3 text-sm text-text-2">
            {t("inventory.saleable")}:{" "}
            <span className="font-semibold tabular-nums text-text-1">{saleableAvailable.total}</span>
            {" — "}
            {part("standalone", saleableAvailable.listings)}
            {" + "}
            {part("unit", saleableAvailable.units)}
          </p>
          <ul className="flex flex-col gap-3">
            {statuses.map((s) => {
              const label = t(`inventory.status.${s.status}`);
              return (
                <li key={s.status} className="text-sm">
                  <div className="flex items-center gap-3">
                    <span className="w-28 shrink-0 truncate text-text-2">{label}</span>
                    <span className="min-w-0 flex-1">
                      <span
                        className="block h-4 rounded bg-brand-100"
                        style={{ width: `${(s.total / max) * 100}%` }}
                      />
                    </span>
                    <Link
                      href={inventoryListHref(s.status, "all")}
                      aria-label={t("inventory.totalLabel", { status: label, count: s.total })}
                      className="shrink-0 font-medium tabular-nums text-brand-700 hover:underline"
                    >
                      {s.total}
                    </Link>
                  </div>
                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs sm:pl-[7.75rem]">
                    {s.kinds.map((k) => (
                      <Link
                        key={k.kind}
                        href={inventoryListHref(s.status, k.kind)}
                        className="text-brand-700 hover:underline"
                      >
                        {t(`inventory.kinds.${k.kind}`, { count: k.n })}
                      </Link>
                    ))}
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="mt-3 text-xs text-text-3">{t("inventory.footnote")}</p>
      <p className="mt-2 text-sm">
        <Link href={RETIRED_INVENTORY_HREF} className="font-medium text-brand-700 hover:underline">
          {t("inventory.retired")} →
        </Link>
      </p>
    </Card>
  );
}
