import Link from "next/link";
import type { ReactNode } from "react";
import { TabLink } from "@/components/features/properties/property-tabs";
import { AddTaskDialog } from "@/components/features/tasks/add-task-dialog";
import {
  agentLine,
  availabilityLine,
  isOnWebsite,
  mandateLine,
  nextAction,
  outstandingLine,
  partyLine,
  priceLine,
  type MandateFacts,
  type NextTaskRow,
  type NextViewingRow,
  type PartyContact,
  type SummaryTone,
} from "@/lib/services/property-summary";
import type { QualityScoreResult } from "@/lib/services/quality-score";
import { zonedParts } from "@/lib/utils/tz";
import { cn } from "@/lib/utils";

/**
 * The property page's summary strip (A08 PR 3): price, availability, owner
 * (developer for a project), responsible agent, next action, mandate and how
 * much is outstanding — under the reference, without opening a tab.
 *
 * Read-only except for one control: "Add task", the page's one AddTaskDialog,
 * beside the next action it adds to (it was in the header's action group).
 * Every value comes from a read the page already makes, plus one: the next
 * open task, read through RLS — so a non-admin sees "Your next task", never
 * "the" next task (lib/services/property-summary.ts says the rules).
 *
 * "Outstanding" is a count that links to the readiness panel (F03) below; the
 * items themselves are listed there and nowhere else.
 *
 * A server component, rendered inside PropertyTabs so its Mandate link
 * switches the tab in place. Two columns on a phone, four from lg.
 */

const DOT: Record<SummaryTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-text-3",
};

export interface PropertySummaryFacts {
  id: string;
  reference: string;
  kind: string;
  status: string;
  visibility: string;
  transaction_type: string;
  asking_price: number | null;
  rent_price_month: number | null;
  owner_contact_id: string | null;
  developer_contact_id: string | null;
  assigned_agent_id: string | null;
}

export function PropertySummary({
  property,
  contacts,
  agent,
  nextTask,
  nextViewing,
  mandates,
  mandatesComplete,
  quality,
  viewerIsAdmin,
  now,
}: {
  property: PropertySummaryFacts;
  /** the owner/developer contacts the page read, by id */
  contacts: ReadonlyMap<string, PartyContact>;
  /** the assigned agent's profile — read without an is_active filter; null when none or unreadable */
  agent: { full_name: string | null; is_active: boolean } | null;
  /** the next open task on this property the viewer can see (tasks_select) */
  nextTask: NextTaskRow | null;
  /** the next scheduled viewing from now */
  nextViewing: NextViewingRow | null;
  mandates: readonly MandateFacts[];
  /** whether the viewer sees every mandate on this property (mandates_safe narrows an agent's read) */
  mandatesComplete: boolean;
  quality: Pick<QualityScoreResult, "missing" | "warnings" | "essentialsMissing">;
  viewerIsAdmin: boolean;
  now: Date;
}) {
  const price = priceLine(property);
  const availability = availabilityLine(property.status, property.visibility);
  const party = partyLine(property.kind, property, contacts);
  const responsible = agentLine(property.assigned_agent_id, agent);
  const next = nextAction({ task: nextTask, viewing: nextViewing, now, viewerIsAdmin });
  const mandate = mandateLine(mandates, zonedParts(now).dayKey, { complete: mandatesComplete });
  const outstanding = outstandingLine(quality, isOnWebsite(property.status, property.visibility), {
    mandatesComplete,
  });

  return (
    <section
      aria-labelledby="property-summary-heading"
      data-property-summary=""
      // inside the page's Tabs root (gap-2), like the readiness panel: mb-2 makes the page's gap-4
      className="mb-2 rounded-[10px] border border-border bg-surface px-4 py-3"
    >
      <h2 id="property-summary-heading" className="sr-only">
        Summary
      </h2>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-4">
        <Cell name="price" term={price.label}>
          {price.text ?? <span className="font-normal text-text-3">Not set</span>}
        </Cell>

        <Cell name="availability" term="Availability">
          <Toned tone={availability.tone}>{availability.text}</Toned>
          {availability.note ? (
            <span role="note" className="mt-0.5 block text-xs font-normal text-text-2">
              {availability.note}
            </span>
          ) : null}
        </Cell>

        <Cell name="party" term={party.label}>
          {party.contact ? (
            <Link href={`/contacts/${party.contact.id}`} className="text-brand-700 hover:underline">
              {party.contact.label}
            </Link>
          ) : (
            <span className="font-normal text-text-3">{party.text}</span>
          )}
        </Cell>

        <Cell name="agent" term="Responsible agent">
          {responsible.inactive ? (
            <Toned tone={responsible.tone}>
              {responsible.text} <span className="font-normal text-text-2">· inactive</span>
            </Toned>
          ) : property.assigned_agent_id && agent ? (
            responsible.text
          ) : (
            <span className="font-normal text-text-3">{responsible.text}</span>
          )}
        </Cell>

        <Cell name="next" term="Next action" className="col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="min-w-0">
              {next.kind === "task" ? (
                <>
                  <span className="font-normal text-text-2">{next.label}: </span>
                  {next.text}{" "}
                  <span className={cn("text-xs font-normal", next.overdue ? "text-danger" : "text-text-2")}>
                    · {next.detail}
                  </span>
                </>
              ) : next.kind === "viewing" ? (
                <>
                  <span className="font-normal text-text-2">{next.label}: </span>
                  <Link href={`/viewings/${next.viewing.id}`} className="text-brand-700 hover:underline">
                    {next.text}
                  </Link>
                  {next.detail ? (
                    <span className="text-xs font-normal text-text-2"> · {next.detail}</span>
                  ) : null}
                </>
              ) : (
                <>
                  {next.text}
                  {next.detail ? (
                    <span className="text-xs font-normal text-text-2"> · {next.detail}</span>
                  ) : null}
                </>
              )}
            </p>
            <AddTaskDialog entity={{ property_id: property.id }} entityLabel={property.reference} />
          </div>
        </Cell>

        <Cell name="mandate" term="Mandate">
          <TabLink propertyId={property.id} tab="mandate" className="hover:underline">
            <Toned tone={mandate.tone}>{mandate.text}</Toned>
          </TabLink>
        </Cell>

        <Cell name="outstanding" term="Outstanding">
          {outstanding.count === 0 ? (
            <Toned tone={outstanding.tone}>
              {outstanding.text}
              {outstanding.detail ? (
                <span className="text-xs font-normal text-text-2"> · {outstanding.detail}</span>
              ) : null}
            </Toned>
          ) : (
            <Toned tone={outstanding.tone}>
              {/* a plain in-page anchor: the readiness panel is a section on
                  this page (id + tabIndex -1), so Enter moves focus there */}
              <a href="#listing-readiness" className="text-brand-700 underline underline-offset-2">
                {outstanding.text}
                <span className="sr-only"> — see Listing readiness</span>
              </a>
              {outstanding.detail ? (
                <span className="text-xs font-normal text-text-2"> · {outstanding.detail}</span>
              ) : null}
            </Toned>
          )}
        </Cell>
      </dl>
    </section>
  );
}

/** One term and its value. `data-summary` names the cell for tests. */
function Cell({
  name,
  term,
  className,
  children,
}: {
  name: string;
  term: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0", className)} data-summary={name}>
      <dt className="text-xs text-text-3">{term}</dt>
      <dd className="mt-0.5 break-words text-sm font-medium text-text-1">{children}</dd>
    </div>
  );
}

/** A value with its tone as a dot beside it — the words carry the meaning, the colour only marks it. */
function Toned({ tone, children }: { tone: SummaryTone; children: ReactNode }) {
  return (
    <span className="inline-flex items-start gap-1.5">
      <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[tone])} />
      <span className="min-w-0">{children}</span>
    </span>
  );
}
