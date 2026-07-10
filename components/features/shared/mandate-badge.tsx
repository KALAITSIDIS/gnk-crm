import { cn } from "@/lib/utils";

/**
 * MandateBadge (doc 06): exclusive=green, open=amber, expired=red outline,
 * none=grey dashed.
 */
export type MandateBadgeState = "exclusive" | "open" | "verbal" | "expired" | "none";

const STYLES: Record<MandateBadgeState, { label: string; className: string }> = {
  exclusive: {
    label: "Exclusive",
    className: "border-success/30 bg-success/10 text-success",
  },
  open: {
    label: "Open",
    className: "border-warning/30 bg-warning/10 text-warning",
  },
  verbal: {
    label: "Verbal",
    className: "border-warning/30 bg-warning/10 text-warning",
  },
  expired: {
    label: "Expired",
    className: "border-danger bg-transparent text-danger",
  },
  none: {
    label: "No mandate",
    className: "border-dashed border-border bg-transparent text-text-3",
  },
};

export function MandateBadge({
  state,
  className,
}: {
  state: MandateBadgeState;
  className?: string;
}) {
  const s = STYLES[state];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        s.className,
        className,
      )}
    >
      {s.label}
    </span>
  );
}
