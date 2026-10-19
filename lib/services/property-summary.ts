/**
 * The property page's summary strip (A08 PR 3): what an agent needs at a
 * glance, under the reference, without opening a tab.
 *
 * The header grew badge by badge. Price was only in the Overview facts,
 * owner and agent only in Parties at the bottom of Overview, the mandate's
 * expiry only on the Mandate tab, and no task on the property was read
 * anywhere. Each cell here is one rule, said in words:
 *
 *   - priceLine — the ONE price expression, shared with the Overview facts;
 *   - availabilityLine — status and visibility as one sentence. The website
 *     carries a listing only when it is Public AND Available (0066's feed:
 *     `visibility = 'public' and status = 'available'`); a Public listing in
 *     any other status is said to be off the website, where the header's
 *     inline note used to say it (2026-09-03, DECISIONS);
 *   - partyLine — the owner, or for a project or phase the developer;
 *   - agentLine — the responsible agent, flagged when the account is inactive;
 *   - nextAction — the earlier of the next open task and the next viewing;
 *   - mandateLine — the active mandate's type and expiry, or why there is none;
 *   - outstandingLine — how many readiness items are open (the list itself is
 *     the readiness panel's, never repeated here).
 *
 * A value that could not be read is said as such — never "none", "not set"
 * or a zero standing in for it.
 *
 * Pure, no I/O. Dates are Cyprus days: formatDate/formatDateTime render in
 * Asia/Nicosia, and `todayKey` is a Cyprus "YYYY-MM-DD" (lib/utils/tz.ts).
 */
import type { Database } from "@/lib/supabase/database.types";
import { formatDate, formatDateTime, formatMoney } from "@/lib/utils/format";

type Enums = Database["public"]["Enums"];

/** How a cell is marked beside its words. The words always carry the meaning. */
export type SummaryTone = "success" | "warning" | "danger" | "neutral";

const STATUS_WORDS: Record<Enums["property_status"], string> = {
  draft: "Draft",
  available: "Available",
  reserved: "Reserved",
  under_offer: "Under offer",
  sold: "Sold",
  rented: "Rented",
  withdrawn: "Withdrawn",
};

const VISIBILITY_WORDS: Record<Enums["visibility_level"], string> = {
  public: "Public",
  private: "Private",
  vip: "VIP",
  partner: "Partner",
  off_market: "Off-market",
  coming_soon: "Coming soon",
  archived: "Archived",
};

const MANDATE_WORDS: Record<Enums["mandate_type"], string> = {
  exclusive: "Exclusive",
  open: "Open",
  verbal: "Verbal",
};

const word = (words: Record<string, string>, value: string): string =>
  words[value] ?? value.replace(/_/g, " ");

/** A project or a phase: a container whose units carry the prices. */
const isContainerKind = (kind: string): boolean => kind === "project" || kind === "phase";

// ---------------------------------------------------------------------------
// Price

export interface PriceFacts {
  kind: string;
  transaction_type: string;
  asking_price: number | string | null;
  rent_price_month: number | string | null;
}

/** A money figure, or null where there is none to show (formatMoney's "—"). */
function money(value: number | string | null): string | null {
  const text = formatMoney(value);
  return text === "—" ? null : text;
}

/**
 * The price, by the transaction: a sale's asking price, a rent's monthly rent,
 * both for a listing offered either way. A container's own figure is a FROM
 * price — its units carry the prices. `text` is null when no figure is set;
 * each place says that in its own words.
 */
export function priceLine(p: PriceFacts): { label: "Price" | "From price"; text: string | null } {
  const label = isContainerKind(p.kind) ? "From price" : "Price";
  const sale = money(p.asking_price);
  const rentFigure = money(p.rent_price_month);
  const rent = rentFigure === null ? null : `${rentFigure}/mo`;
  const parts =
    p.transaction_type === "rent" ? [rent] : p.transaction_type === "sale_or_rent" ? [sale, rent] : [sale];
  const shown = parts.filter((x): x is string => x !== null);
  return { label, text: shown.length > 0 ? shown.join(" · ") : null };
}

// ---------------------------------------------------------------------------
// Availability

/** The website's rule (0066): Public AND Available, both switches. */
export function isOnWebsite(status: string, visibility: string): boolean {
  return visibility === "public" && status === "available";
}

export interface AvailabilityLine {
  tone: SummaryTone;
  text: string;
  /** why a Public listing is still not on the website — null when nothing needs saying */
  note: string | null;
}

/**
 * Status and visibility as one statement. Public and Available are TWO
 * switches and the feed needs both: setting one without the other reads as
 * published and reaches nobody — a real session did exactly that and reported
 * the listing live (2026-09-03). So a Public listing that is not Available is
 * said to be off the website, with the reason.
 */
export function availabilityLine(status: string, visibility: string): AvailabilityLine {
  const s = word(STATUS_WORDS, status);
  if (isOnWebsite(status, visibility)) {
    return { tone: "success", text: "Available · on the website", note: null };
  }
  if (visibility === "public") {
    return {
      tone: "warning",
      text: `${s} · Public, but not on the website`,
      note: "The website only shows listings whose status is Available.",
    };
  }
  if (visibility === "archived") return { tone: "neutral", text: `${s} · archived`, note: null };
  return {
    tone: "neutral",
    text: `${s} · not on the website (${word(VISIBILITY_WORDS, visibility)})`,
    note: null,
  };
}

// ---------------------------------------------------------------------------
// Owner / developer

export interface PartyContact {
  id: string;
  label: string;
}

export interface PartyLine {
  label: "Owner" | "Developer";
  /** the contact to link to, when one is recorded and readable */
  contact: PartyContact | null;
  /** the words when there is no contact to show */
  text: string;
}

/**
 * Who the property belongs to. A project or a phase is described by its
 * developer (its owner when no developer is recorded); a unit by its owner,
 * else the developer, who still owns the units it has not sold; a standalone
 * by its owner. A recorded contact the reader cannot see is said as such —
 * never as "not recorded".
 */
export function partyLine(
  kind: string,
  ids: { owner_contact_id: string | null; developer_contact_id: string | null },
  contacts: ReadonlyMap<string, PartyContact>,
): PartyLine {
  const owner = { label: "Owner" as const, id: ids.owner_contact_id };
  const developer = { label: "Developer" as const, id: ids.developer_contact_id };
  const order = isContainerKind(kind) ? [developer, owner] : kind === "unit" ? [owner, developer] : [owner];
  const recorded = order.find((o) => o.id !== null && o.id !== "");
  if (!recorded) return { label: order[0]!.label, contact: null, text: "Not recorded" };
  const contact = contacts.get(recorded.id!) ?? null;
  return contact
    ? { label: recorded.label, contact, text: contact.label }
    : { label: recorded.label, contact: null, text: "Recorded, but not visible to you" };
}

// ---------------------------------------------------------------------------
// Responsible agent

export interface AgentLine {
  text: string;
  /** the account is deactivated: the property needs a new responsible agent */
  inactive: boolean;
  tone: SummaryTone;
}

/**
 * The assigned agent. The profile read does not filter on is_active (an
 * inactive agent still holds the column), so an inactive one is flagged
 * rather than shown as if responsible.
 */
export function agentLine(
  assignedAgentId: string | null,
  agent: { full_name: string | null; is_active: boolean } | null,
): AgentLine {
  if (!assignedAgentId) return { text: "Not assigned", inactive: false, tone: "neutral" };
  if (!agent) return { text: "Assigned, but not visible to you", inactive: false, tone: "neutral" };
  const name = agent.full_name?.trim() || "Unnamed user";
  return agent.is_active
    ? { text: name, inactive: false, tone: "neutral" }
    : { text: name, inactive: true, tone: "warning" };
}

// ---------------------------------------------------------------------------
// Next action

export interface NextTaskRow {
  id: string;
  title: string;
  due_at: string | null;
}

export interface NextViewingRow {
  id: string;
  scheduled_at: string;
}

export type NextAction =
  | {
      kind: "task";
      /** "Next task" for an admin; "Your next task" for anyone whose read RLS narrows */
      label: string;
      text: string;
      detail: string;
      overdue: boolean;
      task: NextTaskRow;
    }
  | { kind: "viewing"; label: "Next viewing"; text: string; detail: string | null; viewing: NextViewingRow }
  | { kind: "none"; label: null; text: "None"; detail: string | null };

const instant = (iso: string | null): number => (iso ? Date.parse(iso) : Number.NaN);

/**
 * The earlier of the next open task and the next scheduled viewing.
 *
 * The task is the one the caller can SEE: tasks_select shows an admin every
 * task in the organisation and anyone else only the tasks assigned to them or
 * created by them. So for a non-admin it is "Your next task", never "the"
 * next task — and whatever the cell shows (the viewing, or "None") says it was
 * weighed against their tasks only: a colleague's earlier task may exist that
 * RLS hides (A08 review — the qualifier was on "None" alone).
 *
 * Rules: an overdue task (its due moment passed) is the earliest thing there
 * is and says so. A task with no due date is shown only when no viewing is
 * booked — a dated appointment comes first. A task due at the very moment of
 * the viewing is shown (it is the thing to do before it).
 */
export function nextAction({
  task,
  viewing,
  now,
  viewerIsAdmin,
}: {
  task: NextTaskRow | null;
  viewing: NextViewingRow | null;
  now: Date;
  viewerIsAdmin: boolean;
}): NextAction {
  const taskAt = instant(task?.due_at ?? null);
  const viewingAt = viewing ? instant(viewing.scheduled_at) : Number.NaN;
  const pick: "task" | "viewing" | null =
    task && viewing
      ? Number.isFinite(taskAt) && (!Number.isFinite(viewingAt) || taskAt <= viewingAt)
        ? "task"
        : "viewing"
      : task
        ? "task"
        : viewing
          ? "viewing"
          : null;

  if (pick === "task" && task) {
    const overdue = Number.isFinite(taskAt) && taskAt < now.getTime();
    return {
      kind: "task",
      label: viewerIsAdmin ? "Next task" : "Your next task",
      text: task.title,
      detail: !Number.isFinite(taskAt)
        ? "no due date"
        : overdue
          ? `overdue · was due ${formatDate(task.due_at)}`
          : `due ${formatDate(task.due_at)}`,
      overdue,
      task,
    };
  }
  if (pick === "viewing" && viewing) {
    return {
      kind: "viewing",
      label: "Next viewing",
      text: formatDateTime(viewing.scheduled_at),
      detail: viewerIsAdmin ? null : "your tasks only",
      viewing,
    };
  }
  return { kind: "none", label: null, text: "None", detail: viewerIsAdmin ? null : "your tasks only" };
}

// ---------------------------------------------------------------------------
// Mandate

export interface MandateFacts {
  type: string | null;
  status: string | null;
  expiry_date: string | null;
}

/**
 * The active mandate as its type and expiry; without one, whether the last one
 * expired (the badge's "Expired" state) or there never was one. An active
 * mandate past its expiry date — the nightly expiry has not reached it yet —
 * says the date has passed. `todayKey` is the Cyprus day.
 *
 * `complete` says whether the reader sees EVERY mandate on the property.
 * mandates_safe shows an agent only the mandates of properties assigned to
 * them, and those they created (0127, mirroring mandates_select), so for any
 * other agent an empty answer is not "No mandate": it is said as not visible.
 * An active mandate they can see is still described — it is true whatever
 * else is hidden.
 */
export function mandateLine(
  mandates: readonly MandateFacts[],
  todayKey: string,
  { complete = true }: { complete?: boolean } = {},
): { tone: SummaryTone; text: string } {
  const active = mandates.find((m) => m.status === "active");
  if (!active && !complete) return { tone: "neutral", text: "Not visible to you" };
  if (active) {
    const type = active.type ? word(MANDATE_WORDS, active.type) : "Active";
    const tone: SummaryTone = active.type === "exclusive" ? "success" : "warning";
    if (!active.expiry_date) return { tone, text: `${type} · no expiry date` };
    if (active.expiry_date < todayKey) {
      return { tone: "danger", text: `${type} · expiry date ${formatDate(active.expiry_date)} has passed` };
    }
    return { tone, text: `${type} · expires ${formatDate(active.expiry_date)}` };
  }
  const expired = mandates.filter((m) => m.status === "expired");
  if (expired.length > 0) {
    const last = expired
      .map((m) => m.expiry_date)
      .filter((d): d is string => Boolean(d))
      .sort()
      .at(-1);
    return {
      tone: "danger",
      text: last ? `No active mandate · expired ${formatDate(last)}` : "No active mandate · the last one expired",
    };
  }
  return { tone: "neutral", text: "No mandate" };
}

// ---------------------------------------------------------------------------
// Outstanding

/**
 * How many readiness items are open: the criteria missing from the score plus
 * the data warnings. Website essentials are a subset of the missing criteria,
 * so they are not counted twice; when one is missing on a listing that is on
 * the website, the count is marked danger. The items themselves are listed by
 * the readiness panel, which this links to.
 *
 * `mandatesComplete: false` — the reader does not see every mandate
 * (mandates_safe, see mandateLine): a missing "Active mandate" criterion is
 * then NOT KNOWN to be missing, so it is left out of the count and the cell
 * says the mandate is not visible, beside a Mandate cell saying the same —
 * never a count that calls it missing next to one that says it is hidden
 * (A08 review). An active mandate the reader can see is earned, so it is
 * never in `missing` to begin with.
 */
export function outstandingLine(
  quality: {
    missing: readonly { key: string }[];
    warnings: readonly unknown[];
    essentialsMissing: readonly unknown[];
  },
  onWebsite: boolean,
  { mandatesComplete = true }: { mandatesComplete?: boolean } = {},
): { count: number; tone: SummaryTone; text: string; detail: string | null } {
  const mandateHidden = !mandatesComplete && quality.missing.some((m) => m.key === "mandate");
  const hiddenNote = mandateHidden ? "mandate not visible to you" : null;
  const count = quality.missing.length - (mandateHidden ? 1 : 0) + quality.warnings.length;
  if (count === 0) {
    return { count, tone: mandateHidden ? "neutral" : "success", text: "None", detail: hiddenNote };
  }
  const essentials = quality.essentialsMissing.length > 0;
  const detail = [essentials ? "incl. website essentials" : null, hiddenNote].filter((d): d is string => d !== null);
  return {
    count,
    tone: essentials && onWebsite ? "danger" : "warning",
    text: `${count} ${count === 1 ? "item" : "items"}`,
    detail: detail.length > 0 ? detail.join(" · ") : null,
  };
}
