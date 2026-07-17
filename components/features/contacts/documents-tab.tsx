"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { FileText, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import {
  deleteContactDocument,
  uploadContactDocument,
  type ContactDocActionState,
} from "@/lib/actions/contact-documents";
import { CONTACT_DOC_TYPES } from "@/lib/validators/documents";
import { DocumentDownloadButton } from "@/components/features/shared/document-download-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateTime } from "@/lib/utils/format";

export interface ContactDocument {
  id: string;
  title: string;
  doc_type: string;
  created_at: string;
  uploaded_by_name: string | null;
}

const initialState: ContactDocActionState = { error: null, savedAt: null };

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function ContactDocumentsTab({
  contactId,
  items,
  isAdmin = false,
  canUpload = true,
}: {
  contactId: string;
  items: ContactDocument[];
  isAdmin?: boolean;
  canUpload?: boolean;
}) {
  const [state, formAction, uploading] = useActionState(uploadContactDocument, initialState);
  const [isPending, startTransition] = useTransition();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Document uploaded");
      formRef.current?.reset();
    }
  }, [state.savedAt]);

  function handleDelete(id: string, title: string) {
    if (!confirm(`Delete “${title}”? This removes the file permanently.`)) return;
    setDeletingId(id);
    startTransition(async () => {
      const { error } = await deleteContactDocument(id, contactId);
      setDeletingId(null);
      if (error) toast.error(error);
      else toast.success("Document deleted");
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {canUpload ? (
        <form
          ref={formRef}
          action={formAction}
          className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface-2 p-4 sm:flex-row sm:flex-wrap sm:items-end"
        >
          <input type="hidden" name="contact_id" value={contactId} />
          <div className="flex flex-col gap-2 sm:w-64">
            <Label htmlFor="doc_title">Title</Label>
            <Input id="doc_title" name="title" placeholder="Defaults to the file name" />
          </div>
          <div className="flex flex-col gap-2 sm:w-48">
            <Label>Type</Label>
            <Select name="doc_type" defaultValue="other">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTACT_DOC_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {labelize(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="doc_file">File (PDF, JPG, PNG · ≤ 15 MB)</Label>
            <input
              id="doc_file"
              type="file"
              name="file"
              accept="application/pdf,image/jpeg,image/png"
              className="text-sm text-text-2 file:mr-3 file:rounded-lg file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-text-1"
            />
          </div>
          <Button type="submit" disabled={uploading} size="sm">
            <Upload className="size-4" /> {uploading ? "Uploading…" : "Upload"}
          </Button>
          {state.error ? (
            <p role="alert" className="w-full text-sm text-danger">
              {state.error}
            </p>
          ) : null}
        </form>
      ) : null}

      {items.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-border py-12 text-center text-sm text-text-3">
          No documents yet — passports, proof of address and source-of-funds papers live here.
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">
          {items.map((doc) => (
            <li key={doc.id} className="flex items-center justify-between gap-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <FileText className="size-4 shrink-0 text-text-3" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text-1">{doc.title}</p>
                  <p className="text-xs text-text-3">
                    {labelize(doc.doc_type)} · {formatDateTime(doc.created_at)}
                    {doc.uploaded_by_name ? ` · ${doc.uploaded_by_name}` : ""}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <DocumentDownloadButton documentId={doc.id} label="Download" />
                {isAdmin ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 text-danger"
                    disabled={isPending && deletingId === doc.id}
                    onClick={() => handleDelete(doc.id, doc.title)}
                    title="Delete document"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
