import { formatDateTime, formatMoney } from "@/lib/utils/format";

/**
 * Price history (T1.7): sparkline + table on the property Overview, fed by the
 * price_history table (written by DB trigger on every asking_price change).
 */

export interface PriceHistoryRow {
  id: string;
  old_price: number | null;
  new_price: number | null;
  changed_at: string;
  changed_by_name: string | null;
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 220;
  const h = 48;
  const pad = 4;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = (w - pad * 2) / (points.length - 1);
  const coords = points
    .map((p, i) => `${pad + i * step},${h - pad - ((p - min) / span) * (h - pad * 2)}`)
    .join(" ");
  const rising = points[points.length - 1] >= points[0];

  return (
    <svg width={w} height={h} className="shrink-0" aria-label="Asking price history">
      <polyline
        points={coords}
        fill="none"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        className={rising ? "stroke-success" : "stroke-danger"}
      />
    </svg>
  );
}

export function PriceHistorySection({
  rows,
  currentPrice,
}: {
  rows: PriceHistoryRow[];
  currentPrice: number | null;
}) {
  if (rows.length === 0) {
    return (
      <div className="mt-4 border-t border-border pt-4">
        <h3 className="text-base font-semibold text-text-1">Price history</h3>
        <p className="mt-1 text-sm text-text-3">No price changes recorded yet.</p>
      </div>
    );
  }

  // chronological series: each change's old value, then the latest new value
  const chronological = [...rows].reverse();
  const series: number[] = [];
  for (const r of chronological) {
    if (r.old_price !== null) series.push(r.old_price);
  }
  const last = chronological[chronological.length - 1];
  if (last?.new_price !== null && last?.new_price !== undefined) series.push(last.new_price);
  else if (currentPrice !== null) series.push(currentPrice);

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-base font-semibold text-text-1">Price history</h3>
        <Sparkline points={series} />
      </div>
      <table className="mt-2 w-full text-sm">
        <thead>
          <tr className="text-left text-[13px] text-text-2">
            <th className="py-1.5 font-medium">When</th>
            <th className="py-1.5 text-right font-medium">From</th>
            <th className="py-1.5 text-right font-medium">To</th>
            <th className="py-1.5 pl-4 font-medium">By</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border/60">
              <td className="py-1.5 text-text-2">{formatDateTime(r.changed_at)}</td>
              <td className="py-1.5 text-right tabular-nums text-text-2">
                {formatMoney(r.old_price)}
              </td>
              <td className="py-1.5 text-right font-medium tabular-nums text-text-1">
                {formatMoney(r.new_price)}
              </td>
              <td className="py-1.5 pl-4 text-text-2">{r.changed_by_name ?? "system"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
