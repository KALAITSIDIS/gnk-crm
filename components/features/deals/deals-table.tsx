import Link from "next/link";
import { StatusBadge } from "@/components/features/shared/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatMoney } from "@/lib/utils/format";

/**
 * One row of the /deals register (F05), already resolved by the page: the
 * figure is `dealValue()` with its basis (`dealValueIsFinal()`), so a won deal
 * closed without a confirmed price never passes its estimate off as the price
 * (T-won-value-surfaces).
 */
export interface DealListItem {
  id: string;
  title: string;
  dealType: string;
  stageName: string | null;
  status: string;
  value: number | null;
  valueIsFinal: boolean;
  propertyId: string | null;
  propertyRef: string | null;
  buyerId: string | null;
  buyerName: string | null;
  agentName: string | null;
  createdAt: string;
  /** won_at for a won deal, lost_at for a lost one; null while open */
  closedAt: string | null;
}

/** A plain function of its props (no hooks), so it renders on the server. */
export function DealsTable({ rows }: { rows: DealListItem[] }) {
  return (
    <div className="overflow-x-auto rounded-[10px] border border-border bg-surface">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Deal</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Stage</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Value</TableHead>
            <TableHead>Property</TableHead>
            <TableHead>Buyer</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Closed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((d) => (
            <TableRow key={d.id} className="h-11 hover:bg-surface-2">
              <TableCell className="max-w-72 font-medium">
                <Link href={`/deals/${d.id}`} className="line-clamp-2 text-brand-700 hover:underline">
                  {d.title}
                </Link>
              </TableCell>
              <TableCell className="text-[13px] capitalize text-text-2">{d.dealType}</TableCell>
              <TableCell className="text-[13px] text-text-2">{d.stageName ?? "—"}</TableCell>
              <TableCell>
                <StatusBadge status={d.status} />
              </TableCell>
              <TableCell className="text-right">
                <span className="block text-[13px] font-semibold tabular-nums text-text-1">
                  {formatMoney(d.value)}
                </span>
                {d.value !== null ? (
                  <span className="block text-[11px] text-text-3">
                    {d.valueIsFinal ? "final" : "expected"}
                  </span>
                ) : null}
              </TableCell>
              <TableCell className="text-[13px]">
                {d.propertyId && d.propertyRef ? (
                  <Link href={`/properties/${d.propertyId}`} className="font-mono text-brand-700 hover:underline">
                    {d.propertyRef}
                  </Link>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell className="max-w-40 truncate text-[13px]">
                {d.buyerId && d.buyerName ? (
                  <Link href={`/contacts/${d.buyerId}`} className="text-brand-700 hover:underline">
                    {d.buyerName}
                  </Link>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell className="text-[13px] text-text-2">{d.agentName ?? "—"}</TableCell>
              <TableCell className="whitespace-nowrap text-[13px] text-text-3">{formatDate(d.createdAt)}</TableCell>
              <TableCell className="whitespace-nowrap text-[13px] text-text-3">{formatDate(d.closedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
