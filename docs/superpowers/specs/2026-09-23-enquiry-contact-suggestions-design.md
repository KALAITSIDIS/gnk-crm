# Possible existing contact on an unlinked website enquiry — design (2026-09-23)

Task id: `T-enquiry-contact-suggestions`. No migration. Decisions and the
review that shaped them: `docs/DECISIONS.md` under the same id.

## Verified starting point (main `4206f625`)

- The inbox never looks for an existing contact until staff click **Create
  contact**: `CreateContactFromEnquiryButton` → `createContactFromEnquiry`
  (`lib/actions/leads.ts:739`) → `checkContactDuplicate`
  (`lib/actions/contacts.ts:36`), which returns ONE match (phone first, then
  e-mail, `limit(1)` each) and turns the button into "Link X instead".
- A phone that matches contact A and an e-mail that matches contact B surface
  A only; B is never shown.
- `linkLeadContact` (`leads.ts:201`) is "link (or replace)": its UPDATE has no
  `contact_id is null` condition, so a stale click overwrites a colleague's
  link; it accepts an archived or erased contact; a repeated submission writes
  a second `contact_linked`; it throws (Next strips thrown messages in
  production — ENGINEERING_NOTES).
- No UI lists a contact's enquiries anywhere.
- RLS: `contacts`, `leads`, `properties`, `profiles` SELECT are org-wide for
  every staff role, behind the restrictive `require_aal2`. `leads_update`:
  admin any, agent own-or-unassigned, listing manager never. RLS does NOT hide
  archived / erased / merged contacts; erasure keeps `email` and `phone_e164`
  on the row (identity retained) and sets `is_archived`, `erased_at`, and an
  erased contact can currently be unarchived — so `erased_at is null` must be
  filtered explicitly.
- Every contact write path lower-cases e-mail except `createLead`'s
  `new_contact_email`. Hosted (0113) holds 0 non-normalised e-mails.

## What ships

**1. A read-only panel on the row** of an eligible enquiry — `source =
website`, open (`new|contacted|qualified`), `contact_id is null` (the lead's
own column, not the reader's view of a contact), message not redacted.

- One batched lookup per inbox page (`lib/queries/enquiry-contact-suggestions.ts`),
  through the signed-in user's client, so RLS and `require_aal2` decide what is
  visible. One `contacts` query for the whole page: `is_archived = false`,
  `erased_at is null`, `email in (…) or phone_e164 in (…) or
  additional_phones && {…}`, each candidate embedding its most recent linked
  leads (`leads!leads_contact_id_fkey`, `received_at desc, id desc`, limit
  3 + 1 so "more exist" is known without a count) with the lead's
  `properties(reference)`. No query at all when nothing on the page has an
  identifier. At most 100 candidate rows per page; past that bound, or on any
  error or throw, EVERY row that needed the lookup says "unavailable" (a cut
  result cannot say which rows lost candidates). Only the error code is logged.
- Matching is deterministic, in `lib/services/enquiry-contact-match.ts` (pure,
  unit-tested): the e-mail lower-cased and trimmed (the existing convention;
  refused if longer than 254 or carrying whitespace, quotes, commas,
  parentheses or a backslash, so every value is safe double-quoted in the
  filter); the phone through `normalizePhone` (CY default) to E.164 and
  compared with `phone_e164` and `additional_phones`. A key the lookup could
  not search is never a key, so it can never read as "no match". No fuzzy
  names, no scores.
- States, each with its own sentence: **matches** (one candidate, or several
  with a note; when the e-mail and the phone point at different contacts the
  note names both), **no match** ("No active contact…"), **unavailable**
  (never shown as "no match"), **no usable e-mail or phone**, **unreadable**.
  There is no client-side loading phase: the panel renders with the page
  (a Suspense/`loading.tsx` boundary is the recorded hydration-freeze trap);
  the one async step, linking, shows "Linking…".
- Each candidate: name (link to the contact), the reason ("Same e-mail and
  phone", "Same e-mail", "Same phone", with "(another number on the
  contact)" when the phone is an additional one), a one-line summary of up to
  3 recent enquiries linked to that contact ("2 recent enquiries · latest 20
  Sept 2026", "3+ …" when older ones exist) that opens in place as a native
  `<details>` — date, listing reference or "No listing", status, assigned
  agent — and **Review and link** (accessible name "Review and link <name>")
  for a person the lead's update policy lets link (`mayLinkLeadContact`:
  admin; agent on own/unassigned — never a listing manager).
- "Create contact" is not offered while the panel lists candidates — the
  dedup check refuses a contact whose phone or e-mail an active contact
  already holds (the unique indexes cover `phone_e164` and `lower(email)`; an
  additional number is refused by the app's check), so the button could only
  end in the match the row already shows — nor when the header is unreadable
  (Create contact reads the same header), nor to a listing manager, nor on a
  redacted enquiry. When Create contact does find a match that appeared after
  the page was drawn, it no longer offers a one-click "Link X instead" (which
  silently picked the phone match): it says so and refreshes the inbox, so the
  panel shows every candidate with the evidence.

**2. Review and link** — a dialog (opening it writes nothing) showing the
evidence line by line — what the enquiry gave and whether this contact has
it, including what does NOT match — the split note if any, the recent
enquiries, and "A shared e-mail or phone suggests, but does not prove, that
this is the same person." Confirm calls `linkLeadContact(leadId, contactId,
{ via: "suggestion" })`. A refusal is shown in the dialog and the inbox is
refreshed underneath.

**3. `linkLeadContact`, hardened** (used by the dialog and the manual Link
contact dialog):

- Returns `{ error, alreadyLinked, warning }` instead of throwing.
- Refuses: a listing manager; an agent on another agent's lead; a closed or
  converted lead; a redacted enquiry; an archived, erased or unknown contact;
  a lead already linked to a DIFFERENT contact (no replacement — nothing in
  the UI offers one); and, for `via: "suggestion"`, a contact that no longer
  shares the enquiry's e-mail or phone (recomputed server-side — stale evidence
  is not confirmed).
- Already linked to the SAME contact → success, no write, no event.
- The write (`lib/services/lead-contact-link.ts`, client passed in so the DB
  suite races real sessions through it) is conditional — `contact_id is
  null`, status open, message not the redaction marker (null messages still
  qualify) — and a zero-row answer is classified by a re-read: same contact
  → idempotent success, no event; another contact → "linked meanwhile";
  closed → "converted or closed meanwhile"; redacted → "redacted meanwhile";
  otherwise the row policy refused.
- One `contact_linked` event only for a write that happened, as an inline
  literal `{ contact_id, via, matched_on }` (ids and an enum only). If the
  event cannot be written after the link, the result is success with a
  warning — a retry would find the lead linked and write nothing, so a thrown
  error would lose the event for good.
- Linking sets `contact_id` alone: status, assignment, `received_at`,
  `first_response_at`, `first_call_at`, criteria, property, channel and
  `notification_jobs` are untouched (no trigger on leads reacts to
  `contact_id`).

**4. Personal data out of Sentry.** Every PostgREST read is a GET whose
filter is the query string, and `@sentry/nextjs` records outgoing URLs on
fetch spans (`url.full`, `url.query`, Next's span name and `http.url`) and
breadcrumbs (`http.query`) at a 10% trace sample. `instrumentation.ts` now
runs every span, breadcrumb and transaction through `scrub-event.ts`, which
cuts every absolute URL at its query. This also covers the existing dedup
check and the contact picker.

**5. `createLead` lower-cases `new_contact_email`**, like every other path.

**6. `createContactFromEnquiry` refuses a listing manager** before inserting
anything (it used to create the contact and then fail the link, leaving an
orphan the panel would go on to suggest).

## Not in this version

- Earlier UNLINKED enquiries from the same person, `leads.enquirer_key`,
  backfill, "Link all" (BACKLOG "Phase 2 — the enquirer key").
- Archived and merged contacts are never suggested; an alternate e-mail that a
  merge dropped (it survives on the archived duplicate and, by value, in the
  `merged` event payload — a separate privacy defect, BACKLOG) is not followed.
- A website phone that does not normalise to E.164 is not matched.
- The lookup's values still travel in the URL to Supabase's API gateway, whose
  request log records query strings — as every existing PostgREST search
  already does; a POST-bodied RPC would avoid it at the price of a migration.
- A link racing an in-progress erasure or merge (their steps are not one
  transaction) can land between their steps; closing that needs a database
  lock, i.e. a migration. The link and its event are two statements, not one.
- No index on `additional_phones`: the existing dedup already scans it and the
  hosted table holds 6 contacts; revisit when contacts reach the thousands.
