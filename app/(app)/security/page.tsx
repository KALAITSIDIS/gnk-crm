import { SecurityPanel } from "@/components/features/settings/security-panel";
import { getMfaStatus } from "@/lib/actions/mfa";

export const dynamic = "force-dynamic";

/**
 * Per-user security (IMPROVEMENTS C2). Deliberately NOT under /settings: that
 * area is admin-only, and every role must be able to protect their own account
 * — an agent holds the same client PII in their pocket as an admin.
 */
export default async function SecurityPage() {
  const status = await getMfaStatus();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-1">Security</h1>
        <p className="text-sm text-text-2">Protect your own account.</p>
      </div>
      <SecurityPanel status={status} />
    </div>
  );
}
