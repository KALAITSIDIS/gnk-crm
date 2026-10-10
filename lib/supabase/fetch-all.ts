/**
 * Every row of a query, page by page — because PostgREST caps a single read at
 * 1,000 rows SILENTLY. A `select()` that is not paged returns the first
 * thousand and no error, so a sweep that "found no more" may simply have
 * stopped reading: the quality worklist met this first (2026-09-02), and the
 * audit's A08a found the same shape under the match alerts — every active
 * requirement is read to decide who to tell, and the 1,001st buyer would
 * never have been told — and under the mandate exclusion, where the 1,001st
 * excluded id would have let its property back onto the list.
 *
 * ONE helper, so the page size, the stop condition and the failure mode live
 * in one place. The caller supplies a factory that builds a FRESH query for
 * each page — builders are mutable, so reusing one and calling `.range()`
 * twice on it is exactly the kind of thing that works until it does not — and
 * the factory must order the query (`.order("id")`): a page over an unordered
 * result set is a different random sample each time.
 *
 * FAILS LOUD. A page that errors throws, rather than returning what was read
 * so far as if it were everything — "no matches" and "the read failed" are
 * different facts, and returning [] for both is how a feature stops working
 * with nothing anywhere to say so.
 */

/** PostgREST's default `max-rows`. A page this size that comes back full may have more behind it. */
export const FETCH_PAGE = 1000;

export interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  label: string,
  pageSize: number = FETCH_PAGE,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) throw new Error(`Query failed (${label}): ${error.message}`);
    const got = data ?? [];
    rows.push(...got);
    // Stop on an EMPTY page, and advance by what actually arrived — not by
    // the page size. PostgREST caps a response at the project's `max-rows`,
    // which is 1000 by default but is a SETTING: lower it (a plausible
    // hardening of a public anon key) and every page comes back short, which
    // a `got.length < pageSize` stop would read as "that was the last one"
    // and silently truncate every sweep in this codebase (2026-09-07 review).
    // The cost of asking is one extra empty read per sweep.
    if (got.length === 0) return rows;
    from += got.length;
  }
}

/** Every row up to a ceiling — or word that the query matches more than that. */
export type UpTo<T> = { more: false; rows: T[] } | { more: true; rows: null };

/**
 * `fetchAll` with a ceiling, for a read whose size a user's filters decide
 * (the list CSV exports). Same paging, same rules — a fresh, uniquely ordered
 * query per page, advance by what arrived, stop on an empty page, throw on a
 * failed one — but it never asks for more than ONE row past `max`: that row's
 * presence is the whole question, so at most `max + 1` rows are ever read or
 * held. Past the ceiling it answers `more` and hands back NO rows, so a caller
 * cannot mistake the first `max` for everything.
 */
export async function fetchUpTo<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  label: string,
  max: number,
  pageSize: number = FETCH_PAGE,
): Promise<UpTo<T>> {
  const rows: T[] = [];
  for (;;) {
    const from = rows.length;
    const to = Math.min(from + pageSize, max + 1) - 1;
    const { data, error } = await page(from, to);
    if (error) throw new Error(`Query failed (${label}): ${error.message}`);
    // An answer with no rows array is not an empty page: postgrest-js reports
    // an OK response with an EMPTY BODY as `data: null, error: null`, and
    // reading that as the end would hand back the pages before it as all.
    if (!Array.isArray(data)) throw new Error(`Query failed (${label}): the answer held no rows`);
    const got = data;
    if (got.length === 0) return { more: false, rows };
    // never keep more than was asked for, whatever the server sent
    rows.push(...got.slice(0, to - from + 1));
    if (rows.length > max) return { more: true, rows: null };
  }
}
