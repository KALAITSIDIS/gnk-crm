import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import {
  ChecklistsForm,
  ProfileForm,
} from "@/components/features/contacts/detail-forms";
import { ArchiveContactButton } from "@/components/features/contacts/archive-button";
import { AddTaskDialog } from "@/components/features/tasks/add-task-dialog";
import {
  ContactDocumentsTab,
  type ContactDocument,
} from "@/components/features/contacts/documents-tab";
import { EraseContactDialog } from "@/components/features/contacts/erase-dialog";
import { MergeDialog } from "@/components/features/contacts/merge-dialog";
import { ChatLinks } from "@/components/features/shared/chat-links";
import { LogContactConversation } from "@/components/features/contacts/log-contact";
import { ContactActivityStrip } from "@/components/features/contacts/activity-summary";
import { ActivityFeed } from "@/components/features/shared/event-timeline";
import { StatusBadge } from "@/components/features/shared/status-badge";
import { PortfolioTab } from "@/components/features/contacts/portfolio-tab";
import {
  RequirementsCard,
  type RequirementRow,
} from "@/components/features/contacts/requirements-card";
import {
  MatchesCard,
  type RequirementForMatching,
} from "@/components/features/contacts/matches-card";
import { PartyDefaultsForm } from "@/components/features/contacts/party-defaults-form";
import { getPartyDefaults } from "@/lib/actions/party-defaults";
import { mayEditBuyerRequirements } from "@/lib/validators/buyer-requirements";
import { contactArchiveAction } from "@/lib/validators/contacts";
import { isPartyContact, partyDefaultsSchema } from "@/lib/validators/party-defaults";
import { buildPortfolio, PORTFOLIO_SELECT } from "@/lib/services/contact-portfolio";
import { annotateContactTimeline } from "@/lib/services/contact-timeline";
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
import { unwrapRows } from "@/lib/supabase/unwrap";
import { isGuid } from "@/lib/validators/ids";
import { formatDateTime } from "@/lib/utils/format";
import { CUSTOMER_FEED_SKIPPED_TYPES, readEntityTimelines } from "@/lib/services/entity-timeline";
import { readContactActivitySummary } from "@/lib/services/contact-activity-summary";
import { proposalsForContact } from "@/lib/queries/proposals-sent";
import { readContactHistoryIds } from "@/lib/queries/contact-history";
import { ProposalsSentList } from "@/components/features/contacts/proposals-sent";
import type { Metadata } from "next";

/**
 * The browser tab's name (A08): the generic word only — never the record's
 * name or a person's, because tab titles land in browser history on shared
 * devices. Static on purpose: no generateMetadata here (tests/unit/page-titles.test.ts).
 */
export const metadata: Metadata = { title: "Contact" };

const TEMP_TONES: Record<string, string> = {
  hot: "bg-danger/10 text-danger",
  warm: "bg-warning/10 text-warning",
  cold: "bg-brand-100 text-brand-700",
  inactive: "bg-surface-2 text-text-3",
  // bronze TEXT token on the bronze tint: accent-500 text measures 3.09:1 on white (A08); the fill stays accent-500
  vip: "bg-accent-500/10 text-accent-700",
};

/**
 * The tabs below, in order — what `?tab=` may name (A04: the leads inbox links
 * a lead's contact straight to its Preferences, where saved searches live).
 * Anything else, and "terms" on a contact without standard terms, opens Profile.
 */
const CONTACT_TABS = [
  "profile",
  "preferences",
  "kyc",
  "activity",
  "portfolio",
  "terms",
  "deals",
  "viewings",
  "documents",
] as const;

export default async function ContactDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `?tab=` — open on that tab; anything unknown opens Profile */
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { id } = await params;
  // a segment that is not an id names nothing: 404 before any query (T-malformed-ids) —
  // and the reads below interpolate it into PostgREST `.or()` filter strings
  if (!isGuid(id)) notFound();
  const query = await searchParams;
  // the first value wins for a repeated parameter, as on every list page
  const askedTab = Array.isArray(query.tab) ? query.tab[0] : query.tab;
  const supabase = await createClient();

  const [
    { data: c },
    { data: areaRows },
    mergedRes,
    { data: profileRows },
    { data: portfolioRows },
    { data: districtRows },
    requirementsRes,
  ] =
    await Promise.all([
      supabase.from("contacts").select("*").eq("id", id).maybeSingle(),
      supabase.from("areas").select("id, name"),
      supabase.from("contacts").select("id, display_name").eq("merged_into_id", id),
      supabase.from("profiles").select("id, full_name, is_active, role").order("full_name"),
      // audit finding 9: what this contact owns or built. One query, both party
      // columns — a developer is usually both on the units it has not sold.
      supabase
        .from("properties")
        .select(PORTFOLIO_SELECT)
        .or(`owner_contact_id.eq.${id},developer_contact_id.eq.${id}`),
      supabase.from("districts").select("id, name").order("sort_order"),
      // 0043 saved searches, newest first; archived ones come too and the card
      // splits them, so retiring a search never hides that it existed
      supabase
        .from("buyer_requirements")
        .select("*")
        .eq("contact_id", id)
        .order("created_at", { ascending: false }),
    ]);
  if (!c) notFound();
  // its ids feed the combined history below: a failed read is a failure, not "no duplicates"
  const mergedRows = unwrapRows(mergedRes, "merged contacts");
  // A04: what the matcher reads, and what "No saved searches yet — add one"
  // would otherwise be drawn from — a failed read must not invite a duplicate
  const requirementRows = unwrapRows(requirementsRes, "saved searches");

  const profile = await getCurrentProfile(supabase);

  const [
    dealsRes,
    { data: stageRows },
    { data: documentRows },
    { data: absorber },
    viewingsRes,
    historyIds,
  ] = await Promise.all([
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
    // WF-3: "what has this buyer already seen" finally has a surface
    supabase
      .from("viewings")
      .select("id, scheduled_at, status, properties(reference)")
      .eq("contact_id", id)
      .order("scheduled_at", { ascending: false })
      .limit(50),
    // A06: what the combined history and the summary strip are asked about —
    // EVERY lead, deal and viewing of the person, not the two tabs' newest 50
    // above. The inbox files its Contacted / Called / Log / WhatsApp events on
    // the LEAD, and a developer is the seller on every unit deal: a call logged
    // yesterday on the 51st-newest deal must still be "Last logged contact".
    // Paged; a failed page fails the page (lib/queries/contact-history.ts).
    readContactHistoryIds(supabase, id),
  ]);
  // The tabs' lists. A failed read fails the page rather than reading as "no
  // deals, no viewings" — a contact with no history it actually has.
  const dealRows = unwrapRows(dealsRes, "contact deals");
  const viewingRows = unwrapRows(viewingsRes, "contact viewings");
  const { leadIds, dealIds, viewingIds } = historyIds;
  const contactIds = [id, ...mergedRows.map((m) => m.id)];
  const now = new Date(); // per-request clock: "next" viewing, overdue task

  const [timeline, summary, proposals] = await Promise.all([
    // Combined history (A06): this contact + everything merged into it
    // (DECISIONS T2.3), its leads, the deals this viewer may read, and its
    // viewings — read as the SYSTEM. `events_select` shows a non-admin only
    // the rows they authored, so on the caller's client this answered "what
    // did I do to this contact". Every id came back from a read on THIS
    // client above (the page notFound()s when it cannot read the contact),
    // and a slip's signer names are withheld from non-admins by the reader.
    readEntityTimelines({
      orgId: profile.orgId,
      viewerRole: profile.role,
      viewer: supabase,
      sources: [
        { entityType: "contact", entityIds: contactIds },
        { entityType: "lead", entityIds: leadIds },
        { entityType: "deal", entityIds: dealIds },
        { entityType: "viewing", entityIds: viewingIds },
      ],
      perSource: 50,
      limit: 100,
      excludeEventTypes: CUSTOMER_FEED_SKIPPED_TYPES,
    }),
    // Last logged contact / last chat opened (system, same ids) and the next
    // step (THIS client: a non-admin sees the tasks they hold or set — the
    // strip says whose)
    readContactActivitySummary({
      orgId: profile.orgId,
      viewer: supabase,
      contactId: id,
      contactIds,
      leadIds,
      dealIds,
      now,
    }),
    // A04: the proposals minted for this buyer — the "Proposed" marks on the
    // matches and the Proposals sent list. Bounded, and a failure is stated,
    // never "none" (lib/queries/proposals-sent.ts).
    proposalsForContact(supabase, id),
  ]);

  const events = annotateContactTimeline(timeline.rows, id, mergedRows);

  const areaOptions = (areaRows ?? []).map((a) => ({
    id: a.id,
    name: (a.name as { en?: string })?.en ?? "—",
  }));
  const districtOptions = (districtRows ?? []).map((d) => ({
    id: d.id,
    name: (d.name as { en?: string })?.en ?? "—",
  }));
  const requirements = requirementRows as unknown as RequirementRow[];

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
  // an erased contact is frozen for everyone: re-editing it would re-create the
  // personal data the erasure request removed
  // truthiness, not `!== null`: the page selects "*", so if this deploy lands
  // before migration 0017 the column is simply ABSENT (undefined) — and
  // `undefined !== null` would mark every contact erased and freeze the module.
  // Vercel deploys on push while migrations are applied by hand, so code must
  // never hard-depend on a migration having landed (see DECISIONS 2026-07-21).
  const isErased = Boolean(c.erased_at);
  const eraserName = c.erased_by ? (profileName.get(c.erased_by) ?? null) : null;
  const canEdit = mayUpdate && !c.is_archived && !isErased;
  // a merged duplicate and an erased contact stay archived — no Unarchive
  const archiveAction = contactArchiveAction({
    mayUpdate,
    isArchived: Boolean(c.is_archived),
    isMerged: Boolean(c.merged_into_id),
    isErased,
  });
  const readOnlyHint = isErased
    ? "Personal data was erased under GDPR Art.17 — this contact is read-only."
    : c.is_archived
    ? "Archived contact — unarchive it to edit."
    : profile.role === "agent"
      ? "Read-only — this contact isn't assigned to you and you didn't create it."
      : "Read-only — listing managers can't edit contacts.";

  /*
   * SAVED SEARCHES ARE A DIFFERENT TABLE WITH A DIFFERENT POLICY.
   *
   * `canEdit` above mirrors the CONTACTS update policy (admin any, agent
   * own/created, LM none) and is right for the contact's own fields. The
   * requirements card writes `buyer_requirements`, whose policies (0043) are
   * org-scoped with NO role test at all — and whose DELETE deliberately names
   * ('admin','listing_manager') as the *narrower* set, with the comment:
   * "is_active = false is the normal way to retire a search and any agent can
   * do it". So the intent is plain: any staff member records and retires saved
   * searches; only admin and the listing manager may hard-delete one.
   *
   * Passing `canEdit` here asked the wrong table's policy, and locked listing
   * managers — and any agent who does not own the contact — out of work the
   * database grants them. Measured in
   * supabase/tests/listing-manager-silent-writes.test.ts: their insert and
   * update both land.
   *
   * The roles are NAMED rather than left open, even though the policy has no
   * role test, because 0078 makes portal-role profiles impossible with a CHECK
   * and records a sunset obligation: "when those roles are built, contacts and
   * buyer_requirements must be revisited TOGETHER". Naming them keeps that
   * revisit honest instead of granting a future portal user access by default.
   *
   * The archived and erased freezes still apply — they are about the CONTACT,
   * not about who is asking.
   */
  const mayEditRequirements = mayEditBuyerRequirements(profile.role, {
    isArchived: Boolean(c.is_archived),
    isErased,
  });
  const requirementsReadOnlyHint = isErased
    ? "Personal data was erased under GDPR Art.17 — this contact is read-only."
    : "Archived contact — unarchive it to edit its saved searches.";

  const kycPct = kycCompletion((c.kyc ?? {}) as KycState);
  const bankPct = bankingCompletion((c.banking_readiness ?? {}) as BankingReadinessState);

  // Standard terms (0038) — only for contacts who HAVE terms. A buyer has no
  // commission rate and no usual VAT treatment; the tab would suggest otherwise.
  const isParty = isPartyContact(c.contact_types);
  const storedDefaults = isParty
    ? (partyDefaultsSchema.safeParse(c.party_defaults ?? {}).data ?? {})
    : {};
  // resolved with NO contact, which yields the office layer alone — the form
  // shows it as the placeholder under each blank field
  const officeDefaults = isParty ? (await getPartyDefaults(null)).defaults : {};

  const portfolio = buildPortfolio(portfolioRows ?? [], id);

  // `?tab=` (A04): a known tab this contact HAS, else Profile
  const initialTab =
    CONTACT_TABS.find((t) => t === askedTab && (t !== "terms" || isParty)) ?? "profile";
  // the buyer a proposal from the matches is bound to (A04) — nothing is
  // offered on an archived or erased contact, and the action refuses either
  const proposalBuyer = {
    id: c.id,
    name: c.display_name ?? "this buyer",
    languages: Array.isArray(c.languages) ? (c.languages as string[]) : [],
  };
  const mayActOnMatches = !c.is_archived && !isErased;

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
          {/* `flex-wrap`: an admin's five actions here are 607px of buttons, and
              a row that could not wrap widened the whole page to 631px in a
              390px viewport (2026-09-14; measured since by
              tests/e2e/phone-layout.spec.ts). Once the group drops below the
              name it takes the full width and the buttons fall into rows;
              beside the name nothing changes. */}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {/* DB-11a: same gate as AddTaskDialog — logging a conversation is
                a claim any role that can see the contact may make (the
                ChatLinks precedent), not an edit */}
            {!c.is_archived && !isErased ? <LogContactConversation contactId={c.id} /> : null}
            {!c.is_archived && !isErased ? (
              <AddTaskDialog
                entity={{ contact_id: c.id }}
                entityLabel={c.display_name ?? "this contact"}
              />
            ) : null}
            {archiveAction ? (
              <ArchiveContactButton
                contactId={c.id}
                contactName={c.display_name ?? "this contact"}
                isArchived={archiveAction === "unarchive"}
              />
            ) : null}
            {profile.role === "admin" && !c.is_archived && !isErased ? (
              <MergeDialog primaryId={c.id} primaryName={c.display_name ?? "this contact"} />
            ) : null}
            {profile.role === "admin" && !isErased ? (
              <EraseContactDialog
                contactId={c.id}
                contactName={c.display_name ?? "this contact"}
              />
            ) : null}
          </div>
        </div>
        {isErased ? (
          <p className="mt-2 rounded-[8px] border border-danger/40 bg-surface px-3 py-2 text-xs text-text-2">
            <span className="font-medium text-text-1">
              Personal data erased under GDPR Article 17
            </span>{" "}
            on {formatDateTime(c.erased_at as string)}
            {eraserName ? ` by ${eraserName}` : ""}.{" "}
            {c.retention_until
              ? `KYC records are retained until ${c.retention_until} to satisfy the AML record-keeping duty.`
              : "No records were retained — this contact never entered a transaction."}{" "}
            Signed viewing slips, the event log and evidence reports are unaltered by design.
          </p>
        ) : null}
        {c.merged_into_id && absorber ? (
          <p className="mt-1 text-xs text-text-3">
            Merged into{" "}
            <Link href={`/contacts/${absorber.id}`} className="text-brand-700 underline">
              {absorber.display_name}
            </Link>{" "}
            — records and future activity live there.
          </p>
        ) : null}
        {mergedRows.length > 0 ? (
          <p className="mt-1 text-xs text-text-3">
            Absorbed: {mergedRows.map((m) => m.display_name).join(", ")}
          </p>
        ) : null}
        {/* A06: last logged contact, last chat-link click (never counted as
            contact), next step — across the contact, its leads and deals */}
        <ContactActivityStrip
          summary={summary}
          actorNames={profileName}
          viewerId={profile.id}
          viewerIsAdmin={profile.role === "admin"}
          canAddTask={!c.is_archived && !isErased}
          now={now}
        />
      </div>

      {/* keyed by the asked tab: following a ?tab= link from this page itself
          remounts the tabs on it rather than keeping the last one open */}
      <Tabs key={initialTab} defaultValue={initialTab}>
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
          <TabsTrigger value="kyc">
            KYC & Banking ({kycPct}% / {bankPct}%)
          </TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="portfolio">Properties ({portfolio.propertyCount})</TabsTrigger>
          {isParty ? (
            <TabsTrigger value="terms">Standard terms</TabsTrigger>
          ) : null}
          <TabsTrigger value="deals">Deals ({dealRows.length})</TabsTrigger>
          <TabsTrigger value="viewings">Viewings ({viewingRows.length})</TabsTrigger>
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
          <div className="flex max-w-4xl flex-col gap-6">
            {/* 0043 saved searches come FIRST: these are what matching reads.
                The legacy blob below is kept visible until the conversion has
                been reviewed on real data (its column is deliberately not
                dropped), but it drives nothing. */}
            <section className="rounded-[10px] border border-border bg-surface p-6">
              <div className="mb-4">
                <h2 className="text-sm font-semibold text-text-1">Saved searches</h2>
                <p className="text-sm text-text-2">
                  What this buyer is looking for. Several are fine — each one is matched against
                  listings on its own.
                </p>
              </div>
              <RequirementsCard
                contactId={c.id}
                requirements={requirements}
                districts={districtOptions}
                areas={areaOptions}
                readOnly={!mayEditRequirements}
                readOnlyHint={requirementsReadOnlyHint}
              />
            </section>

            <section className="rounded-[10px] border border-border bg-surface p-4 sm:p-6">
              <div className="mb-4">
                <h2 className="text-sm font-semibold text-text-1">Matching listings</h2>
                <p className="text-sm text-text-2">
                  Scored against each saved search. Every score shows what it missed.
                  {mayActOnMatches
                    ? " Tick listings to make one proposal for this buyer, or schedule a viewing from a row — nothing is sent for you."
                    : ""}
                </p>
              </div>
              <MatchesCard
                requirements={requirements as unknown as RequirementForMatching[]}
                buyer={proposalBuyer}
                canAct={mayActOnMatches}
                role={profile.role}
                proposals={proposals}
              />
            </section>

            {/* A04: what this buyer was already sent, from the links themselves */}
            <section className="rounded-[10px] border border-border bg-surface p-6">
              <div className="mb-3">
                <h2 className="text-sm font-semibold text-text-1">Proposals sent</h2>
                <p className="text-sm text-text-2">
                  Proposal links made for this buyer, newest first.
                </p>
              </div>
              <ProposalsSentList history={proposals} now={now} />
            </section>
          </div>
        </TabsContent>

        <TabsContent value="kyc" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            <ChecklistsForm contact={c} readOnly={!canEdit} readOnlyHint={readOnlyHint} />
          </div>
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-4 sm:p-6">
            {/* the contact's own events and its leads', deals' and viewings',
                each from another record chipped with where it came from;
                filterable in place (no URL parameter) */}
            <ActivityFeed timeline={{ ...timeline, rows: events }} pageEntityType="contact" />
          </div>
        </TabsContent>

        {isParty ? (
          <TabsContent value="terms" className="mt-4">
            <div className="max-w-4xl rounded-[10px] border border-border bg-surface p-6">
              <PartyDefaultsForm
                contactId={id}
                contactName={c.display_name ?? "this contact"}
                stored={storedDefaults}
                office={officeDefaults}
                // admin only — `contacts` has no listing-manager UPDATE policy (0002), so
                // anyone else would get a form that looks editable and always fails; and
                // never on an erased contact, which the database keeps as the erasure
                // left it (0134) — frozen for everyone, like the rest of this page
                readOnly={profile.role !== "admin" || isErased}
              />
            </div>
          </TabsContent>
        ) : null}

        <TabsContent value="portfolio" className="mt-4">
          <PortfolioTab portfolio={portfolio} />
        </TabsContent>

        <TabsContent value="viewings" className="mt-4">
          {viewingRows.length === 0 ? (
            <div className="max-w-3xl rounded-[10px] border border-dashed border-border py-12 text-center text-sm text-text-3">
              No viewings yet — schedule one from a property page or the calendar.
            </div>
          ) : (
            <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
              <ul className="flex flex-col divide-y divide-border/60">
                {viewingRows.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <Link href={`/viewings/${v.id}`} className="text-brand-700 hover:underline">
                      {formatDateTime(v.scheduled_at)}
                    </Link>
                    <span className="font-mono text-text-2">
                      {(v.properties as { reference: string } | null)?.reference ?? ""}
                    </span>
                    <span className="text-xs capitalize text-text-3">
                      {String(v.status).replace("_", " ")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </TabsContent>

        <TabsContent value="deals" className="mt-4">
          {dealRows.length === 0 ? (
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
                  {dealRows.map((d) => (
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
              // gates only Delete in this tab: an erased contact's retained
              // documents are kept until the retention purge destroys them (0134)
              isAdmin={profile.role === "admin" && !(isErased && c.retention_until)}
              canUpload={!c.is_archived && !isErased}
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
