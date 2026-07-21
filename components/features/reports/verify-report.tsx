"use client";

import { useActionState } from "react";
import { BadgeCheck, BadgeX, ShieldQuestion } from "lucide-react";
import { verifyEvidenceReport, type VerifyReportState } from "@/lib/actions/reports";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/utils/format";

const initialState: VerifyReportState = { error: null, result: null };

/**
 * Prove a commission evidence PDF untampered: upload the file (its SHA-256 is
 * recomputed server-side) or paste a digest, and match it against the
 * append-only evidence_report_generated event log.
 */
export function VerifyReport() {
  const [state, formAction, pending] = useActionState(verifyEvidenceReport, initialState);

  return (
    <section className="flex max-w-2xl flex-col gap-3 rounded-[10px] border border-border bg-surface p-5">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="size-5 shrink-0 text-brand-700" />
        <h2 className="text-sm font-semibold text-text-1">Verify a report</h2>
      </div>
      <p className="text-sm text-text-2">
        Upload a generated PDF (or paste its SHA-256) to check it against the append-only event
        log. A match proves the file is byte-identical to what was generated. You can verify
        reports whose generation event is visible to you.
      </p>
      <form action={formAction} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="vr-file">Report PDF</Label>
          <Input id="vr-file" name="file" type="file" accept="application/pdf" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="vr-sha">…or paste its SHA-256</Label>
          <Input id="vr-sha" name="sha256" placeholder="64 hex characters" className="font-mono" />
        </div>
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Checking…" : "Verify"}
          </Button>
        </div>
      </form>

      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      {state.result ? (
        state.result.matched ? (
          <div className="flex items-start gap-2 rounded-[10px] border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
            <BadgeCheck className="mt-0.5 size-4 shrink-0" />
            <span>
              Authentic — this exact file was generated on{" "}
              {formatDateTime(state.result.generatedAt)}
              {state.result.rows ? ` (${state.result.rows} events)` : ""}.{" "}
              {state.result.reportHash ? (
                <span className="block font-mono text-xs">
                  report hash {state.result.reportHash}
                </span>
              ) : null}
            </span>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-[10px] border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            <BadgeX className="mt-0.5 size-4 shrink-0" />
            <span>
              No match — no report with this SHA-256 is recorded in the event log visible to you.
              The file may have been altered, or its generation event may not be yours to see.
              <span className="block font-mono text-xs">{state.result.sha256}</span>
            </span>
          </div>
        )
      ) : null}
    </section>
  );
}
