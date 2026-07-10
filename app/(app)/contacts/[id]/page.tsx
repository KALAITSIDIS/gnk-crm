import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatPhone } from "@/lib/services/phone";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/utils/format";

// Minimal detail view (T2.1) — full tabs arrive in T2.2.
export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: c } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!c) notFound();

  const facts: [string, string][] = [
    ["Kind", c.contact_kind],
    ["Phone", c.phone_e164 ? formatPhone(c.phone_e164) : "—"],
    ["Email", c.email ?? "—"],
    ["Telegram", c.telegram_username ? `@${c.telegram_username}` : "—"],
    ["WhatsApp", c.has_whatsapp ? "yes" : "no"],
    ["Languages", (c.languages ?? []).join(", ").toUpperCase() || "—"],
    ["Nationality", c.nationality ?? "—"],
    ["Types", (c.contact_types ?? []).map((t) => t.replace(/_/g, " ")).join(", ") || "—"],
    ["Temperature", c.temperature],
    ["Source", c.source ? `${c.source}${c.source_detail ? ` (${c.source_detail})` : ""}` : "—"],
    ["Psychology", c.psychology ?? "—"],
    [
      "Marketing consent",
      c.consent_marketing ? `yes — ${formatDateTime(c.consent_at)}` : "no",
    ],
    ["Created", formatDateTime(c.created_at)],
  ];

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2 text-text-2">
          <Link href="/contacts">
            <ArrowLeft className="size-4" /> Contacts
          </Link>
        </Button>
        <h1 className="text-xl font-semibold text-text-1">{c.display_name}</h1>
      </div>

      <div className="rounded-[10px] border border-border bg-surface p-6">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          {facts.map(([label, value]) => (
            <div
              key={label}
              className="flex items-baseline justify-between gap-4 border-b border-border/60 pb-2"
            >
              <dt className="text-[13px] text-text-2">{label}</dt>
              <dd className="text-right text-sm font-medium text-text-1">{value}</dd>
            </div>
          ))}
        </dl>
        {c.notes ? (
          <p className="mt-4 rounded-lg bg-surface-2 p-3 text-sm text-text-2">{c.notes}</p>
        ) : null}
      </div>

      <p className="text-xs text-text-3">
        Profile tabs (preferences, KYC & banking checklists, activity, deals) arrive with T2.2.
      </p>
    </div>
  );
}
