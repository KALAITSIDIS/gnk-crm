/**
 * The /deals filter bar's URL bookkeeping (F05 review), kept out of React so
 * it can be tested on its own.
 *
 * The bar writes every filter to the URL with `router.replace`; the server
 * renders the list for it. Two things make that racy:
 *
 *  - A write takes a server render to come back. The search and date boxes
 *    keep being typed in meanwhile, so the URL that lands can be OLDER than
 *    the box. Moving the box to it would drop the keystrokes typed during the
 *    render — and the next keystroke would then write the shortened text.
 *  - A new navigation supersedes one still on its way (Next discards the
 *    pending one). A write built on the URL last RENDERED would drop the
 *    change still on its way: pick a status while the search is being written,
 *    and the search was lost.
 *
 * So: each write is built on the latest URL this bar wrote (or the one on
 * screen when nothing is on its way), and the boxes follow the URL only after
 * a navigation that is NOT one of this bar's writes — Back/Forward, a link —
 * and never over a change still waiting to be written. A write of ours that
 * lands never moves a box: the box already shows what it carried (the search
 * trimmed, a date only once it is a whole day).
 */

/** The filters typed into boxes (the others are selects and pickers, read from the URL directly). */
export const TYPED_FILTERS = ["q", "closed_from", "closed_to"] as const;
export type TypedFilter = (typeof TYPED_FILTERS)[number];
export type TypedValues = Record<TypedFilter, string>;

/** A filter change: a value sets the parameter; undefined, "" or ANY removes it. */
export type FilterUpdates = Record<string, string | undefined>;

/** A select's "no filter" choice (Radix Select cannot hold ""). */
export const ANY = "__all__";

export class FilterUrlWriter {
  /** typed changes waiting for the pause */
  private queued: FilterUpdates = {};
  /** query strings this bar replaced to that have not rendered yet, oldest first */
  private written: string[] = [];
  /** the query string on screen */
  private rendered: string;

  constructor(rendered: string) {
    this.rendered = rendered;
  }

  /** Keep a typed change for the next write. */
  queue(updates: FilterUpdates): void {
    this.queued = { ...this.queued, ...updates };
  }

  /**
   * The query string to navigate to now — everything queued plus `updates`,
   * on top of the latest URL this bar wrote, back on page 1 — or null when
   * that is the URL already on screen and nothing else is on its way.
   */
  write(updates: FilterUpdates = {}): string | null {
    const all = { ...this.queued, ...updates };
    this.queued = {};
    const params = new URLSearchParams(this.written.at(-1) ?? this.rendered);
    for (const [key, value] of Object.entries(all)) {
      if (value === undefined || value === "" || value === ANY) params.delete(key);
      else params.set(key, value);
    }
    params.delete("page"); // a changed filter always returns to page 1
    return this.record(params.toString());
  }

  /** "Clear filters": nothing queued, every parameter gone. */
  clear(): string | null {
    this.queued = {};
    return this.record("");
  }

  private record(qs: string): string | null {
    if (this.written.length === 0 && qs === this.rendered) return null;
    this.written.push(qs);
    return qs;
  }

  /**
   * A render of the URL `rendered`, whose typed filters read `url` (as the
   * server parsed them), while the boxes show `boxes`. Returns the boxes to
   * move and the value each takes.
   */
  observe(rendered: string, url: TypedValues, boxes: TypedValues): Partial<TypedValues> {
    if (rendered === this.rendered) return {};
    this.rendered = rendered;
    const mine = this.written.lastIndexOf(rendered);
    if (mine !== -1) {
      // one of our writes landed; any written after it are still on their way
      this.written = this.written.slice(mine + 1);
      return {};
    }
    // a navigation that is not ours: it superseded whatever we had on its way
    this.written = [];
    const moves: Partial<TypedValues> = {};
    for (const key of TYPED_FILTERS) {
      if (key in this.queued) continue; // a change waiting to be written wins: it is written on top
      // the URL holds the search trimmed: "Maria " shown for "Maria" is not a difference
      const shown = key === "q" ? boxes.q.trim() : boxes[key];
      if (shown !== url[key]) moves[key] = url[key];
    }
    return moves;
  }
}
