/**
 * The browser tab's name (A08). The root layout's metadata adds the product
 * suffix to every page's own words — "Leads · GN REOS", "PAF0042 · GN REOS" —
 * and `DocumentTitle` (components/features/shared/document-title.tsx) adds the
 * same suffix when a page keeps its tab in step on the client. One template,
 * so the two can never disagree. tests/unit/page-titles.test.ts pins it.
 */
export const TITLE_TEMPLATE = "%s · GN REOS";

/** The tab of a page with no title of its own. */
export const DEFAULT_TITLE = "GN Real Estate OS";

/**
 * A page's own words through the template: "Properties · Land" → "Properties ·
 * Land · GN REOS". A replacer FUNCTION, not a string: a string replacement
 * reads `$&`, `$'` and `` $` `` in the words as patterns.
 */
export function templatedTitle(words: string): string {
  return TITLE_TEMPLATE.replace("%s", () => words);
}
