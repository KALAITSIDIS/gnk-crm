import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { CalendarPlus, Calculator, Inbox, Phone } from "lucide-react";
import { MyDay } from "@/components/features/dashboard/my-day";

/**
 * Agent dashboard (T5.3, doc 05 — mobile-first 📱, usable at 380px). Listing
 * managers see this dashboard too (DECISIONS 2026-07-13 · T5.3).
 *
 * The quick actions, then My day — today's viewings, tasks due today and
 * overdue, my open leads, hot buyers idle. Since A01 My day is its own
 * component, because the admin dashboard shows the same cards for the admin's
 * own day; its queries and their SQL live in my-day.tsx and hot-idle-card.tsx.
 */
export async function AgentDashboard({ profileId }: { profileId: string }) {
  const t = await getTranslations("dashboard.agent");

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      {/* quick actions — thumb-sized targets at 380px */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          // 0098 (LR-04): a call or a WhatsApp that reached the phone, not the CRM,
          // is two taps to record - the dialog opens preset on /leads
          { href: "/leads?add=phone", label: t("quick.logCall"), icon: <Phone className="size-4" /> },
          {
            href: "/viewings",
            label: t("quick.viewings"),
            icon: <CalendarPlus className="size-4" />,
          },
          { href: "/contacts", label: t("quick.contacts"), icon: <Inbox className="size-4" /> },
          {
            href: "/calculators",
            label: t("quick.calculators"),
            icon: <Calculator className="size-4" />,
          },
        ].map((a) => (
          <Link
            key={a.href}
            href={a.href}
            className="flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-border bg-surface px-3 text-sm font-medium text-text-1 hover:border-brand-300"
          >
            {a.icon}
            {a.label}
          </Link>
        ))}
      </div>

      <MyDay profileId={profileId} />
    </div>
  );
}
