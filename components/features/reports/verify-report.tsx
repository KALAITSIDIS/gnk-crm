"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { BadgeCheck, BadgeX, ShieldQuestion } from "lucide-react";
import { verifyEvidenceReport, type VerifyReportState } from "@/lib/actions/reports";
import { verifyRequestBody } from "@/lib/services/client-hash";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/utils/format";

const initialState: VerifyReportState = { error: null, result: null };

/**
 * English for now: reports.verify in messages/ has no key for either, and
 * both are rare (an insecure context or an unreadable file; a dropped
 * connection).
 */
const HASH_FAILED_TEXT = "This browser could not read the PDF to check it — paste its SHA-256 instead.";
const NO_ANSWER_TEXT = "The check did not complete — nothing was changed. Try again.";

/**
 * Runs in the BROWSER, as the form's action (T-upload-size-honest): a chosen
 * PDF is hashed here (Web Crypto) and only its digest goes to the server
 * action, through the action's existing `sha256` path. The PDF itself is
 * never posted — a report over ~4.5 MB used to die at Vercel's platform 413
 * before the action ran, and the client threw into the error boundary.
 * Verifying is read-only, so a request that never came back is simply "try
 * again", and it is said here rather than thrown.
 */
async function verifyInBrowser(
  prev: VerifyReportState,
  formData: FormData,
): Promise<VerifyReportState> {
  let body: FormData;
  try {
    body = await verifyRequestBody(formData);
  } catch {
    // no Web Crypto (an insecure context), or the file could not be read
    return { error: HASH_FAILED_TEXT, result: null };
  }
  try {
    return await verifyEvidenceReport(prev, body);
  } catch {
    return { error: NO_ANSWER_TEXT, result: null };
  }
}

/**
 * Prove a commission evidence PDF untampered: choose the file (its SHA-256 is
 * computed in the browser — the PDF never leaves this device, whatever its
 * size) or paste a digest, and match it against the append-only
 * evidence_report_generated event log.
 */
export function VerifyReport() {
  const t = useTranslations("reports.verify");
  const [state, formAction, pending] = useActionState(verifyInBrowser, initialState);

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
