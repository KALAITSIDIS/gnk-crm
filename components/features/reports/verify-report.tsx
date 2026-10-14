"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import * as Sentry from "@sentry/nextjs";
import { BadgeCheck, BadgeX, ShieldQuestion } from "lucide-react";
import { verifyEvidenceReport, type VerifyReportState } from "@/lib/actions/reports";
import { verifyInBrowser } from "@/lib/services/client-hash";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/utils/format";

const initialState: VerifyReportState = { error: null, result: null };

/**
 * The form's action runs in the BROWSER (T-upload-size-honest —
 * lib/services/client-hash.ts `verifyInBrowser`, unit-tested there): a chosen
 * PDF is hashed here (Web Crypto) and only its digest goes to the server
 * action, through the action's existing `sha256` path. The PDF itself is
 * never posted — a report over ~4.5 MB used to die at Vercel's platform 413
 * before the action ran, and the client threw into the error boundary. Every
 * failure is an answer on the form; a request that never came back is also
 * reported to Sentry, as the error boundary did.
 */
const verifyAction = (prev: VerifyReportState, formData: FormData) =>
  verifyInBrowser(prev, formData, {
    verify: verifyEvidenceReport,
    onRejected: (error) => Sentry.captureException(error, { tags: { lost_request: "verify-report" } }),
  });

/**
 * Prove a commission evidence PDF untampered: choose the file (its SHA-256 is
 * computed in the browser — the PDF never leaves this device, whatever its
 * size) or paste a digest, and match it against the append-only
 * evidence_report_generated event log.
 */
export function VerifyReport() {
  const t = useTranslations("reports.verify");
  const [state, formAction, pending] = useActionState(verifyAction, initialState);

  return (
    <section className="flex max-w-2xl flex-col gap-3 rounded-[10px] border border-border bg-surface p-5">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="size-5 shrink-0 text-brand-700" />
        <h2 className="text-sm font-semibold text-text-1">{t("heading")}</h2>
      </div>
      <p className="text-sm text-text-2">{t("description")}</p>
      <form action={formAction} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="vr-file">{t("fileLabel")}</Label>
          <Input id="vr-file" name="file" type="file" accept="application/pdf" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="vr-sha">{t("hashLabel")}</Label>
          <Input
            id="vr-sha"
            name="sha256"
            placeholder={t("hashPlaceholder")}
            className="font-mono"
          />
        </div>
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? t("pending") : t("submit")}
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
              {state.result.rows
                ? t("matched", {
                    when: formatDateTime(state.result.generatedAt),
                    count: state.result.rows,
                  })
                : t("matchedNoCount", { when: formatDateTime(state.result.generatedAt) })}{" "}
              {state.result.reportHash ? (
                <span className="block font-mono text-xs">
                  {t("reportHash", { hash: state.result.reportHash })}
                </span>
              ) : null}
            </span>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-[10px] border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            <BadgeX className="mt-0.5 size-4 shrink-0" />
            <span>
              {t("noMatch")}
              <span className="block font-mono text-xs">{state.result.sha256}</span>
            </span>
          </div>
        )
      ) : null}
    </section>
  );
}
