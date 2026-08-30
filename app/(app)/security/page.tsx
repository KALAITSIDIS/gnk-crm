import { ShieldAlert } from "lucide-react";
import { ChangePasswordForm } from "@/components/features/settings/change-password-form";
import { SecurityPanel } from "@/components/features/settings/security-panel";
import { getMfaStatus } from "@/lib/actions/mfa";

export const dynamic = "force-dynamic";

/**
 * Per-user security (IMPROVEMENTS C2). Deliberately NOT under /settings: that
 * area is admin-only, and every role must be able to protect their own account
 * — an agent holds the same client PII in their pocket as an admin.
 */
export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ enrol?: string }>;
}) {
  const [status, params] = await Promise.all([getMfaStatus(), searchParams]);
  // the proxy sends people here when a second factor is required and they have
  // none — without this line the redirect is silent and reads as a bug
  const forced = params.enrol === "required" && status.factors.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-1">Security</h1>
        <p className="text-sm text-text-2">Protect your own account.</p>
      </div>

      {forced ? (
        <div className="flex items-start gap-2 rounded-[10px] border border-warning/40 bg-warning/10 p-4">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="text-sm">
            <p className="font-medium text-text-1">
              Two-factor authentication is required before you can continue
            </p>
            <p className="mt-1 text-text-2">
              This account holds client personal data, KYC scans and the commission evidence
              chain, so a password on its own is no longer enough. Set up an authenticator app
              below and the rest of the app opens up again — it takes about a minute.
            </p>
          </div>
        </div>
      ) : null}

      <SecurityPanel status={status} />
      <ChangePasswordForm />
    </div>
  );
}
