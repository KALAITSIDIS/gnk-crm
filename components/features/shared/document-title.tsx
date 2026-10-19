"use client";

import { useEffect } from "react";
import { templatedTitle } from "@/lib/constants/page-title";

/**
 * Keeps the browser tab's name in step with a page whose title depends on its
 * search params (the properties list and map, A03/A08).
 *
 * `generateMetadata` names the view on a full load, but Next 16.3 does not
 * re-apply the title when a client-side navigation changes only the search
 * params of the same route: a filter change (`router.replace`), a sort header
 * (`<Link>`) and Back all left the tab on the name it loaded with (measured
 * 2026-10-19 on `next start`: "Properties · GN REOS" after sorting by price,
 * while a reload said "Properties · sorted by asking price ↑ · GN REOS").
 * A navigation to another route does update it.
 *
 * So the page renders this with the SAME words its generateMetadata returns,
 * and the effect writes them through the root layout's template on every
 * render that changes them. On a full load the value is already there and the
 * write is a no-op.
 */
export function DocumentTitle({ words }: { words: string }) {
  useEffect(() => {
    const title = templatedTitle(words);
    if (document.title !== title) document.title = title;
  }, [words]);
  return null;
}
