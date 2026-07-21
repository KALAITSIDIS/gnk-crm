# GDPR contact erasure — design

**Date:** 2026-07-21
**Status:** approved, implementing
**Related:** DECISIONS `T-contact-erasure`, doc 04 RLS matrix, doc 02 §C3 (KYC)

## Problem

A data subject can demand erasure under GDPR Article 17. Today `contacts` can
only be archived — every field survives forever — so the request cannot be
honoured at all. This is live legal exposure for an agency holding buyer and
seller personal data in Cyprus.

## Constraints discovered before designing

Personal data lives in six places. Three of them cannot be erased:

| Location | Personal data | Erasable? |
|---|---|---|
| `contacts` row | names, phones, email, telegram, nationality, languages, preferences, psychology, notes, KYC checklist, banking readiness | **yes** |
| `documents` (`entity_type='contact'`) + `documents` bucket | passport scans, proof of address, source-of-funds evidence, sanctions/PEP declarations | **yes**, subject to AML retention |
| `leads.message` | the person's own enquiry text | **yes** — ordinary column, not hash-chained |
| `events.payload` | `contact_name` on lead events, `signer_name` on slip events | **no** — `trg_events_hash` hashes `payload::text`; editing one breaks `verify_events_chain` from that row on and blocks all evidence-report generation |
| `viewing_slips` | `signer_name`, handwritten signature image, GPS `geolocation` | **no** — doc 04 makes slips immutable (UPDATE ❌ DELETE ❌); they are the commission evidence |
| generated evidence PDFs | names baked into bytes whose SHA-256 is recorded in an event | **no** — the hash is the point |

Two legal bases justify retaining the un-erasable set, and they are the reason
this feature is a redaction and not a delete:

- **GDPR Art. 17(3)(e)** — data needed to establish, exercise or defend legal
  claims. A signed viewing slip proving which agent introduced which buyer to
  which property is exactly that.
- **Cyprus AML** — a real-estate agency is an obliged entity and must keep
  customer due-diligence records for **5 years** after the business
  relationship ends. Art. 17(3)(b) exempts data held to comply with a legal
  obligation.

A "delete everything" button would therefore destroy the commission evidence
*and* breach a statutory retention duty. It is not built.

## Decisions (confirmed with the operator)

1. **Redact profiling, keep identity.** Name, phone and email survive; the
   profiling and marketing layer does not.
2. **Admin only, immediate, typed confirmation.** No request queue — erasure
   requests are rare and a queue is unearned machinery.
3. **KYC files decided per contact.** No deal, no viewing slip and no mandate
   means no AML relationship ever existed, so the documents and their storage
   files are deleted outright. Otherwise they are retained and stamped with a
   5-year expiry.
4. **Lead messages are redacted.**

## Behaviour

### Redacted on the contact row

`notes`, `psychology`, `preferences` → `{}`, `source_detail`,
`telegram_username`, `additional_phones` → `{}`, `nationality`, `languages` →
default, `banking_readiness` → `{}`, `has_whatsapp` → false,
`consent_marketing` → false, `consent_at` → null, `temperature` →
`inactive` (so the contact can never resurface in a hot-buyer or marketing
list), `gdpr_notes` → a standard marker line pointing at the event log.

`kyc` is wiped **only** when there is no AML relationship; where records are
retained the checklist *is* the due-diligence record.

Kept: `first_name`, `last_name`, `company_name`, `phone_e164`, `phone_raw`,
`email`, `contact_types`, `assigned_agent_id`, and all business linkage.

### Other effects

- Every lead with `contact_id = <contact>` gets `message` replaced by a marker.
- Documents: deleted (rows + storage objects) when no AML relationship;
  otherwise retained with `retention_until = today + 5 years`.
- The contact is archived (`is_archived = true`) — an erased contact should not
  sit in the working list.
- Contact becomes read-only, like an archived contact.

### Explicitly untouched

Event payloads, viewing slips, generated evidence PDFs, deals and commission
records. The confirmation dialog states this in plain language and names the
basis, so the operator can answer "what did you keep, and why?".

## Data model

Migration `0017_contact_erasure.sql` adds to `contacts`:

- `erased_at timestamptz` — null means not erased
- `erased_by uuid references profiles(id)`
- `retention_until date` — null when nothing was retained

No new table: the append-only `events` row is the audit record, and three
columns plus the event is enough. Adding an `erasure_requests` table would be
unearned.

## Audit event

One `contact.erased` event carrying **counts and categories, never the erased
values**: which field groups were cleared, how many leads were redacted, how
many documents were deleted vs retained, the retention date, and whether an AML
basis was found. Append-only, so the erasure cannot be quietly undone.

## Code layout

| File | Purpose |
|---|---|
| `supabase/migrations/0017_contact_erasure.sql` | the three columns |
| `lib/services/erasure.ts` | **pure** `planContactErasure()` — takes the contact + `hasAmlRelationship`, returns the update patch, the retention date and the event payload. No I/O, fully unit-tested. |
| `lib/actions/contact-erasure.ts` | `eraseContactPersonalData()` — admin guard, AML probe, row-count-guarded writes, storage cleanup, event |
| `components/features/contacts/erase-dialog.tsx` | destructive button + typed-name confirmation |
| `app/(app)/contacts/[id]/page.tsx` | button wiring, erased banner, read-only gating |

The planner is pure and separate because the AML branch is the part that must
never silently change: it decides whether passport scans are destroyed.

## Guards

- Admin only, enforced in the action (`profile.role !== "admin"`), not merely
  in the UI — RLS on `contacts` also admits agents on their own records, so
  hiding the button would not be a control. Same lesson as `T-property-archive`.
- Refuses if `erased_at` is already set.
- `.select("id")` row-count guard on the contact update before the event is
  written, per repo convention.
- Storage objects are removed only for document rows the delete actually
  returned, so an RLS-filtered no-op cannot strand files.

## Testing

- Unit: `planContactErasure` — AML vs non-AML branches, that identity fields
  are never in the patch, that `temperature` lands on `inactive`, that the
  event payload contains no personal data, and idempotence.
- RLS: a non-admin calling the erasure path is refused.
- Browser: erase a non-AML contact (documents gone), erase an AML contact
  (documents retained + retention date shown), confirm the banner, read-only
  state, and the event line.

## Deliberately out of scope

- **Acting on `retention_until`.** The stamp is written now; a "retention
  expired" view that lets an admin purge the files afterwards goes to BACKLOG.
  Building a purge job for something five years out is speculative.
- Erasure of `deals.commission_notes` — business records retained under the
  legal-claims basis.
- Any undo. Erasure is irreversible by design; the typed confirmation is the
  safety.

## Migration-order risk

Per the 2026-07-21 reports lesson: Vercel deploys on push, hosted migrations
are applied by hand, so code and schema land out of order. This change **reads
three new columns**, so the migration must be applied to hosted BEFORE the code
deploy, or the contact page breaks. Apply `0017` first, then push.
