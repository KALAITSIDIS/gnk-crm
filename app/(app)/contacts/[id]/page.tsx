import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import {
  ChecklistsForm,
  PreferencesForm,
  ProfileForm,
} from "@/components/features/contacts/detail-forms";
import { ArchiveContactButton } from "@/components/features/contacts/archive-button";
import {
  ContactDocumentsTab,
  type ContactDocument,
} from "@/components/features/contacts/documents-tab";
import { MergeDialog } from "@/components/features/contacts/merge-dialog";
import { ChatLinks } from "@/components/features/shared/chat-links";
import { EventTimeline } from "@/components/features/shared/event-timeline";
import { StatusBadge } from "@/components/features/shared/status-badge";
import { getCurrentProfile } from "@/lib/services/auth";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

  const [{ data: c }, { data: areaRows }, { data: mergedRows }, { data: profileRows }] =
    await Promise.all([
      supabase.from("contacts").select("*").eq("id", id).maybeSingle(),
      supabase.from("areas").select("id, name"),
      supabase.from("contacts").select("id, display_name").eq("merged_into_id", id),
      supabase.from("profiles").select("id, full_name, is_active, role").order("full_name"),
    ]);
  if (!c) notFound();

  const profile = await getCurrentProfile(supabase);

  const [
    { data: eventRows },
    { data: dealRows },
    { data: stageRows },
    { data: documentRows },
    { data: absorber },
  ] = await Promise.all([
    // combined history: this contact + everything merged into it (DECISIONS T2.3)
    supabase
      .from("events")
      .select("id, occurred_at, event_type, entity_type, entity_id, payload")
      .eq("entity_type", "contact")
      .in("entity_id", [id, ...(mergedRows ?? []).map((m) => m.id)])
      .order("occurred_at", { ascending: false })
      .limit(50),
    supabase
      .from("deals")
      .select(
        "id, title, deal_type, status, stage_id, agent_id, created_at, buyer_contact_id, seller_contact_id",
      )
      .or(`buyer_contact_id.eq.${id},seller_contact_id.eq.${id}`)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("deal_stages").select("id, name"),
    supabase
      .from("documents")
      .select("id, title, doc_type, created_at, uploader:profiles!uploaded_by(full_name)")
      .eq("entity_type", "contact")
      .eq("entity_id", id)
      .order("created_at", { ascending: false }),
    c.merged_into_id
      ? supabase
          .from("contacts")
          .select("id, display_name")
          .eq("id", c.merged_into_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const mergedName = new Map((mergedRows ?? []).map((m) => [m.id, m.display_name]));
  const events = (eventRows ?? []).map((e) => ({
    ...e,
    note: e.entity_id !== id ? (mergedName.get(e.entity_id ?? "") ?? "merged contact") : null,
  }));

  const areaOptions = (areaRows ?? []).map((a) => ({
    id: a.id,
    name: (a.name as { en?: string })?.en ?? "—",
  }));

  const profileName = new Map((profileRows ?? []).map((p) => [p.id, p.full_name]));
  // reassignment select: active agents, plus the current holder even if deactivated
  const agentsForSelect = (profileRows ?? [])
    .filter((p) => (p.is_active && p.role !== "listing_manager") || p.id === c.assigned_agent_id)
    .map((p) => ({ id: p.id, full_name: p.is_active ? p.full_name : `${p.full_name} (inactive)` }));

  const stageName = new Map((stageRows ?? []).map((s) => [s.id, s.name]));
  const documents: ContactDocument[] = (documentRows ?? []).map((d) => ({
    id: d.id,
    title: d.title,
    doc_type: d.doc_type,
    created_at: d.created_at,
    uploaded_by_name:
      (d.uploader as { full_name?: string } | null)?.full_name ?? null,
  }));

  // mirror of the contacts UPDATE policies (doc 04): admin any, agent own/created, LM none
  const ownsContact = c.assigned_agent_id === profile.id || c.created_by === profile.id;
  const mayUpdate = profile.role === "admin" || (profile.role === "agent" && ownsContact);
  const canEdit = mayUpdate && !c.is_archived;
  const readOnlyHint = c.is_archived
    ? "Archived contact — unarchive it to edit."
    : profile.role === "agent"
      ? "Read-only — this contact isn't assigned to you and you didn't create it."
      : "Read-only — listing managers can't edit contacts.";

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
          <ChatLinks
            phoneE164={c.phone_e164}
            telegramUsername={c.telegram_username}
            hasWhatsapp={c.has_whatsapp}
            contactId={c.id}
          />
          {c.is_archived ? (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-3">
              archived{c.merged_into_id ? " (merged)" : ""}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {mayUpdate && (!c.is_archived || !c.merged_into_id) ? (
              <ArchiveContactButton
                contactId={c.id}
                contactName={c.display_name ?? "this contact"}
                isArchived={c.is_archived}
              />
            ) : null}
            {profile.role === "admin" && !c.is_archived ? (
              <MergeDialog primaryId={c.id} primaryName={c.display_name ?? "this contact"} />
            ) : null}
          </div>
        </div>
        {c.merged_into_id && absorber ? (
          <p className="mt-1 text-xs text-text-3">
            Merged into{" "}
            <Link href={`/contacts/${absorber.id}`} className="text-brand-700 underline">
              {absorber.display_name}
            </Link>{" "}
            — records and future activity live there.
          </p>
        ) : null}
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
          <TabsTrigger value="deals">Deals ({(dealRows ?? []).length})</TabsTrigger>
          <TabsTrigger value="documents">Documents ({documents.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            <ProfileForm
              contact={c}
              readOnly={!canEdit}
              readOnlyHint={readOnlyHint}
              agents={profile.role === "admin" ? agentsForSelect : undefined}
            />
          </div>
        </TabsContent>

        <TabsContent value="preferences" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            <PreferencesForm
              contact={c}
              areaOptions={areaOptions}
              readOnly={!canEdit}
              readOnlyHint={readOnlyHint}
            />
          </div>
        </TabsContent>

        <TabsContent value="kyc" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            <ChecklistsForm contact={c} readOnly={!canEdit} readOnlyHint={readOnlyHint} />
          </div>
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            <EventTimeline events={events} />
            {events.length === 50 ? (
              <p className="mt-3 text-xs text-text-3">Showing the latest 50 events.</p>
            ) : null}
            {profile.role !== "admin" ? (
              <p className="mt-3 text-xs text-text-3">
                You see events from your own actions — admins see everyone&apos;s.
              </p>
            ) : null}
          </div>
        </TabsContent>

        <TabsContent value="deals" className="mt-4">
          {(dealRows ?? []).length === 0 ? (
            <div className="max-w-3xl rounded-[10px] border border-dashed border-border py-12 text-center text-sm text-text-3">
              No deals yet — convert a lead or start one from the pipeline.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-[10px] border border-border bg-surface">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Deal</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(dealRows ?? []).map((d) => (
                    <TableRow key={d.id} className="h-11 hover:bg-surface-2">
                      <TableCell className="font-medium">
                        <Link href={`/deals/${d.id}`} className="text-brand-700 hover:underline">
                          {d.title}
                        </Link>
                      </TableCell>
                      <TableCell className="text-[13px] text-text-2">
                        {[
                          d.buyer_contact_id === id ? "buyer" : null,
                          d.seller_contact_id === id ? "seller" : null,
                        ]
                          .filter(Boolean)
                          .join(" + ")}
                      </TableCell>
                      <TableCell className="text-[13px] text-text-2">{d.deal_type}</TableCell>
                      <TableCell className="text-[13px] text-text-2">
                        {stageName.get(d.stage_id) ?? "—"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={d.status} />
                      </TableCell>
                      <TableCell className="text-[13px] text-text-2">
                        {d.agent_id ? (profileName.get(d.agent_id) ?? "—") : "—"}
                      </TableCell>
                      <TableCell className="text-[13px] text-text-3">
                        {formatDateTime(d.created_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {profile.role !== "admin" ? (
            <p className="mt-2 text-xs text-text-3">Deals you can access are listed (doc 04).</p>
          ) : null}
        </TabsContent>

        <TabsContent value="documents" className="mt-4">
          <div className="max-w-3xl">
            <ContactDocumentsTab
              contactId={c.id}
              items={documents}
              isAdmin={profile.role === "admin"}
              canUpload={!c.is_archived}
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
