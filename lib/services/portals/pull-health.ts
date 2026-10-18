import type { PullOutcome, PullReason } from "./pull-note";
import type { PortalDefinition } from "./registry";

/**
 * What Settings → Portals says about a connection's pulls (0150's
 * last_pull_* columns), in the desk's words.
 *
 * WHAT A "REQUEST" PROVES. The route records every request that carries the
 * valid token — the portal's crawler, but equally an admin pasting the URL
 * into a browser or a validator. So the wording is "the feed URL was last
 * requested", never "the portal pulled", and a fresh request cannot prove the
 * portal is alive; a STALE one (no request for three of the portal's stated
 * intervals) does prove nothing is asking.
 *
 * WHAT IT NEVER CLAIMS: that the portal accepted or published anything. No
 * portal reports back to the CRM, so publication is "not verified" and the
 * page says where to look instead (registry publicationCheck).
 */

export const PULL_REASON_TEXT: Record<PullReason, string> = {
  connection_malformed: "the database answered the connection lookup in an unexpected shape",
  supplement_failed: "the selected listings could not be read",
  supplement_malformed: "the selected listings came back in an unexpected shape",
  supplement_incomplete: "fewer selected listings came back than are selected",
  selection_too_large: "more listings are selected than one feed can carry (2,500)",
  settings_invalid: "the portal's saved contact settings are not valid — save them again",
  listings_failed: "the website's listings could not be read",
  listings_incomplete: "the website's listings did not include any of the selected ones",
  truncated: "the website's listings could not be read to the end",
  render_failed: "the feed could not be written",
};

export interface PullFacts {
  enabled: boolean;
  hasToken: boolean;
  lastPulledAt: string | null;
  lastPulledUa: string | null;
  lastPullCount: number | null;
  lastPullOutcome: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorReason: string | null;
}

export type PullTone = "ok" | "warn" | "error" | "muted";

export interface PullHealth {
  tone: PullTone;
  /** one sentence; times are ISO strings the card formats */
  headline: string;
  /** set when the feed URL has gone unrequested for longer than the portal's schedule allows */
  staleHours: number | null;
}

function reasonWords(code: string | null): string {
  return code && Object.hasOwn(PULL_REASON_TEXT, code) ? PULL_REASON_TEXT[code as PullReason] : "a fault";
}

/**
 * The connection's state in one sentence. `selected` is how many listings are
 * selected for the portal (stale detection only matters when there are some).
 */
export function pullHealth(def: Pick<PortalDefinition, "staleAfterHours">, f: PullFacts, selected: number, now: Date): PullHealth {
  if (!f.enabled) {
    return {
      tone: "muted",
      headline: "Disabled — the feed URL answers an empty document, which tells a portal to remove what it was offered.",
      staleHours: null,
    };
  }
  if (!f.hasToken) return { tone: "warn", headline: "No feed URL yet — regenerate to issue one.", staleHours: null };
  if (!f.lastPulledAt) {
    return {
      tone: selected > 0 ? "warn" : "muted",
      headline: "The feed URL has never been requested. If the portal has it, check it was copied in full.",
      staleHours: null,
    };
  }
  const outcome = f.lastPullOutcome as PullOutcome | null;
  if (outcome === "failed") {
    return {
      tone: "error",
      headline: `The last request was refused (503): ${reasonWords(f.lastErrorReason)}. A portal keeps its previous copy while the feed fails.`,
      staleHours: null,
    };
  }
  const hours = (now.getTime() - Date.parse(f.lastPulledAt)) / 3_600_000;
  if (def.staleAfterHours != null && selected > 0 && hours > def.staleAfterHours) {
    return {
      tone: "warn",
      headline: `No request for ${Math.floor(hours)} hours — this portal should ask far more often. Check it still has the URL.`,
      staleHours: Math.floor(hours),
    };
  }
  return {
    tone: "ok",
    headline: `Last request served ${f.lastPullCount ?? 0} listing${f.lastPullCount === 1 ? "" : "s"}.`,
    staleHours: null,
  };
}

/** One run of the history (0150 portal_pull_log), worded. */
export function pullRunText(run: { outcome: string; served: number | null; selected: number | null; excluded: number | null; reason: string | null }): string {
  if (run.outcome === "disabled") return "Disabled — answered the empty document";
  if (run.outcome === "failed") return `Refused (503): ${reasonWords(run.reason)}`;
  const served = run.served ?? 0;
  const parts = [`Served ${served} listing${served === 1 ? "" : "s"}`];
  if (run.selected != null) parts.push(`of ${run.selected} selected on the website`);
  if (run.excluded) parts.push(`(${run.excluded} excluded by its requirements)`);
  return parts.join(" ");
}
