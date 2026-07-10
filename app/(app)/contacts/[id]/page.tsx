import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import {
  ChecklistsForm,
  PreferencesForm,
  ProfileForm,
} from "@/components/features/contacts/detail-forms";
import { MergeDialog } from "@/components/features/contacts/merge-dialog";
import { getCurrentProfile } from "@/lib/services/auth";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  bankingCompletion,
  kycCompletion,
  type BankingReadinessState,
  type KycState,
} from "@/lib/constants/checklists";
import { formatPhone } from "@/lib/services/phone";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/utils/format";

const TEMP_TONES: Record<string, string> = {
  hot: "bg-danger/10 text-danger",
  warm: "bg-warning/10 text-warning",
  cold: "bg-brand-100 text-brand-700",
  inactive: "bg-surface-2 text-text-3",
  vip: "bg-accent-500/10 text-accent-500",
};

export default async function ContactDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: c }, { data: areaRows }, { data: mergedRows }] = await Promise.all([
    supabase.from("contacts").select("*").eq("id", id).maybeSingle(),
    supabase.from("areas").select("id, name"),
    supabase.from("contacts").select("id, display_name").eq("merged_into_id", id),
  ]);
  if (!c) notFound();

  const profile = await getCurrentProfile(supabase);

  // combined history: this contact + everything merged into it (DECISIONS T2.3)
  const timelineIds = [id, ...(mergedRows ?? []).map((m) => m.id)];
  const { data: events } = await supabase
    .from("events")
    .select("id, occurred_at, event_type, entity_id, payload")
    .eq("entity_type", "contact")
    .in("entity_id", timelineIds)
    .order("occurred_at", { ascending: false })
    .limit(50);
  const mergedName = new Map((mergedRows ?? []).map((m) => [m.id, m.display_name]));

  const areaOptions = (areaRows ?? []).map((a) => ({
    id: a.id,
    name: (a.name as { en?: string })?.en ?? "—",
  }));

  const kycPct = kycCompletion((c.kyc ?? {}) as KycState);
  const bankPct = bankingCompletion((c.banking_readiness ?? {}) as BankingReadinessState);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2 text-text-2">
          <Link href="/contacts">
            <ArrowLeft className="size-4" /> Contacts
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-text-1">{c.display_name}</h1>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${TEMP_TONES[c.temperature] ?? ""}`}
          >
            {c.temperature}
          </span>
          {c.phone_e164 ? (
            <span className="text-sm tabular-nums text-text-2">{formatPhone(c.phone_e164)}</span>
          ) : null}
          {c.email ? <span className="text-sm text-text-2">{c.email}</span> : null}
          {c.is_archived ? (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-3">
              archived{c.merged_into_id ? " (merged)" : ""}
            </span>
          ) : null}
          {profile.role === "admin" && !c.is_archived ? (
            <div className="ml-auto">
              <MergeDialog primaryId={c.id} primaryName={c.display_name ?? "this contact"} />
            </div>
          ) : null}
        </div>
        {(mergedRows ?? []).length > 0 ? (
          <p className="mt-1 text-xs text-text-3">
            Absorbed: {(mergedRows ?? []).map((m) => m.display_name).join(", ")}
          </p>
        ) : null}
      </div>

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
          <TabsTrigger value="kyc">
            KYC & Banking ({kycPct}% / {bankPct}%)
          </TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="deals" disabled title="Arrives with T2.5+">
            Deals
          </TabsTrigger>
          <TabsTrigger value="documents" disabled title="Arrives later in Phase 1">
            Documents
          </TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            <ProfileForm contact={c} />
          </div>
        </TabsContent>

        <TabsContent value="preferences" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            <PreferencesForm contact={c} areaOptions={areaOptions} />
          </div>
        </TabsContent>

        <TabsContent value="kyc" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            <ChecklistsForm contact={c} />
          </div>
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            {(events ?? []).length === 0 ? (
              <p className="text-sm text-text-3">No activity yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {(events ?? []).map((e) => (
                  <li key={e.id} className="flex items-baseline justify-between gap-4 py-2 text-sm">
                    <span className="font-medium text-text-1">
                      {e.event_type.replace(/_/g, " ")}
                      {e.entity_id !== c.id ? (
                        <span className="ml-2 text-xs font-normal text-text-3">
                          ({mergedName.get(e.entity_id ?? "") ?? "merged contact"})
                        </span>
                      ) : null}
                    </span>
                    <span className="text-text-3">{formatDateTime(e.occurred_at)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-text-3">
              Rich timeline with payload summaries arrives with T3.5.
            </p>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
