"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import {
  isPropertiesListPath,
  PROPERTIES_LIST_CONTEXT_KEY,
} from "@/lib/constants/list-context";
import { cn } from "@/lib/utils";

/** Where "Properties" goes when nothing (or nothing trustworthy) was remembered. */
export const BARE_PROPERTIES_LIST = "/properties";

/**
 * The list view this tab last settled on (A03 writes it, lib/constants/
 * list-context.ts), or the bare list. Only a value `isPropertiesListPath`
 * accepts is ever followed — anything else in the slot, a storage that throws
 * (a privacy mode, a blocked origin) or no storage at all falls back.
 */
export function rememberedListHref(storage: Pick<Storage, "getItem"> | null | undefined): string {
  try {
    const value = storage?.getItem(PROPERTIES_LIST_CONTEXT_KEY);
    return isPropertiesListPath(value) ? value : BARE_PROPERTIES_LIST;
  } catch {
    return BARE_PROPERTIES_LIST;
  }
}

/*
 * Read as what it is: a value the BROWSER holds and the server cannot know.
 * `useSyncExternalStore` renders the bare list on the server and during
 * hydration, so the two first renders agree, and the remembered view after it
 * — the portal-card.tsx idiom (an effect that set state on mount is refused by
 * the React Compiler lint). The slot is per tab and nothing here changes it,
 * so there is nothing to subscribe to.
 */
const subscribeToNothing = () => () => {};
const readRemembered = () => {
  try {
    return rememberedListHref(window.sessionStorage);
  } catch {
    // reading `window.sessionStorage` itself throws where storage is blocked
    return BARE_PROPERTIES_LIST;
  }
};
const serverHref = () => BARE_PROPERTIES_LIST;

/**
 * The breadcrumb's first crumb: back to the properties list AS IT WAS LEFT —
 * its view, page and filters — rather than the bare list (review 2026-10-18,
 * A05 with A03). A real link, so a middle-click or "open in new tab" works.
 */
export function BackToListLink({ className }: { className?: string }) {
  const href = useSyncExternalStore(subscribeToNothing, readRemembered, serverHref);
  return (
    <Link href={href} className={cn("text-text-2 hover:text-brand-700 hover:underline", className)}>
      Properties
    </Link>
  );
}
