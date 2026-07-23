"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { FileText, Pencil, Plus, Upload } from "lucide-react";
import { toast } from "sonner";
import { EntityPicker } from "@/components/features/shared/entity-picker";
import { getDocumentDownloadUrl } from "@/lib/actions/documents";
import {
  saveMandate,
  setMandateStatus,
  uploadMandateDocument,
  type MandateActionState,
} from "@/lib/actions/mandates";
import type { EntityOption } from "@/lib/actions/entity-search";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { MANDATE_TYPES, type MandateStatus, type MandateType } from "@/lib/validators/mandates";
import { formatDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

/** Row shape from mandates_safe — commission fields are null when masked. */
export interface MandateRow {
  id: string;
  type: MandateType;
  status: MandateStatus;
  commission_pct: number | string | null;
  commission_notes: string | null;
  start_date: string;
  expiry_date: string | null;
  renewal_reminder_days: number;
  notes: string | null;
  signed_document_id: string | null;
  owner: EntityOption | null;
}

const STATUS_TONES: Record<MandateStatus, string> = {
  draft: "bg-surface-2 text-text-2",
  active: "bg-success/10 text-success",
  expired: "bg-danger/10 text-danger",
  terminated: "bg-surface-2 text-text-3 line-through",
};

const initialState: MandateActionState = { error: null, savedAt: null };

function MandateDialog({
  propertyId,
  mandate,
  open,
  onOpenChange,
}: {
  propertyId: string;
  mandate: MandateRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, formAction, pending] = useActionState(saveMandate, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Mandate saved");
      onOpenChange(false);
    }
  }, [state.savedAt, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{mandate ? "Edit mandate" : "New mandate"}</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="property_id" value={propertyId} />
          {mandate ? <input type="hidden" name="mandate_id" value={mandate.id} /> : null}

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="mandate-type">Type</Label>
              <Select name="type" defaultValue={mandate?.type ?? "open"}>
                <SelectTrigger id="mandate-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MANDATE_TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="capitalize">
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="m-commission">Commission %</Label>
              <Input
                id="m-commission"
                name="commission_pct"
                type="number"
                step="0.1"
                min="0"
                max="100"
                defaultValue={mandate?.commission_pct ?? ""}
              />
            </div>
          </div>

          <EntityPicker
            name="owner_contact_id"
            kind="contact"
            label="Owner contact"
            initial={mandate?.owner ?? null}
            placeholder="Search owner…"
          />

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="m-start">Start</Label>
              <Input
                id="m-start"
                name="start_date"
                type="date"
                defaultValue={mandate?.start_date ?? ""}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="m-expiry">Expiry</Label>
              <Input
                id="m-expiry"
                name="expiry_date"
                type="date"
                defaultValue={mandate?.expiry_date ?? ""}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="m-reminder">Renewal reminder (days before expiry)</Label>
            <Input
              id="m-reminder"
              name="renewal_reminder_days"
              type="number"
              min="1"
              max="365"
              defaultValue={mandate?.renewal_reminder_days ?? 30}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="m-comm-notes">Commission notes</Label>
            <Textarea
              id="m-comm-notes"
              name="commission_notes"
              rows={2}
              defaultValue={mandate?.commission_notes ?? ""}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="m-notes">Notes</Label>
            <Textarea id="m-notes" name="notes" rows={2} defaultValue={mandate?.notes ?? ""} />
          </div>

          {state.error ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save mandate"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UploadDialog({
  mandateId,
  open,
  onOpenChange,
}: {
  mandateId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, formAction, pending] = useActionState(uploadMandateDocument, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Document uploaded");
      onOpenChange(false);
    }
  }, [state.savedAt, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Upload signed mandate</DialogTitle>
        </DialogHeader>
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="mandate_id" value={mandateId} />
          <Input name="file" type="file" accept="application/pdf,image/jpeg,image/png" required />
          <p className="text-xs text-text-3">PDF, JPG or PNG · up to 15 MB · private bucket.</p>
          {state.error ? (
            <p role="alert" className="text-sm text-danger">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending}>
            {pending ? "Uploading…" : "Upload"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MandateCard({
  m,
  propertyId,
  isAdmin,
}: {
  m: MandateRow;
  propertyId: string;
  isAdmin: boolean;
}) {
  const [pending, start] = useTransition();
  const [editOpen, setEditOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [docBusy, setDocBusy] = useState(false);

  const changeStatus = (next: MandateStatus, done: string) =>
    start(async () => {
      const { error } = await setMandateStatus(m.id, next);
      if (error) toast.error(error);
      else toast.success(done);
    });

  const openDocument = async () => {
    if (!m.signed_document_id) return;
    setDocBusy(true);
    const { url, error } = await getDocumentDownloadUrl(m.signed_document_id);
    setDocBusy(false);
    if (url) window.open(url, "_blank", "noopener");
    else toast.error(error ?? "Could not open the document");
  };

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold capitalize text-text-1">{m.type} mandate</span>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-medium capitalize",
            STATUS_TONES[m.status],
          )}
        >
          {m.status}
        </span>
        <span className="ml-auto text-sm tabular-nums text-text-2">
          {m.commission_pct !== null ? `${Number(m.commission_pct)}%` : "—"}
          <span className="ml-1 text-xs text-text-3">commission</span>
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-text-3">Start</dt>
          <dd className="text-text-1">{formatDate(m.start_date)}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-3">Expiry</dt>
          <dd className="text-text-1">{m.expiry_date ? formatDate(m.expiry_date) : "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-text-3">Reminder</dt>
          <dd className="text-text-1">{m.renewal_reminder_days}d before</dd>
        </div>
        <div>
          <dt className="text-xs text-text-3">Owner</dt>
          <dd className="truncate text-text-1">{m.owner?.label ?? "—"}</dd>
        </div>
      </dl>

      {m.commission_notes ? (
        <p className="text-xs text-text-3">Commission: {m.commission_notes}</p>
      ) : null}
      {m.notes ? <p className="text-xs text-text-3">{m.notes}</p> : null}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {m.signed_document_id ? (
          <Button size="sm" variant="outline" disabled={docBusy} onClick={openDocument}>
            <FileText className="size-4" /> {docBusy ? "Opening…" : "Signed document"}
          </Button>
        ) : null}
        {isAdmin ? (
          <>
            {m.status === "draft" ? (
              <Button
                size="sm"
                disabled={pending}
                onClick={() => changeStatus("active", "Mandate activated")}
              >
                Activate
              </Button>
            ) : null}
            {m.status === "draft" || m.status === "active" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => changeStatus("terminated", "Mandate terminated")}
              >
                Terminate
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => setEditOpen(true)}>
              <Pencil className="size-4" /> Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setUploadOpen(true)}>
              <Upload className="size-4" /> {m.signed_document_id ? "Replace doc" : "Upload doc"}
            </Button>
          </>
        ) : null}
      </div>

      <MandateDialog
        propertyId={propertyId}
        mandate={m}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      <UploadDialog mandateId={m.id} open={uploadOpen} onOpenChange={setUploadOpen} />
    </div>
  );
}

export function MandatePanel({
  propertyId,
  mandates,
  isAdmin,
}: {
  propertyId: string;
  mandates: MandateRow[];
  isAdmin: boolean;
}) {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-text-1">Mandates</h3>
        {isAdmin ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> Add mandate
          </Button>
        ) : null}
      </div>

      {mandates.length === 0 ? (
        <p className="text-sm text-text-3">No mandate recorded for this property.</p>
      ) : (
        mandates.map((m) => (
          <MandateCard key={m.id} m={m} propertyId={propertyId} isAdmin={isAdmin} />
        ))
      )}

      <MandateDialog
        propertyId={propertyId}
        mandate={null}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
    </div>
  );
}
