import { getTranslations } from "next-intl/server";
import { MfaVerifyForm } from "@/components/features/shared/mfa-verify-form";

/**
 * Second-factor challenge (IMPROVEMENTS C2). Reached only when the session is
 * `aal1` and the account owes a verified factor — `proxy.ts` routes here and
 * bounces users who owe nothing, so this page is never a dead end.
 */
export default async function MfaVerifyPage() {
  const t = await getTranslations("app");

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-2 p-4">
      <div className="w-full max-w-sm rounded-[10px] border border-border bg-surface p-8 shadow-sm">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-text-1">{t("name")}</h1>
          <p className="mt-1 text-sm text-text-2">Two-factor authentication</p>
        </div>
        <MfaVerifyForm />
      </div>
    </div>
  );
}
