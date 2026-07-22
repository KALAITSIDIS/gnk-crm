import Link from "next/link";
import { Button } from "@/components/ui/button";
import { LIST_PAGE_SIZE } from "@/lib/validators/pagination";

type SearchParams = { [key: string]: string | string[] | undefined };

/**
 * Shared list pager (audit 2026-07-22, finding PERF-2).
 *
 * Always states the range and the total, even on a single page — the defect
 * this closes was a list showing 100 rows under a header reading "437 open",
 * with no way to reach the rest. Saying "Showing 1–25 of 437" is half the fix;
 * the Previous/Next links are the other half.
 *
 * Preserves every other query param so paging never silently drops a filter.
 */
export function Pager({
  page,
  pageCount,
  total,
  searchParams,
  size = LIST_PAGE_SIZE,
  label = "rows",
}: {
  page: number;
  pageCount: number;
  total: number;
  searchParams: SearchParams;
  size?: number;
  /** plural noun for the count line, e.g. "leads" */
  label?: string;
}) {
  if (total === 0) return null;

  const href = (target: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (k === "page") continue;
      const val = Array.isArray(v) ? v[0] : v;
      if (val) params.set(k, val);
    }
    // page=1 is the default; keep it out of the URL so the canonical link is clean
    if (target > 1) params.set("page", String(target));
    const qs = params.toString();
    return qs ? `?${qs}` : "?";
  };

  const from = (page - 1) * size + 1;
  const to = Math.min(page * size, total);

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 text-sm text-text-2"
    >
      <span>
        Showing <span className="tabular-nums">{from}</span>–
        <span className="tabular-nums">{to}</span> of{" "}
        <span className="tabular-nums">{total}</span> {label}
      </span>
      {pageCount > 1 ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-3">
            Page {page} of {pageCount}
          </span>
          {page > 1 ? (
            <Button asChild variant="outline" size="sm">
              <Link href={href(page - 1)} rel="prev">
                Previous
              </Link>
            </Button>
          ) : null}
          {page < pageCount ? (
            <Button asChild variant="outline" size="sm">
              <Link href={href(page + 1)} rel="next">
                Next
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}
