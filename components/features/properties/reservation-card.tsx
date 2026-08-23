"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import { CalendarClock, Plus, X } from "lucide-react";
import { ActionSectionForm } from "@/components/features/shared/action-section-form";
import { EntityPicker } from "@/components/features/shared/entity-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  createReservation,
  extendReservation,
  transitionReservation,
} from "@/lib/actions/reservations";
import {
  RESERVATION_TRANSITIONS,
  isLiveReservation,
  type ReservationStatus,
} from "@/lib/validators/reservations";
import { cn } from "@/lib/utils";
import { formatDateTime, formatMoney } from "@/lib/utils/format";

/**
 * Reservations on the property page (0044, T-C3).
 *
 * At most one live hold is shown, because at most one can exist — the partial
 * unique index says so. Everything else is history, and history is kept: an
 * expired hold is evidence that the property WAS held, which is what a dispute
 * needs.
 */

export interface ReservationRow {
  id: string;
  status: ReservationStatus;
  amount: number | null;
  held_from: string;
  expires_at: string;
  released_at: string | null;
  release_reason: string | null;
  notes: string | null;
  contact_id: string | null;
  contact_name: string | null;
}

const STATUS_TONE: Record<ReservationStatus, string> = {
  held: "bg-warning/10 text-warning border-warning/30",
  confirmed: "bg-success/10 text-success border-success/30",
  expired: "bg-surface-2 text-text-3 border-border",
  released: "bg-surface-2 text-text-3 border-border",
  converted: "bg-brand-700/10 text-brand-700 border-brand-700/30",
};

const STATUS_LABEL: Record<ReservationStatus, string> = {
  held: "Held",
  confirmed: "Confirmed",
  expired: "Expired",
  released: "Released",
  converted: "Converted to sale",
};

function StatusPill({ status }: { status: ReservationStatus }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium",
        STATUS_TONE[status],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/**
 * Days left, in whole days, from the viewer's clock.
 *
 * Rendered client-side only. A server-rendered "2 days left" would disagree
 * with the client on hydration the moment the request straddles a boundary —
 * the ResponseClock lesson in ENGINEERING_NOTES. The expiry TIMESTAMP is
 * server-rendered and authoritative; this is the friendly gloss on it.
 */
function DaysLeft({ expiresAt }: { expiresAt: string }) {
  // Same shape as ResponseClock: the value is derived during RENDER from a
  // `now` in state, and the interval only ever moves `now`. Computing it inside
  // the effect instead would be a setState directly in an effect, which the
  // lint rule rejects and which paints an empty span on the first frame.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const ms = new Date(expiresAt).getTime() - now;
  let text: string;
  if (ms <= 0) {
    text = "lapsed — the nightly sweep will close it";
  } else {
    const days = Math.floor(ms / 86_400_000);
    if (days >= 1) {
      text = `${days} day${days === 1 ? "" : "s"} left`;
    } else {
      const hours = Math.max(1, Math.floor(ms / 3_600_000));
      text = `${hours} hour${hours === 1 ? "" : "s"} left`;
    }
  }

  // Wall-clock relative, so the server's render and the client's hydration
  // never match exactly. This is the one case suppressHydrationWarning is for —
  // the SSR value paints, hydration accepts the fresher client value, and the
  // interval keeps it live (ENGINEERING_NOTES, and ResponseClock does the same).
  return (
    <span suppressHydrationWarning className="text-text-2">
      {text}
    </span>
  );
}

/** One transition button. Its own action state so a refusal is visible. */
function TransitionButton({
  reservationId,
  to,
  label,
  variant = "outline",
  needsReason = false,
}: {
  reservationId: string;
  to: ReservationStatus;
  label: string;
  variant?: "outline" | "ghost";
  needsReason?: boolean;
}) {
  const [state, formAction, pending] = useActionState(transitionReservation, {
    error: null,
    savedAt: null,
  });
  useEffect(() => {
    if (state.error) toast.error(state.error);
  }, [state.error]);

  return (
    <form action={formAction} className="flex items-end gap-2">
      <input type="hidden" name="reservation_id" value={reservationId} />
      <input type="hidden" name="to" value={to} />
      {needsReason ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`reason-${reservationId}`} className="text-xs">
            Reason
          </Label>
          <Input
            id={`reason-${reservationId}`}
            name="release_reason"
            maxLength={300}
            placeholder="Buyer withdrew"
            className="h-9 w-48"
          />
        </div>
      ) : null}
      <Button type="submit" variant={variant} size="sm" disabled={pending}>
        {pending ? "…" : label}
      </Button>
    </form>
  );
}

function ExtendForm({ reservationId }: { reservationId: string }) {
  const [state, formAction, pending] = useActionState(extendReservation, {
    error: null,
    savedAt: null,
  });
  useEffect(() => {
    if (state.error) toast.error(state.error);
    if (state.savedAt) toast.success("Hold extended");
  }, [state.error, state.savedAt]);

  return (
    <form action={formAction} className="flex items-end gap-2">
      <input type="hidden" name="reservation_id" value={reservationId} />
      <div className="flex flex-col gap-1">
        <Label htmlFor={`extend-${reservationId}`} className="text-xs">
          Extend to
        </Label>
        <Input
          id={`extend-${reservationId}`}
          name="expires_on"
          type="date"
          required
          className="h-9"
        />
      </div>
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "…" : "Extend"}
      </Button>
    </form>
  );
}

export function ReservationCard({
  propertyId,
  reservations,
  canReserve,
  readOnlyHint,
  isContainer = false,
}: {
  propertyId: string;
  reservations: ReservationRow[];
  canReserve: boolean;
  readOnlyHint?: string;
  /** a project or phase — its units are what get held */
  isContainer?: boolean;
}) {
  const [taking, setTaking] = useState(false);

  if (isContainer) {
    return (
      <p className="text-sm text-text-2">
        A project or phase is not reserved directly — open one of its units instead.
      </p>
    );
  }

  const live = reservations.find((r) => isLiveReservation(r.status)) ?? null;
  const past = reservations.filter((r) => !isLiveReservation(r.status));

  return (
    <div className="flex flex-col gap-4">
      {live ? (
        <div className="rounded-[10px] border border-border bg-surface p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill status={live.status} />
                <span className="text-sm font-medium text-text-1">
                  {live.contact_name ?? "No buyer linked"}
                </span>
                {live.amount !== null ? (
                  <span className="text-sm text-text-2">· {formatMoney(live.amount)} deposit</span>
                ) : null}
              </div>
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-text-2">
                <CalendarClock className="size-3.5" />
                {/* the timestamp is authoritative and server-rendered; the
                    countdown beside it is the client-side gloss */}
                Until {formatDateTime(live.expires_at)} · <DaysLeft expiresAt={live.expires_at} />
              </p>
              {live.notes ? <p className="mt-1 text-xs text-text-3">{live.notes}</p> : null}
            </div>
          </div>

          {canReserve ? (
            <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-3">
              {RESERVATION_TRANSITIONS[live.status].includes("confirmed") ? (
                <TransitionButton
                  reservationId={live.id}
                  to="confirmed"
                  label="Confirm"
                  variant="outline"
                />
              ) : null}
              <ExtendForm reservationId={live.id} />
              <TransitionButton
                reservationId={live.id}
                to="converted"
                label="Converted to sale"
                variant="ghost"
              />
              <TransitionButton
                reservationId={live.id}
                to="released"
                label="Release"
                variant="ghost"
                needsReason
              />
            </div>
          ) : (
            <p className="mt-3 text-xs text-text-3">{readOnlyHint}</p>
          )}
        </div>
      ) : (
        <p className="text-sm text-text-2">
          No live hold on this property.
          {canReserve ? " Take one to stop it being sold twice." : ""}
        </p>
      )}

      {canReserve && !live ? (
        taking ? (
          <div className="rounded-[10px] border border-border bg-surface p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium text-text-1">Take a hold</p>
              <Button variant="ghost" size="sm" onClick={() => setTaking(false)}>
                <X className="size-4" /> Cancel
              </Button>
            </div>
            <ActionSectionForm
              action={createReservation}
              hidden={{ property_id: propertyId }}
              submitLabel="Hold it"
            >
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="sm:col-span-2">
                  <EntityPicker
                    name="contact_id"
                    kind="contact"
                    label="Buyer"
                    contactTypes={["buyer", "investor"]}
                    hint="Optional — but a hold nobody is named on is hard to defend later."
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="res-amount">Deposit (€)</Label>
                  <Input id="res-amount" name="amount" type="number" min="0" />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="res-expires">Hold until</Label>
                  <Input id="res-expires" name="expires_on" type="date" required />
                  <p className="text-xs text-text-3">Lapses at the end of that day, Cyprus time.</p>
                </div>
                <div className="flex flex-col gap-2 sm:col-span-3">
                  <Label htmlFor="res-notes">Notes</Label>
                  <Textarea id="res-notes" name="notes" rows={2} />
                </div>
              </div>
            </ActionSectionForm>
          </div>
        ) : (
          <div>
            <Button variant="outline" onClick={() => setTaking(true)}>
              <Plus className="size-4" /> Take a hold
            </Button>
          </div>
        )
      ) : null}

      {past.length > 0 ? (
        <details className="rounded-[10px] border border-border bg-surface-2/40 p-4">
          <summary className="cursor-pointer text-sm text-text-2">
            Earlier holds ({past.length})
          </summary>
          <ul className="mt-3 flex flex-col gap-2">
            {past.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm text-text-2">
                <StatusPill status={r.status} />
                <span>{r.contact_name ?? "no buyer linked"}</span>
                <span className="text-text-3">
                  · held {formatDateTime(r.held_from)} → {formatDateTime(r.expires_at)}
                </span>
                {r.release_reason ? (
                  <span className="text-text-3">· {r.release_reason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
