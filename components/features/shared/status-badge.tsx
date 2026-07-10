import { cn } from "@/lib/utils";

/**
 * StatusBadge (doc 06): colored dot + label. Every enum maps from this one
 * config object — add new enums here, never inline colors in pages.
 */

type Tone = "success" | "warning" | "danger" | "info" | "neutral";

const TONE_CLASSES: Record<Tone, { dot: string; text: string }> = {
  success: { dot: "bg-success", text: "text-success" },
  warning: { dot: "bg-warning", text: "text-warning" },
  danger: { dot: "bg-danger", text: "text-danger" },
  info: { dot: "bg-brand-500", text: "text-brand-700" },
  neutral: { dot: "bg-text-3", text: "text-text-2" },
};

const STATUS_CONFIG: Record<string, { label: string; tone: Tone }> = {
  // property_status
  draft: { label: "Draft", tone: "neutral" },
  available: { label: "Available", tone: "success" },
  reserved: { label: "Reserved", tone: "warning" },
  under_offer: { label: "Under offer", tone: "warning" },
  sold: { label: "Sold", tone: "info" },
  rented: { label: "Rented", tone: "info" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
  // visibility_level
  public: { label: "Public", tone: "success" },
  private: { label: "Private", tone: "neutral" },
  vip: { label: "VIP", tone: "warning" },
  partner: { label: "Partner", tone: "info" },
  off_market: { label: "Off-market", tone: "danger" },
  coming_soon: { label: "Coming soon", tone: "info" },
  archived: { label: "Archived", tone: "neutral" },
  // mandate_status
  active: { label: "Active", tone: "success" },
  expired: { label: "Expired", tone: "danger" },
  terminated: { label: "Terminated", tone: "neutral" },
  // lead_status
  new: { label: "New", tone: "info" },
  contacted: { label: "Contacted", tone: "warning" },
  qualified: { label: "Qualified", tone: "success" },
  converted: { label: "Converted", tone: "success" },
  lost: { label: "Lost", tone: "neutral" },
  spam: { label: "Spam", tone: "danger" },
  // viewing_status
  scheduled: { label: "Scheduled", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  no_show: { label: "No-show", tone: "danger" },
  // offer_status
  submitted: { label: "Submitted", tone: "info" },
  countered: { label: "Countered", tone: "warning" },
  accepted: { label: "Accepted", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  // deal_status
  open: { label: "Open", tone: "info" },
  won: { label: "Won", tone: "success" },
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const config = STATUS_CONFIG[status] ?? { label: status, tone: "neutral" as Tone };
  const tone = TONE_CLASSES[config.tone];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[13px]", tone.text, className)}>
      <span className={cn("size-2 shrink-0 rounded-full", tone.dot)} />
      {config.label}
    </span>
  );
}
