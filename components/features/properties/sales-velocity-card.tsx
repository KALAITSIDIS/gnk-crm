import { formatMoney } from "@/lib/utils/format";
import type { VelocityResult } from "@/lib/services/sales-velocity";

/**
 * Sales velocity + absorption for a project's units.
 *
 * Server component: everything it shows is derived, nothing is interactive.
 *
 * The chart is hand-rolled SVG, like `Sparkline` in price-history.tsx — 24
 * rects do not justify a charting dependency, and the CSP on this app makes
 * every added script a deliberate decision rather than a convenience.
 */

const MONTH_LABEL = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-08" → "Aug 26" */
function shortMonth(key: string): string {
  const [y, m] = key.split("-");
  return `${MONTH_LABEL[Number(m) - 1] ?? m} ${y!.slice(2)}`;
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "success" | "muted";
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-text-3">{label}</span>
      <span
        className={
          "text-xl font-semibold tabular-nums " +
          (tone === "success" ? "text-success" : tone === "muted" ? "text-text-2" : "text-text-1")
        }
      >
        {value}
      </span>
      {hint ? <span className="text-xs text-text-3">{hint}</span> : null}
    </div>
  );
}

function MonthlyBars({ months }: { months: VelocityResult["months"] }) {
  const peak = Math.max(1, ...months.map((m) => m.sold));
  const w = 640;
  const h = 96;
  const gap = 3;
  const barW = (w - gap * (months.length - 1)) / months.length;

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${w} ${h + 18}`}
        className="h-32 w-full min-w-[520px]"
        role="img"
        aria-label={`Units sold per month. Peak ${peak} in a single month.`}
      >
        {months.map((m, i) => {
          const barH = m.sold === 0 ? 1 : Math.max(2, (m.sold / peak) * h);
          const x = i * (barW + gap);
          return (
            <g key={m.month}>
              <rect
                x={x}
                y={h - barH}
                width={barW}
                height={barH}
                rx={2}
                className={m.sold > 0 ? "fill-brand-500" : "fill-border"}
              >
                <title>{`${shortMonth(m.month)}: ${m.sold} sold`}</title>
              </rect>
              {/* label every sixth month, and always the last one, so the axis
                  stays readable at 24 buckets */}
              {i % 6 === 0 || i === months.length - 1 ? (
                <text
                  x={x + barW / 2}
                  y={h + 13}
                  textAnchor="middle"
                  className="fill-text-3 text-[9px]"
                >
                  {shortMonth(m.month)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function SalesVelocityCard({ velocity }: { velocity: VelocityResult }) {
  const v = velocity;

  if (v.totalUnits === 0) {
    return (
      <section className="rounded-[10px] border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-text-1">Sales velocity</h2>
        <p className="mt-1 text-sm text-text-2">
          No units on this project yet. Velocity appears once units exist and start selling.
        </p>
      </section>
    );
  }

  const soldValue = v.months.reduce((s, m) => s + m.value, 0);

  return (
    <section className="flex flex-col gap-4 rounded-[10px] border border-border bg-surface p-5">
      <div>
        <h2 className="text-sm font-semibold text-text-1">Sales velocity</h2>
        <p className="mt-0.5 text-xs text-text-3">
          Sale dates come from the event log, so they are as accurate as the day each unit was
          actually marked sold.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Units" value={String(v.totalUnits)} />
        <Stat
          label="Sold"
          value={String(v.soldTotal)}
          tone="success"
          hint={`${v.absorptionPct.toFixed(0)}% absorbed`}
        />
        <Stat label="Remaining" value={String(v.remaining)} hint="excludes withdrawn" />
        <Stat
          label="Pace"
          value={v.perMonth === 0 ? "—" : `${v.perMonth.toFixed(1)}/mo`}
          hint={v.perMonth === 0 ? "no sales in 12 months" : "last 12 months"}
          tone={v.perMonth === 0 ? "muted" : undefined}
        />
      </div>

      <MonthlyBars months={v.months} />

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
        {v.monthsToSellOut === null ? (
          <span className="text-text-2">
            {v.remaining > 0
              ? "Nothing has sold in the last 12 months, so there is no current pace to project from."
              : "Everything available has sold."}
          </span>
        ) : (
          <span className="text-text-2">
            At the last 12 months&rsquo; pace, the remaining {v.remaining}{" "}
            {v.remaining === 1 ? "unit" : "units"} would take about{" "}
            <span className="font-medium text-text-1 tabular-nums">
              {Math.ceil(v.monthsToSellOut)} months
            </span>
            .
          </span>
        )}
        {soldValue > 0 ? (
          <span className="text-text-3">
            {formatMoney(soldValue)} sold in the charted period
          </span>
        ) : null}
      </div>

      {/* A chart quietly missing sales is worse than one that says so. */}
      {v.soldUndated > 0 ? (
        <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-text-2">
          {v.soldUndated} sold {v.soldUndated === 1 ? "unit has" : "units have"} no recorded sale
          date — created already sold, or imported. {v.soldUndated === 1 ? "It is" : "They are"}{" "}
          counted in Sold and absorption above, but {v.soldUndated === 1 ? "does" : "do"} not appear
          in the chart or the pace.
        </p>
      ) : null}
    </section>
  );
}
