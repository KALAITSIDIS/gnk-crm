import Link from "next/link";
import Image from "next/image";
import { ArrowDown, ArrowUp, ArrowUpDown, Building2 } from "lucide-react";
import { MandateBadge, type MandateBadgeState } from "@/components/features/shared/mandate-badge";
import { StatusBadge } from "@/components/features/shared/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ColumnSort, SortableColumn } from "@/lib/queries/properties-list";
import { formatArea, formatMoney } from "@/lib/utils/format";
import { publicMediaUrl } from "@/lib/utils/storage";
import { cn } from "@/lib/utils";

export interface PropertyRow {
  id: string;
  reference: string;
  kind: string;
  property_type: string;
  transaction_type: string;
  status: string;
  visibility: string;
  title: string | null;
  district: string | null;
  area: string | null;
  bedrooms: number | null;
  covered_area_sqm: number | null;
  plot_area_sqm: number | null;
  building_density_pct: number | null;
  asking_price: number | null;
  rent_price_month: number | null;
  quality_score: number;
  mandate: MandateBadgeState;
  thumb: string | null;
}

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Which rows are not plain listings — named on the row, because "All kinds"
 * (F04) puts a project beside its own units and the list must not leave the
 * reader to tell them apart by reference.
 */
const KIND_TAG: Record<string, string> = { project: "Project", phase: "Phase", unit: "Unit" };

function priceCell(row: PropertyRow) {
  if (row.transaction_type === "rent") {
    return row.rent_price_month ? `${formatMoney(row.rent_price_month)}/mo` : "—";
  }
  // A project's or phase's own asking price is its "from" figure — the units
  // carry the prices (the detail page labels it "From price"). Beside its
  // units it must not read as one more price.
  if ((row.kind === "project" || row.kind === "phase") && row.asking_price !== null) {
    return `from ${formatMoney(row.asking_price)}`;
  }
  return formatMoney(row.asking_price);
}

/** A density as the land panel records it; an unknown one is a dash, never 0%. */
function densityCell(pct: number | null) {
  if (pct === null || !Number.isFinite(pct)) return "—";
  return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(pct)}%`;
}

function typeText(row: PropertyRow) {
  return `${labelize(row.property_type)}${KIND_TAG[row.kind] ? ` · ${KIND_TAG[row.kind]}` : ""}`;
}

function locationText(row: PropertyRow) {
  return [row.district, row.area].filter(Boolean).join(" · ") || "—";
}

function scoreColor(score: number) {
  if (score >= 70) return "text-success";
  if (score >= 50) return "text-warning";
  return "text-danger";
}

function Thumb({ row, className }: { row: PropertyRow; className?: string }) {
  if (row.thumb) {
    return (
      <Image
        src={publicMediaUrl(row.thumb)}
        alt={row.reference}
        width={64}
        height={48}
        className={cn("rounded object-cover", className)}
        unoptimized
      />
    );
  }
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded bg-surface-2 text-text-3",
        className,
      )}
    >
      <Building2 className="size-4" />
    </div>
  );
}

/**
 * Column priority (A03). The table showed twelve columns from the tablet
 * breakpoint up inside a horizontal scroller, so at tablet and small-laptop
 * widths everything right of the title was off screen. Now the layout is
 * FIXED — the narrow columns have widths, the title and the location share
 * what is left and truncate (the full text is the cell's title) — and the
 * columns appear by priority, a header and its cells hidden by one class so
 * they cannot misalign:
 *
 *   md (tablet)  reference · title · price · status — the title cell carries
 *                the type and the location on a second line
 *   lg (1024)    + location · area (plot for land)
 *   xl (1280)    + beds (density for land) · mandate
 *   1680 px      + photo · type · score · visibility
 *
 * The fixed widths at each step sum to well under the content width beside
 * the sidebar (lg: 464 of 728 px; xl: 656 of 984), so the table no longer
 * scrolls sideways at 1024 px; each fixed width holds its header with the
 * sort arrow. Below the tablet breakpoint the default view is the cards.
 */
const COLUMN = {
  thumb: "hidden w-16 min-[1680px]:table-cell",
  reference: "w-28",
  title: "",
  location: "hidden lg:table-cell",
  type: "hidden w-32 min-[1680px]:table-cell",
  beds: "hidden w-20 text-right xl:table-cell",
  area: "hidden w-24 text-right lg:table-cell",
  price: "w-36 text-right",
  score: "hidden w-20 text-right min-[1680px]:table-cell",
  mandate: "hidden w-28 xl:table-cell",
  status: "w-28",
  visibility: "hidden w-28 min-[1680px]:table-cell",
} as const;

/**
 * A header that sorts: a plain server-rendered link (no client code) to the
 * same list with the column's next sort, every filter kept, page 1 — and
 * `aria-sort` on the column that is the current sort.
 */
function SortableHead({
  label,
  sort,
  className,
}: {
  label: string;
  sort: ColumnSort | undefined;
  className: string;
}) {
  if (!sort) return <TableHead className={className}>{label}</TableHead>;
  const Icon = sort.direction === "ascending" ? ArrowUp : sort.direction === "descending" ? ArrowDown : ArrowUpDown;
  return (
    <TableHead className={className} aria-sort={sort.direction ?? undefined}>
      <Link
        href={sort.href}
        scroll={false}
        className={cn(
          "inline-flex items-center gap-1 hover:text-brand-700",
          sort.direction ? "text-text-1" : "text-text-2",
        )}
      >
        {label}
        <Icon className="size-3.5 text-text-3" aria-hidden="true" />
      </Link>
    </TableHead>
  );
}

export function PropertiesTable({
  rows,
  land = false,
  sorts = {},
}: {
  rows: PropertyRow[];
  /** `type=land` (A03): "Plot m²" and "Density %" in place of "Area" and "Beds" */
  land?: boolean;
  /** the sortable headers' links, built by the page from its own URL */
  sorts?: Partial<Record<SortableColumn, ColumnSort>>;
}) {
  return (
    <div className="overflow-x-auto rounded-[10px] border border-border bg-surface">
      <Table className="table-fixed">
        <TableHeader className="bg-surface">
          <TableRow>
            <TableHead className={COLUMN.thumb}>
              <span className="sr-only">Photo</span>
            </TableHead>
            <SortableHead label="Reference" sort={sorts.reference} className={COLUMN.reference} />
            <TableHead className={COLUMN.title}>Title</TableHead>
            <TableHead className={COLUMN.location}>Location</TableHead>
            <TableHead className={COLUMN.type}>Type</TableHead>
            <TableHead className={COLUMN.beds}>{land ? "Density" : "Beds"}</TableHead>
            {land ? (
              <SortableHead label="Plot m²" sort={sorts.plot} className={COLUMN.area} />
            ) : (
              <TableHead className={COLUMN.area}>Area</TableHead>
            )}
            <SortableHead label="Price" sort={sorts.price} className={COLUMN.price} />
            <SortableHead label="Score" sort={sorts.score} className={COLUMN.score} />
            <TableHead className={COLUMN.mandate}>Mandate</TableHead>
            <TableHead className={COLUMN.status}>Status</TableHead>
            <TableHead className={COLUMN.visibility}>Visibility</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} className="h-11 hover:bg-surface-2">
              <TableCell className={cn(COLUMN.thumb, "py-1")}>
                <Thumb row={row} className="h-8 w-12" />
              </TableCell>
              <TableCell className={cn(COLUMN.reference, "font-medium")}>
                <Link
                  href={`/properties/${row.id}`}
                  className="block truncate text-brand-700 hover:underline"
                  title={row.reference}
                >
                  {row.reference}
                </Link>
              </TableCell>
              <TableCell className="text-[13px]">
                <div className="truncate" title={row.title ?? undefined}>
                  {row.title ?? "—"}
                </div>
                {/* what the hidden Type and Location columns would say */}
                <div className="truncate text-xs text-text-3 min-[1680px]:hidden">
                  {typeText(row)}
                  <span className="lg:hidden"> · {locationText(row)}</span>
                </div>
              </TableCell>
              <TableCell className={cn(COLUMN.location, "text-[13px] text-text-2")}>
                <div className="truncate" title={locationText(row)}>
                  {locationText(row)}
                </div>
              </TableCell>
              <TableCell className={cn(COLUMN.type, "text-[13px]")}>
                <div className="truncate">
                  {labelize(row.property_type)}
                  {KIND_TAG[row.kind] ? <span className="text-text-3"> · {KIND_TAG[row.kind]}</span> : null}
                </div>
              </TableCell>
              <TableCell className={cn(COLUMN.beds, "tabular-nums")}>
                {land ? densityCell(row.building_density_pct) : (row.bedrooms ?? "—")}
              </TableCell>
              <TableCell className={cn(COLUMN.area, "tabular-nums text-[13px]")}>
                {formatArea(land || row.property_type === "land" ? row.plot_area_sqm : row.covered_area_sqm)}
              </TableCell>
              <TableCell className={cn(COLUMN.price, "font-medium tabular-nums")}>
                <div className="truncate" title={priceCell(row)}>
                  {priceCell(row)}
                </div>
              </TableCell>
              <TableCell className={cn(COLUMN.score, "tabular-nums", scoreColor(row.quality_score))}>
                {row.quality_score}
              </TableCell>
              <TableCell className={COLUMN.mandate}>
                <MandateBadge state={row.mandate} />
              </TableCell>
              <TableCell className={COLUMN.status}>
                <StatusBadge status={row.status} />
              </TableCell>
              <TableCell className={COLUMN.visibility}>
                <StatusBadge status={row.visibility} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function PropertiesCards({ rows }: { rows: PropertyRow[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {rows.map((row) => (
        <Link
          key={row.id}
          href={`/properties/${row.id}`}
          className="group rounded-[10px] border border-border bg-surface shadow-sm transition-shadow hover:shadow-md"
        >
          <Thumb row={row} className="h-40 w-full rounded-b-none rounded-t-[10px]" />
          <div className="flex flex-col gap-1.5 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold text-brand-700">
                {row.reference}
                {KIND_TAG[row.kind] ? (
                  <span className="text-xs font-normal text-text-3"> · {KIND_TAG[row.kind]}</span>
                ) : null}
              </span>
              <MandateBadge state={row.mandate} />
            </div>
            <p className="truncate text-sm text-text-1">{row.title ?? labelize(row.property_type)}</p>
            <p className="truncate text-xs text-text-2">{locationText(row)}</p>
            <div className="mt-1 flex items-center justify-between">
              <span className="font-semibold tabular-nums text-text-1">{priceCell(row)}</span>
              <StatusBadge status={row.status} />
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
