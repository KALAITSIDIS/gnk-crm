import Link from "next/link";
import {
  buildReadinessRows,
  GROUP_TITLE,
  STATE_LABEL,
  technicalFlags,
  WHO_LABEL,
  type ReadinessFacts,
  type ReadinessGroup,
  type ReadinessRow,
  type ReadinessState,
} from "@/lib/services/activation-readiness";
import type { SenderReadiness } from "@/lib/services/sender-readiness";
import { cn } from "@/lib/utils";

/**
 * Settings → Overview: activation readiness (A07). A server component with no
 * client JavaScript, no form and no button — nothing here can switch anything
 * on. Each row says what is true on THIS deployment, who takes the next step,
 * and links to the page where the setting lives.
 *
 * The pill's WORD carries the state (On, Off, Needs setup outside the CRM, …);
 * the dot's colour only repeats it, and the word is set in body-text colour
 * so it keeps its contrast whatever the tone.
 */

const TONE: Record<ReadinessState, string> = {
  on: "bg-success",
  off: "bg-text-3",
  needs_setup: "bg-warning",
  not_built: "bg-text-3",
  attention: "bg-danger",
  unknown: "bg-warning",
  checking: "bg-brand-500",
};

const GROUP_ORDER: ReadinessGroup[] = ["enquiries", "listings", "branding"];

function Pill({ row }: { row: ReadinessRow }) {
  return (
    <span
      data-testid="readiness-pill"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs font-medium text-text-1"
    >
      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", TONE[row.state])} />
      {row.label ?? STATE_LABEL[row.state]}
    </span>
  );
}

function Row({ row }: { row: ReadinessRow }) {
  return (
    <li
      data-testid={`readiness-${row.id}`}
      data-state={row.state}
      className="flex flex-col gap-1.5 border-t border-border px-4 py-3 first:border-t-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium text-text-1">{row.name}</h4>
        <Pill row={row} />
      </div>
      <p className="text-sm text-text-2">{row.summary}</p>
      {row.nextStep ? (
        <p className="text-xs text-text-2">
          <span className="font-medium text-text-1">Next step — {WHO_LABEL[row.nextStep.who]}:</span> {row.nextStep.text}
        </p>
      ) : null}
      {row.link ? (
        <Link href={row.link.href} className="self-start text-xs font-medium text-brand-700 hover:underline">
          {row.link.text} <span aria-hidden="true">→</span>
        </Link>
      ) : null}
    </li>
  );
}

export function ReadinessOverview({ facts, sender }: { facts: ReadinessFacts; sender: SenderReadiness | null }) {
  const rows = buildReadinessRows(facts, sender);
  const flags = technicalFlags(facts.env);

  return (
    <div data-testid="settings-readiness" className="flex flex-col gap-5">
      {/* the section's <h2> "Activation readiness" is the settings layout's
          (SettingsSectionHeading, A08) — it opens every section the same way */}
      <p className="max-w-3xl text-sm text-text-2">
        What is switched on in this deployment, what waits on a step outside the CRM, and what is not built yet. This page only
        reads: nothing here changes a setting — each row links to the page where it is changed.
      </p>

      {GROUP_ORDER.map((group) => {
        const inGroup = rows.filter((r) => r.group === group);
        return (
          <section key={group} aria-labelledby={`readiness-group-${group}`} className="flex flex-col gap-2">
            <h3 id={`readiness-group-${group}`} className="text-sm font-semibold text-text-1">
              {GROUP_TITLE[group]}
            </h3>
            <ul className="rounded-[10px] border border-border bg-surface">
              {inGroup.map((row) => (
                <Row key={row.id} row={row} />
              ))}
            </ul>
          </section>
        );
      })}

      <section aria-labelledby="readiness-group-system" className="flex flex-col gap-2">
        <h3 id="readiness-group-system" className="text-sm font-semibold text-text-1">
          System
        </h3>
        <div className="rounded-[10px] border border-border bg-surface px-4 py-3 text-sm text-text-2">
          <p>
            The scheduled jobs&rsquo; health is the line at the top of the{" "}
            <Link href="/dashboard" className="font-medium text-brand-700 hover:underline">
              Dashboard
            </Link>
            .
          </p>
          <details data-testid="readiness-technical" className="mt-3">
            <summary className="cursor-pointer text-sm font-medium text-text-1">Technical details — this deployment&rsquo;s environment</summary>
            <p className="mt-2 text-xs text-text-2">
              Names only, never values. Read from this deployment when the page loaded; Vercel binds a variable when it builds, so one
              set since the last deploy reads &ldquo;not set&rdquo; until the next one. Preview and Production deployments differ.
            </p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {flags.map((f) => (
                <li key={f.name} data-testid={`readiness-env-${f.name}`} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
                  <span className="font-mono text-xs break-all text-text-1">{f.name}</span>
                  <span className="text-xs text-text-2">
                    {f.set ? (
                      <>
                        <span className="font-medium text-text-1">set</span>
                        {f.detail ? ` — ${f.detail}` : ""}
                      </>
                    ) : (
                      <>
                        <span className="font-medium text-text-1">not set</span> — {f.whenUnset}
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </section>
    </div>
  );
}
