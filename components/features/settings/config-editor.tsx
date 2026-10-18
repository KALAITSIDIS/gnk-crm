"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { saveCyprusConfig, type SettingsActionState } from "@/lib/actions/settings";
import { configLabel } from "@/components/features/settings/config-labels";
import { TechnicalDetails } from "@/components/features/shared/technical-details";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface ConfigRow {
  key: string;
  valueJson: string;
  description: string | null;
  verifiedAt: string | null;
  sourceNote: string | null;
}

const initialState: SettingsActionState = {
  error: null,
  savedAt: null,
  tempPassword: null,
  invitedEmail: null,
  notice: null,
};

/**
 * One `cyprus_config` row: a plain heading and what the row is for (A08,
 * config-labels.ts), then the raw JSON editor — the admin's escape hatch,
 * deliberately kept. The key and the stored description, which documents the
 * JSON's fields, sit under "Technical details". A key with no label is
 * headed by the key itself, with its description, as before.
 */
export function ConfigCard({ row }: { row: ConfigRow }) {
  const [state, formAction, pending] = useActionState(saveCyprusConfig, initialState);
  const last = useRef<number | null>(null);
  const label = configLabel(row.key);
  const name = label?.title ?? row.key;

  useEffect(() => {
    if (state.savedAt && state.savedAt !== last.current) {
      last.current = state.savedAt;
      toast.success(`${name} saved`);
    }
  }, [state.savedAt, name]);

  return (
    <section className="rounded-[10px] border border-border bg-surface p-5">
      {/* h3: the section's <h2> is the settings layout's (A08) */}
      {label ? (
        <>
          <h3 className="text-sm font-semibold text-text-1">{label.title}</h3>
          <p className="mt-1 text-xs text-text-2">
            {label.summary}
            {label.editOn ? (
              <>
                {" "}
                Easier to change on{" "}
                <Link href={label.editOn.href} className="font-medium text-brand-700 hover:underline">
                  Settings → {label.editOn.label}
                </Link>
                .
              </>
            ) : null}
          </p>
          <TechnicalDetails className="mt-2">
            <span className="block">key {row.key}</span>
            {row.description ? <span className="block">{row.description}</span> : null}
          </TechnicalDetails>
        </>
      ) : (
        <>
          <h3 className="font-mono text-sm font-semibold text-text-1">{row.key}</h3>
          {row.description ? <p className="mt-1 text-xs text-text-3">{row.description}</p> : null}
        </>
      )}

      <form action={formAction} className="mt-3 flex flex-col gap-3">
        <input type="hidden" name="key" value={row.key} />
        {/* the <h3> above names the card, but the textarea itself had no
            accessible name — several of these render on one page (A11Y-1) */}
        <Textarea
          id={`value-json-${row.key}`}
          name="value_json"
          aria-label={`${name} — configuration JSON`}
          defaultValue={row.valueJson}
          rows={Math.min(16, row.valueJson.split("\n").length + 1)}
          spellCheck={false}
          className="font-mono text-xs"
        />
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`verified-${row.key}`}>Verified on</Label>
            <Input
              id={`verified-${row.key}`}
              name="verified_at"
              type="date"
              defaultValue={row.verifiedAt ?? ""}
              className="h-9 w-44"
            />
          </div>
          <div className="flex min-w-56 flex-1 flex-col gap-1.5">
            <Label htmlFor={`source-${row.key}`}>Source note</Label>
            <Input
              id={`source-${row.key}`}
              name="source_note"
              defaultValue={row.sourceNote ?? ""}
              className="h-9"
            />
          </div>
          <Button type="submit" disabled={pending} className="h-9">
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
        {state.error ? (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        ) : null}
      </form>
    </section>
  );
}
