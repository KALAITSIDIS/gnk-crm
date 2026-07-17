import Link from "next/link";
import Image from "next/image";
import { Building2 } from "lucide-react";
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
  asking_price: number | null;
  rent_price_month: number | null;
  quality_score: number;
  mandate: MandateBadgeState;
  thumb: string | null;
}

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function priceCell(row: PropertyRow) {
  if (row.transaction_type === "rent") {
    return row.rent_price_month ? `${formatMoney(row.rent_price_month)}/mo` : "—";
  }
  return formatMoney(row.asking_price);
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

export function PropertiesTable({ rows }: { rows: PropertyRow[] }) {
  return (
    <div className="overflow-x-auto rounded-[10px] border border-border bg-surface">
      <Table>
        <TableHeader className="bg-surface">
          <TableRow>
            <TableHead className="w-12" />
            <TableHead>Reference</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Location</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Beds</TableHead>
            <TableHead className="text-right">Area</TableHead>
            <TableHead className="text-right">Price</TableHead>
            <TableHead className="text-right">Score</TableHead>
            <TableHead>Mandate</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Visibility</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} className="h-11 hover:bg-surface-2">
              <TableCell className="py-1">
                <Thumb row={row} className="h-8 w-12" />
              </TableCell>
              <TableCell className="font-medium">
                <Link href={`/properties/${row.id}`} className="text-brand-700 hover:underline">
                  {row.reference}
                </Link>
              </TableCell>
              <TableCell className="max-w-56 truncate text-[13px]">{row.title ?? "—"}</TableCell>
              <TableCell className="text-[13px] text-text-2">
                {[row.district, row.area].filter(Boolean).join(" · ") || "—"}
              </TableCell>
              <TableCell className="text-[13px]">{labelize(row.property_type)}</TableCell>
              <TableCell className="text-right tabular-nums">{row.bedrooms ?? "—"}</TableCell>
              <TableCell className="text-right tabular-nums text-[13px]">
                {formatArea(row.property_type === "land" ? row.plot_area_sqm : row.covered_area_sqm)}
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">{priceCell(row)}</TableCell>
              <TableCell className={cn("text-right tabular-nums", scoreColor(row.quality_score))}>
                {row.quality_score}
              </TableCell>
              <TableCell>
                <MandateBadge state={row.mandate} />
              </TableCell>
              <TableCell>
                <StatusBadge status={row.status} />
              </TableCell>
              <TableCell>
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
              <span className="text-sm font-semibold text-brand-700">{row.reference}</span>
              <MandateBadge state={row.mandate} />
            </div>
            <p className="truncate text-sm text-text-1">{row.title ?? labelize(row.property_type)}</p>
            <p className="truncate text-xs text-text-2">
              {[row.district, row.area].filter(Boolean).join(" · ") || "—"}
            </p>
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
