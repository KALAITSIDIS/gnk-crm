"use client";

import { useState, useTransition } from "react";
import { FileText, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import {
  deletePropertyDocument,
  uploadPropertyDocument,
  type PropertyDocActionState,
} from "@/lib/actions/property-documents";
import {
  DOCUMENT_FILE_HINT,
  DOCUMENT_TOO_LARGE_ADVICE,
  DOCUMENT_UPLOAD_UNCONFIRMED_TEXT,
} from "@/lib/constants/upload";
import { PROPERTY_DOC_TYPES } from "@/lib/validators/documents";
import { DocumentDownloadButton } from "@/components/features/shared/document-download-button";
import { useUploadForm } from "@/components/features/shared/use-upload-form";
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

export interface PropertyDocument {
  id: string;
  title: string;
  doc_type: string;
  created_at: string;
  uploaded_by_name: string | null;
}

const initialState: PropertyDocActionState = { error: null, savedAt: null };

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function DocumentsTab({
  propertyId,
  items,
  isAdmin = false,
}: {
  propertyId: string;
  items: PropertyDocument[];
  isAdmin?: boolean;
}) {
  // size gate before sending, and a lost answer said rather than thrown into
  // the error boundary (T-upload-size-honest — use-upload-form.ts)
  const upload = useUploadForm({
    action: uploadPropertyDocument,
    initialState,
    tooLargeAdvice: DOCUMENT_TOO_LARGE_ADVICE,
    unconfirmedText: DOCUMENT_UPLOAD_UNCONFIRMED_TEXT,
    savedText: "Document uploaded",
  });
  const [isPending, startTransition] = useTransition();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  function handleDelete(id: string, title: string) {
    if (!confirm(`Delete “${title}”? This removes the file permanently.`)) return;
    setDeletingId(id);
    startTransition(async () => {
      const { error } = await deletePropertyDocument(id, propertyId);
      setDeletingId(null);
      if (error) toast.error(error);
      else toast.success("Document deleted");
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={upload.onSubmit}
        className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface-2 p-4 sm:flex-row sm:flex-wrap sm:items-end"
      >
        <input type="hidden" name="property_id" value={propertyId} />
        <div className="flex flex-col gap-2 sm:w-64">
          <Label htmlFor="doc_title">Title</Label>
          <Input id="doc_title" name="title" placeholder="Defaults to the file name" />
        </div>
        <div className="flex flex-col gap-2 sm:w-48">
          <Label htmlFor="property-doc-type">Type</Label>
          <Select name="doc_type" defaultValue="other">
            <SelectTrigger id="property-doc-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROPERTY_DOC_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {labelize(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="doc_file">File ({DOCUMENT_FILE_HINT})</Label>
          <input
            id="doc_file"
            type="file"
            name="file"
            accept="application/pdf,image/jpeg,image/png"
            onChange={upload.onFileChange}
            className="text-sm text-text-2 file:mr-3 file:rounded-lg file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-text-1"
          />
        </div>
        <Button type="submit" disabled={upload.pending} size="sm">
          <Upload className="size-4" /> {upload.pending ? "Uploading…" : "Upload"}
        </Button>
        {upload.error ? (
          <p role="alert" className="w-full text-sm text-danger">
            {upload.error}
          </p>
        ) : null}
      </form>

      {items.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-border py-12 text-center text-sm text-text-3">
          No documents yet — title deeds, permits, plans and contracts live here.
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
