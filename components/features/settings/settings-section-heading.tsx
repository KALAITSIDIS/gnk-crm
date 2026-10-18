"use client";

import { usePathname } from "next/navigation";
import { SETTINGS_SECTIONS } from "@/components/features/settings/settings-nav";

type SectionHref = (typeof SETTINGS_SECTIONS)[number]["href"];

/**
 * Where a section's heading says more than its tab. The Overview tab is the
 * activation-readiness page (A07), and that is what its heading names.
 */
const HEADING_OVERRIDE: Partial<Record<SectionHref, string>> = {
  "/settings": "Activation readiness",
};

/** The heading a settings path opens with, or null off the settings sections. */
export function settingsSectionHeading(pathname: string): string | null {
  // the same match as the tab's aria-current in SettingsNav: exact path
  const section = SETTINGS_SECTIONS.find((s) => s.href === pathname);
  if (!section) return null;
  return HEADING_OVERRIDE[section.href] ?? section.label;
}

/**
 * The `<h2>` each settings section opens with (A08), under the layout's
 * `<h1>Settings</h1>` and the section tabs. Before this, ten of the eleven
 * sections rendered no heading naming the section (only the Overview did) —
 * a screen-reader user jumping by heading landed on "What this does not do",
 * a district or a raw config key.
 *
 * Rendered once, by the settings layout, from the same list the tabs are
 * drawn from, so a section added to SETTINGS_SECTIONS gets its heading
 * without anyone remembering to write one, and a tab and its heading cannot
 * disagree. Headings inside a section are `<h3>` and below.
 */
export function SettingsSectionHeading() {
  const heading = settingsSectionHeading(usePathname());
  if (heading === null) return null;
  return (
    <h2 data-testid="settings-section-heading" className="text-base font-semibold text-text-1">
      {heading}
    </h2>
  );
}
