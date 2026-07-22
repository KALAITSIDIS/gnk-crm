import { z } from "zod";

/**
 * Shared list pagination (audit 2026-07-22, finding PERF-2).
 *
 * /properties and /contacts each grew their own copy of this arithmetic;
 * /leads, /viewings, /tasks and /keys had a hard `.limit()` and no pagination
 * at all, so past the cap their exact header counts disagreed with the rows on
 * screen and the remainder was unreachable. One implementation, one page size,
 * unit-tested — so the next list gets it right for free.
 */

/** Rows per page on every paginated list (matches the original 25). */
export const LIST_PAGE_SIZE = 25;

/**
 * `?page=` is user-editable, so junk must degrade to page 1 rather than throw:
 * an unparseable query param must never take down a list screen.
 * `.catch(1)` covers non-numeric, zero, negative and fractional input.
 */
export const pageSchema = z.coerce.number().int().min(1).catch(1).default(1);

/**
 * Inclusive `.range()` bounds for a 1-based page. Supabase's range is
 * inclusive at BOTH ends, so a 25-row page is 0..24, not 0..25.
 */
export function pageRange(
  page: number,
  size: number = LIST_PAGE_SIZE,
): { from: number; to: number } {
  const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
  const from = (safePage - 1) * size;
  return { from, to: from + size - 1 };
}

/** Page count for a total, never below 1 so the UI never says "page 1 of 0". */
export function totalPages(total: number, size: number = LIST_PAGE_SIZE): number {
  if (!Number.isFinite(total) || total <= 0) return 1;
  return Math.max(1, Math.ceil(total / size));
}

/**
 * PostgREST returns PGRST103 when the requested range starts past the end of
 * the result set — reachable from a stale `?page=` or a row deleted between
 * navigations. That is a dead end to render as an empty page, NOT an error to
 * throw at the T5.7 boundary.
 */
export function isRangeBeyondEnd(error: { code?: string } | null | undefined): boolean {
  return error?.code === "PGRST103";
}
