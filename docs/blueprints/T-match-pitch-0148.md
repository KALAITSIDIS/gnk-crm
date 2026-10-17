# Blueprint — T-match-pitch (add-on #1, slice 1): migration 0148 `match_pitches` + `pitchMatchedBuyer`

**DRAFT — NOT A MIGRATION, NOT SCHEDULED.** Written 2026-10-17 by the six-phase audit (`docs/AUDIT_2026-10-17_SIX_PHASE.md` §4, DECISIONS `T-six-phase-audit-2026-10-17`) against gnk-crm `99c3bad`, then reviewed against the repo by a second agent; the review's corrections are applied below. **Nothing here has been run** (no `supabase db reset`, no RLS suite, no hosted read). It is new scope against HANDOFF's standing "Build nothing new — stabilise and let the desk use it", so it lands only on the operator's explicit go-ahead, through the normal recipe (RED → GREEN, mutants, CI, hosted first with the md5-guarded `execute_sql`). If `T-media-path-bound` takes 0148 first, renumber to 0149.

## Scope

WHAT THIS SLICE DOES

The ranked buyer list on the property page (MatchingBuyersCard, from findMatchingBuyers at lib/queries/matches.ts:171) gets a "Pitch" action on each row, for WhatsApp or e-mail. One click calls pitchMatchedBuyer, which:
- re-reads the listing, the buyer and that buyer's active saved searches under RLS;
- re-runs the shared engine (matchProperty, lib/services/matching.ts:194) and refuses if no saved search still matches;
- mints a 14-day proposal link for this buyer and this property through the existing createShareLink. One change there: its return gains `linkId`;
- writes one row in the new public.match_pitches table.

The row's AFTER INSERT trigger writes the `match_pitched` event on the contact in the same transaction. The action then returns the one-time link path plus what the client needs to build the link the agent opens:
- `https://wa.me/<digits>?text=<fixed EN template + proposal URL>`, or
- `mailto:<addr>?subject=&body=`.

The agent opens that link and sends the message by hand. That is doc 01 §10's "WhatsApp Business API | Click-to-chat until Phase 3". The card then reads match_pitches by property to show "Pitched <date> · <channel> · opened N×", using share_links.view_count through the embed. Every member sees this.

WHY A TABLE AND NOT EVENTS ONLY
- events_select (0063:312-315) gives a non-admin only the lines they wrote: `(actor_id = (select auth.uid()))`. So "was this buyer already sent this listing by anyone?" would answer "no" for a colleague's pitch. This is the ask-the-database lesson already applied in match-alerts.ts:223-242.
- The current chat trace cannot answer it either. logChatLinkOpened (lib/actions/leads.ts:927-934) logs only `{ channel }`, with no property.

COMPANION CHANGES IN THE SAME PR
- lib/actions/merge-contacts.ts: a match_pitches repoint.
- tests/unit/merge-repoints-every-fk.test.ts: the regex must learn table-constraint keys. It reads inline `references contacts` only (lines 51-57), so this table's composite key would be invisible to it.
- EVENT_LINES.match_pitched, plus en/el/ru message keys.
- scripts/backup/export-tables.mjs: TABLES and PRIMARY_KEYS.
- verify-restore.sql pins.
- database.types.ts, regenerated.
- A doc 04 row.
- The new action added to malformed-ids.test.ts.

WHAT IT EXPLICITLY DOES NOT DO
- No WhatsApp or e-mail API send, and no server-sent mail. Resend has no verified domain (HANDOFF.md:734 / :946).
- No AI-drafted text. That is M12, Phase 3, and §12.6 says "Nothing AI-drafted is sent or published automatically".
- No ">5% drop" threshold. match-alerts.ts:62-65 says "There is deliberately no minimum drop".
- No "mandate goes active" trigger. becameMatchable keys on property status (match-alerts.ts:111-118).
- No change to the three alert task kinds, and no new task kind. The alert task still names only a count (match-alerts.ts:337-338) and is not closed by pitching.
- No "declined / not for me" disposition, and no alert suppression. That is the natural slice 2.
- No Telegram: t.me cannot prefill a message to a user.
- No price or address masking, no dwell tracking, nothing on gnk-web.
- No score column. 0043:14-19 and T-B5 say "No score column, and do not add one."
- No erasure step: rows hold ids and an enum only, and the contact row survives erasure. The INSERT policy refuses a new pitch to an erased or archived contact.

STATUS
New scope, against the standing stance at HANDOFF.md:2003: "Build nothing new — stabilise and let the desk use it". Production held 0 buyer_requirements (HANDOFF.md:783). This blueprint should not land until the operator names it.

## Events

match_pitched (NEW)
- Written by the database: trigger match_pitches_after_insert (SECURITY INVOKER), in the pitch row's own transaction. Never written by logEvent, so the TS payload-privacy scan does not see it. Its payload is built in SQL from ids only.
- entity_type 'contact', entity_id = match_pitches.contact_id. That puts it on the buyer's timeline, as the 0043 requirement_* lines are.
- actor_id = match_pitches.created_by. Both match_pitches_insert and events_insert (0138) bind this to auth.uid().
- occurred_at = now(), the 0128 rule.
- payload: { pitch_id: uuid, property_id: uuid, channel: 'whatsapp' | 'email', share_link_id: uuid | null }.
- No reference, no name, no phone, no e-mail and no text, per T-event-typed-text-shape.
- The timeline line is EVENT_LINES.match_pitched: "Sent a matching property ({channel})", with messages events.matchPitched / matchPitchedChannel in en, el and ru.

Existing events written along the way (unchanged)
- share_link 'created', from createShareLink: { property_count: 1, locale, expiry_days, contact_id }.
- share_link 'opened', written by resolve_share_link when the buyer opens the link. It has a null actor and is throttled to once per link per Cyprus day.
- A lead plus a desk alert if the buyer presses "I'm interested" on the proposal (submit_proposal_interest, 0106).

Not written
- chat_link_opened. The pitch line is the record of the opened chat, so opening the wa.me / mailto: anchor logs nothing more.

## Decisions needed before building

1. Operator go-ahead. This is new scope. HANDOFF.md:2003 says "Build nothing new — stabilise and let the desk use it", and production held 0 buyer_requirements (HANDOFF.md:783). With no saved searches, the card ranks nobody and the action refuses every pitch. CLAUDE.md says new scope belongs in BACKLOG until it is named.

2. Ledger, or the no-migration version? The inventory rated this "S, no migration": prefilled wa.me text plus a proposal link. That version cannot show the whole desk who was already pitched, because events_select (0063:312-315) hides a colleague's line. 0148 exists only for that. Is the ledger wanted, or is the prefilled link alone enough for slice 1?

3. GDPR and ePrivacy:
   - No consent gate. A pitch does not check contacts.consent_marketing, matching ChatLinks, which has no gate either. Is a pitch covered by the buyer's own saved search (service communication / legitimate interest), or must it require consent_marketing, at least for e-mail?
   - Erasure keeps ids-only pitch rows on the redacted contact, like share_links and events. Confirm, and record it in the erasure spec.

4. Text template. It is fixed and English only, with no name and no price; the agent can edit it before sending. EL and RU templates need a reader of each language. Should the template follow pitchLocale like the link does?

5. One click becomes two. window.open after an awaited server action is popup-blocked, so the result shows an "Open WhatsApp" anchor plus the copy-once link. Acceptable?

6. Every pitch mints a new 14-day proposal link. Should a live, unexpired link for the same buyer and property be reused instead? Reuse is impossible as written: only the token's hash is stored, so the URL cannot be recovered. Re-pitching therefore always mints a new link.

7. Double submit. There is no operation id, so a double click yields two links and two pitches. The client disables the button while pending. Add an operation key (the 0141 / 0142 idiom) only if it matters.

8. Pre-existing guard gap. tests/unit/merge-repoints-every-fk.test.ts reads only inline `references contacts` declarations (lines 51-57). Any table whose only key onto contacts is a table constraint is invisible to it. 0148 is the first such table. The proposed regex delta fixes that; it should land in the same PR, and arguably as its own BACKLOG line.

9. ShareLinkActionState gains `linkId`. Every caller calls createShareLink directly (share-links-client.tsx:82, availability-share.tsx:65), so nothing breaks at runtime. Tests that toEqual a full state object (one-time-secrets.test.ts, contact-link-reread.test.ts) need the new key. The action reads the profile twice, because createShareLink re-reads it; that is acceptable.

10. Slice 2 candidates, each a separate decision:
    - a `declined` disposition that the alerts read, to cut repeat noise (match-alerts.ts:31-34: "an ignored alert is worse than no alert");
    - linking the alert task to its newly matching buyers so pitching can complete it. tasks has no (org_id, id) key, and the buyer ids sit only in the event payload, which the assignee may not be able to read;
    - BACKLOG's two S gaps: "The units grid raises no new-listing alert" and "A stamp that lowers prices raises no bulk price-drop alert".

11. Verification. I did not run the migration. Its exact-text pin is copied verbatim from 0138's postflight (0138:176), which I confirmed is still the latest definition (no later `alter policy events_insert`). The created policies are checked structurally, not by deparsed text, because I could not measure that text here. Run supabase db reset, the RLS suite and CI before hosting it.

12. Hosted gotcha. Default privileges on the hosted database can grant service_role EXECUTE on new functions. The file revokes that explicitly and checks it with has_function_privilege, not ACL text. Confirm with the read-only md5-guarded recipe before applying on hosted.

## Review against the repo (problems found, all folded into the texts below)

Verdict: The proposal holds up against the repo, but it should not land as written. I checked it against 99c3bad, with no database run.

Everything it names exists as claimed:
- the tables and columns (contacts, share_links, buyer_requirements, properties);
- the comm_channel values;
- properties_org_id_id_key and contacts_org_id_id_key;
- events_insert, which still matches 0138:176 exactly;
- the rls_* guards and their columns, and rls_hoisted_policy_count() reading 21;
- every import path and export;
- the createShareLink input shape.

The SQL is valid on PG17. The hoisting, REVOKE-before-GRANT, ids-only event, invoker trigger and require_aal2 patterns follow 0094, 0142 and 0147. Nothing on the doc 01 §10 Do-Not-Build list is touched.

Three things must change before landing:
1. **Policy gap.** match_pitches_insert binds a named link to the buyer but not to the property. Fix: require share_link_properties to include the property.
2. **Wrong wording.** The event line says "Sent a matching property", but the row is written before the chat is even opened, and contact events appear in the commission evidence report. Fix: say "prepared".
3. **Tests the plan says stay green.** Three catalogue tests will fail: contact-links-org-isolation KEYS_0139, the contact-merge-org-isolation link list, and the merge-contacts-org-scope REPOINTS count. They must be updated in the same PR.

Lesser items:
- Use column-level INSERT grants so a session cannot choose the id (a known BACKLOG pattern).
- The card's "opened N×" probably counts link previews; this is unmeasured.
- The "why a table" rationale should rest on indexing; visibility is not the real reason.
- Put the third link-minting surface under the notice guard.
- Write each touched file whole.

Blocking decisions for the operator: the go-ahead itself (HANDOFF.md:2003, CLAUDE.md:69) and whether marketing consent gates a pitch.

The corrected SQL and TS apply the policy fix, the wording, the column grants with matching postflight checks, the view-count caveat and the full test-update list.

- **proposal sql_migration: match_pitches_insert, the share-link clause (and the matching comment on match_pitches.share_link_id)** — MEDIUM, NEW. The policy checks that a named link is in the caller's org, is a proposal, is for this contact, and is live (`s.kind = 'proposal' and s.contact_id = match_pitches.contact_id and s.revoked_at is null and s.expires_at > now()`). It never checks that the link shows THIS property. So an aal2 member writing to PostgREST directly can record a pitch of property X that cites their proposal for property Y. The app can produce the same row: createShareLink hands back a link whose curation was not confirmed (lib/actions/share-links.ts:174 `if (!curation.confirmed) notices.push(LINK_CONTENT_UNCONFIRMED_NOTICE);`), and the pitch would then cite a link that may show nothing. Either way the card reports the other link's views as this pitch's "opened N×", and the `match_pitched` payload pairs a property_id with a share_link_id that does not carry it. The impact is bounded to an internal record and needs no unusual preconditions.
  - Fix: Inside the share_links EXISTS, add `and exists (select 1 from public.share_link_properties slp where slp.share_link_id = s.id and slp.property_id = match_pitches.property_id)`. share_link_properties_select is org-wide through its parent (0147:446-449), and authenticated holds SELECT on it (0023:93), so the invoker policy can see the rows. A link whose curation did not land is then refused with 42501, and the action already reports that as PITCH_NOT_RECORDED_NOTICE. Add a test-10 case: a live proposal for this contact that does not include this property answers 42501. Applied in the corrected SQL.
- **proposal server_action_ts: the EVENT_LINES.match_pitched delta (`"matchPitched": "Sent a matching property"`), plus the table comment and header ("prepared and opened in WhatsApp")** — MEDIUM, NEW. pitchMatchedBuyer inserts the row, and so the event, BEFORE the agent clicks the "Open WhatsApp"/"Open e-mail" anchor (the sketch's two-click flow). The row therefore proves neither that the chat was opened nor that anything was sent. Yet the timeline line says "Sent a matching property". describeEvent lines are rendered in the commission evidence report, and that report includes the contact's own events (lib/services/evidence.ts:264 `{ type: "contact", ids: narrowed ? [] : [opts.contactId] },`). So an unsent pitch would read there as an introduction that happened. The proposal's own header says the row is "NOT a delivery receipt".
  - Fix: Use the word PREPARED everywhere. Messages: events.matchPitchPrepared "Prepared a pitch of a matching property" and matchPitchPreparedChannel "Prepared a pitch of a matching property ({channel})", with el/ru from a reader of each language. Table and function comments should say "the link was minted and the message built — not opened, not sent". The card label should read "Pitch prepared <date> · <channel>". Applied in both corrected texts.
- **proposal rls_tests item 15 ("contact-links-org-isolation.test.ts: the key onto contacts is organisation-bound" under "Catalogue tests stay green") and COMPANION CHANGES** — MEDIUM, NEW (CI would catch it, so the impact is bounded). Three existing tests pin the exact set of links onto contacts and go RED once 0148 adds match_pitches_org_contact_fkey. The plan says the first stays green and does not list the third:
- supabase/tests/contact-links-org-isolation.test.ts:268 and :349 `expect(await keysOnContacts()).toEqual(KEYS_0139);` ("all thirteen keys onto contacts").
- supabase/tests/contact-merge-org-isolation.test.ts:434 "the live links onto contacts are exactly the ones the action repoints", an exact 13-entry list. Item 16 adds a behaviour row but not this list.
- lib/actions/merge-contacts-org-scope.test.ts:195 `expect(rec.chains).toHaveLength(2 + 1 + REPOINTS.length + 1);`, which fails as soon as merge-contacts.ts gains a repoint and REPOINTS (:139-154) does not.
  - Fix: In the same PR:
- add `{ rel: "match_pitches", conname: "match_pitches_org_contact_fkey", def: "FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id) ON DELETE CASCADE", convalidated: true }` to the expected keys, as a 0148 list beside KEYS_0139;
- add "match_pitches.contact_id" to the merge precondition list;
- add `["match_pitches", "contact_id", []]` to REPOINTS.
Listed in the corrected TS.
- **proposal scope/queries: the card's "opened N×" from share_links.view_count via the latestPitchesByContact embed** — MEDIUM, NEW, PLAUSIBLE: the client behaviour was not measured. resolve_share_link counts every successful GET of /p/<token>: it increments view_count, sets first_opened_at and writes the once-a-day `opened` line (0146:368-372 `set view_count = view_count + 1, first_opened_at = coalesce(first_opened_at, now()), last_opened_at = now()`). WhatsApp builds link previews on the sender's device, so a prefilled wa.me draft probably fetches the link from the agent's phone before anything is sent. Mail link scanners can do the same. A pitch that was never sent could then show "opened 1×", and the buyer-view `opened` evidence line would be written by the agent's own phone. Agents who paste links by hand already hit this; this slice turns it into the pitch's displayed outcome. Nothing in BACKLOG or DECISIONS records it.
  - Fix: Measure first on the local stack with a real WhatsApp draft. Until then, show the field as "link views (include link previews)" or leave counts out of slice 1. The corrected TS renames it linkViews and carries the caveat. Add a BACKLOG line about preview fetches counting as opens.
- **proposal sql_migration: `grant select, insert on public.match_pitches to authenticated;`** — LOW/hygiene, KNOWN_OPEN. Table-level INSERT lets a session send its own `id`. A primary key is checked across all organisations, so 23505 `match_pitches_pkey` answers whether pitch id X exists in any org. This is the BACKLOG entry "A client-chosen primary key is an existence oracle on every table users insert into" (docs/BACKLOG.md:3128), which names "column-level INSERT grants that omit `id`" as the fix. Purely theoretical here: the ids are random, and an attacker learns existence only, never content.
  - Fix: `grant insert (org_id, property_id, contact_id, channel, share_link_id, created_by) on public.match_pitches to authenticated;` plus table-level SELECT. id and created_at then always come from their defaults. postgrest-js sends only the keys present (insert() adds no `columns` for a single object; node_modules/@supabase/postgrest-js 2.110.2 index.mjs:2916-2928), so the action is unaffected. The postflight reads column privileges. Applied in the corrected SQL; test 5 gains "an explicit id answers 42501".
- **proposal scope "WHY A TABLE AND NOT EVENTS ONLY" and the migration header** — LOW. The stated premise is incomplete. events_select hides a colleague's line only on a SESSION client. Timelines already read events as the service role, bounded by org (doc 04:83 "timeline pages assemble via server actions with service role"; lib/services/entity-timeline.ts:2 `import { createAdminClient }`), and match-alerts asks "as the system" too (match-alerts.ts:223-242). So events could answer the question. What they cannot do is answer it cheaply by PROPERTY: events_entity_idx is `(org_id, entity_type, entity_id, occurred_at)` (0063:298) and the property sits only in the payload.
  - Fix: Restate the rationale: the table is the index from property to pitch, and it does not depend on payload JSON. Visibility is not the reason. No code change; corrected in the SQL header.
- **proposal server_action_ts: pitchMatchedBuyer reads `id, phone_e164, has_whatsapp, email, languages, is_archived, erased_at` but not consent** — DECISION REQUIRED, NEW (no BACKLOG or DECISIONS entry on gating outbound messages by consent). contacts.consent_marketing exists (lib/supabase/database.types.ts:218 `consent_marketing: boolean`) and nothing reads it before a pitch. A prefilled listing pitch by e-mail or WhatsApp may be direct marketing under the ePrivacy rules unless the buyer's own saved search covers it. The proposal raises this (open question 3); it is a landing blocker, not a code defect.
  - Fix: The operator decides before landing. If pitches are gated, add `and c.consent_marketing` to the policy's contacts EXISTS and a matching refusal in the action (at least for 'email'), then record the decision in DECISIONS. Either way, record in the erasure spec that ids-only pitch rows stay on a redacted contact. The corrected TS marks the hook.
- **proposal STATUS / open question 1; HANDOFF.md:2003; CLAUDE.md:69** — PROCESS. This is new scope against the standing decision (HANDOFF.md:2003 "Build nothing new — stabilise and let the desk use it") and CLAUDE.md:69 "Never invent scope. If a nice-to-have occurs to you, add a line to docs/BACKLOG.md instead of building it." The proposal says so itself. One citation slips: the zero buyer_requirements fact is at HANDOFF.md:766 (2026-09-07), not :783, and it is dated.
  - Fix: Add a BACKLOG line only, until the operator names the work. Fix the citation.
- **proposal COMPANION CHANGES (deltas for share-links.ts, merge-contacts.ts, events.ts, messages, merge-repoints-every-fk.test.ts) and the client sketch** — LOW/PROCESS. CLAUDE.md:55 says "Complete files only. When modifying, output/write the entire file — no fragments". There is also a third minting surface: tests/unit/one-time-secret-notices.test.ts:134-142 pins "shows the notice beside the minted link and toasts it" for exactly the two existing minting pages. pitch-buyer-button.tsx would mint a one-time link without that guard.
  - Fix: Write each touched file whole when implementing. Add ["properties", "pitch-buyer-button.tsx"] to that it.each, adapting its state-variable regex.
- **proposal sql_migration ROLLBACK note ("Rolling the DATABASE back first fails closed")** — LOW. This holds for the action's insert, where PGRST205 is in certainlyRolledBack's allowlist (rpc-outcome.ts:22). It does not hold for the card. latestPitchesByContact uses unwrapRows, which throws on any error (unwrap.ts:29-35), and MatchingBuyersCard renders inline in the property page (app/(app)/properties/[id]/page.tsx:744). So a rolled-back table, or any transient failure of that read, takes the page to its error boundary rather than just losing the badge.
  - Fix: State it in the rollback note. Alternatively, read pitches in a separate try/catch that degrades to "pitch history unavailable", which is still loud and is not painted as "none".

## RLS tests (doc 04 row + `supabase/tests/match-pitches.test.ts`)

DOC 04 MATRIX ROW, added after share_link_properties

| match_pitches | A AG LM (own org) | A AG LM, restricted: `created_by = uid`, `created_at = now()`; the contact is the caller's org's and is live (not archived, not erased); a named `share_link_id` is the caller's org's live, unexpired `proposal` for that same contact | No session access. service_role: `contact_id` only (contact merge) | No session access | 0148: a pitch the desk prepared and opened (wa.me / mailto:), not a delivery receipt. Ids and an enum only. `(org_id, property_id) → properties` and `(org_id, contact_id) → contacts` (org_id, id) ON DELETE CASCADE. `share_link_id → share_links(id)` ON DELETE SET NULL, single-column, bound by the policy. The AFTER INSERT invoker trigger writes `match_pitched` on the contact in the same transaction. service_role: SELECT (the backup export). |

NEW FILE supabase/tests/match-pitches.test.ts. Real aal2 sessions of two throwaway organisations, as in share-link-tenant-binding.test.ts.

1. SELECT is org-wide:
   - An A, an AG and an LM of org A each read every org-A pitch, including one written by a colleague.
   - Org B's admin reads 0 org-A rows.
2. aal1 session (require_aal2):
   - SELECT returns 0 rows.
   - INSERT answers 42501.
3. anon: SELECT and INSERT answer 42501 (no grant at all).
4. INSERT happy path (AG, own org, live contact, own property, share_link_id null):
   - Answers 201.
   - Exactly ONE `match_pitched` event: entity_type 'contact', entity_id = contact, actor = the agent, occurred_at = the row's created_at.
   - The payload key set is exactly {pitch_id, property_id, channel, share_link_id}.
5. INSERT with `created_by` = a colleague answers 42501. INSERT with `created_at` in the past answers 42501.
6. INSERT with `org_id` = org B answers 42501.
7. INSERT naming org B's contact from an org-A session answers 42501, and so does a random missing contact id. Same answer for both, so no existence oracle.
8. INSERT naming org B's property or a missing property answers 23503 `match_pitches_org_property_fkey`, the same for both.
9. INSERT for an archived contact (including a merged duplicate) answers 42501. INSERT for an erased contact answers 42501.
10. share_link_id binding, each answering 42501:
    - another contact's proposal;
    - org B's link;
    - a revoked link;
    - an expired link;
    - an `availability` link.
    A live proposal minted for this contact answers 201, and its event carries the share_link_id.
11. channel = 'telegram' answers 23514 `match_pitches_channel_check`.
12. PATCH and DELETE by A, AG and LM are refused (no grant: 42501). Nothing changes.
13. service_role:
    - UPDATE of contact_id to another org-A contact succeeds.
    - UPDATE of contact_id to org B's contact answers 23503.
    - UPDATE of channel / property_id / created_by answers 42501.
    - INSERT and DELETE answer 42501.
    - SELECT succeeds.
14. Atomicity: in a rolled-back transaction where the event write is refused (for example the session's events_insert fails), no match_pitches row remains. Postgres-level: assert that every match_pitches row has exactly one match_pitched event naming its pitch_id.
15. Catalogue tests stay green:
    - rls_aal2_coverage() is empty.
    - rls_bare_helper_calls() and rls_bare_auth_calls() return nothing for match_pitches.
    - rls_hoisted_policy_count() still reads 21.
    - aal1-definer-boundary.test.ts: the trigger function is an invoker and needs no exemption.
    - primary-key-immutable.test.ts: no API role holds UPDATE on match_pitches.id.
    - insert-id-history.test.ts: not a history subject (its line is on the contact).
    - contact-links-org-isolation.test.ts: the key onto contacts is organisation-bound.
    - backup-export-keys.test.ts: PRIMARY_KEYS match_pitches = ["id"].
    - tests/unit/merge-repoints-every-fk.test.ts: after the table-constraint regex is added, it lists match_pitches.contact_id with its org-bounded repoint.
16. contact-merge-org-isolation.test.ts gains a row: merging D into P moves D's pitches onto P. Org B's pitches are never touched.
17. Erasure (erasure-lifecycle.test.ts):
    - Erasing a contact with pitches completes (the contact is redacted, not deleted, so the key never blocks it), and the pitch rows remain with ids only.
    - A new pitch to the erased contact answers 42501.
18. Cascades (service role, rolled back):
    - Deleting the property deletes its pitches.
    - Deleting the share link sets share_link_id to null and keeps the pitch.

## Conventions followed

Migration shape (all under D:/dev/TSOPOZIDIS/.worktrees/gnk-crm/audit-1017/supabase/migrations)
- 0147_hoist_remaining_rls_helpers.sql:
  - header sections: GAP, FIX, CONTRACT, LOCKS, PREFLIGHT, SELF-CHECK, ROLLBACK, Pins;
  - `set local lock_timeout = '5s'` with the one-transaction DO check (:97-107);
  - the fixed `set local search_path` for pg_get_expr (:100);
  - LOCK taken inside the preflight DO with organizations last (:117-124);
  - grants read as privileges, never as ACL text (:222-247);
  - the closing one-row summary (:616-621);
  - every helper written `(select …)`, which rls_bare_helper_calls has checked schema-wide since 0147.
- 0146_share_link_tenant_binding.sql:
  - policy checks via pg_get_expr on pg_policy with `polroles = array[0::oid]`, and the "only permissive policy for its command" check (:221-253);
  - binding a single-column key with a policy instead of a composite key, "WHY POLICIES, NOT COMPOSITE KEYS" (:84-88).
- 0142_atomic_unit_type_apply.sql:
  - the newest table-creating migration: `revoke all … from public, anon, authenticated, service_role`; `grant select, insert` to authenticated and select to service_role (:225-227);
  - created_by with no FK, bound by the policy (:202, :232-235);
  - composite key onto properties (org_id, id) ON DELETE CASCADE (:208-209);
  - names-free preflight (:163-188) and grants postflight (:619-632).
- 0043_buyer_requirements.sql:
  - RLS-enabled table with policies hoisted as `(select public.current_org_id())` (:115-131);
  - the require_aal2 restrictive shape (:138-141);
  - revoke before grant (:102-109);
  - self-check DO block and comments;
  - no score column (:14-19).
- 0094_interaction_notes.sql:
  - an AFTER INSERT invoker trigger writes the event as the caller (:132-146);
  - `revoke execute` on the trigger function (:160-161);
  - table comment style.
- 0138_system_event_types.sql:176: the events_insert text pinned in the preflight.
- 0088:172 and 0123:192 (properties_org_id_id_key, contacts_org_id_id_key), 0139 (the composite-key idiom onto contacts), 0128 (`occurred_at = now()` becomes `created_at = now()`).
- 0063_partition_events.sql:312-315: events_select is why a table is needed.

Action and service shape (all under D:/dev/TSOPOZIDIS/.worktrees/gnk-crm/audit-1017/lib)
- actions/share-links.ts:
  - "use server", a zod schema with z.guid();
  - getCurrentProfile then RLS re-reads;
  - a local refuse() and errors returned, not thrown;
  - the "committed" boundary comment;
  - notices handed back with the secret, never withholding it (T-one-time-secrets, :27-40, :159-192);
  - certainlyRolledBack and the 201-only success (:56-75).
- actions/buyer-requirements.ts:
  - the contact re-read under RLS before writing;
  - events on the CONTACT;
  - revalidating both surfaces (:30-34, :63-68).
- actions/leads.ts:920-936 (logChatLinkOpened) and components/features/shared/chat-links.tsx:40-53: the wa.me digits rule and the has_whatsapp gate.
- actions/merge-contacts.ts:137-222: the repoint list, org-bounded, run as the service role.
- services/match-alerts.ts:223-242: ask the database, not the reader.
- services/matching.ts:194: matchProperty, the shared engine.
- queries/matches.ts:60-63: the candidate columns.
- validators/ids.ts: z.guid, never z.uuid.
- services/contact-reread.ts: CONTACT_UNAVAILABLE and CONTACT_CHECK_FAILED.
- supabase/rows.ts (rowsOf) and supabase/unwrap.ts (unwrapRows).
- services/rpc-outcome.ts: certainlyRolledBack.
- services/one-time-secrets.ts: joinNotices; notice constants live outside "use server" files.
- services/events.ts: EVENT_LINES registration.

Other pins
- components/features/share-links/minted-link.tsx:35: the origin is the client's.
- D:/dev/TSOPOZIDIS/.worktrees/gnk-crm/audit-1017/tests/unit/merge-repoints-every-fk.test.ts:51-57: why its regex must be widened.
- D:/dev/TSOPOZIDIS/.worktrees/gnk-crm/audit-1017/scripts/backup/export-tables.mjs:11-80: TABLES and PRIMARY_KEYS.
- D:/dev/TSOPOZIDIS/.worktrees/gnk-crm/audit-1017/docs/04_RLS_POLICY_MATRIX.md: the row format.

## Migration 0148 (reviewed text)

```sql
-- =============================================================================
-- 0148 — a pitch prepared for a matched buyer is a record the whole desk can
--        see: match_pitches (T-match-pitch, 2026-10-17; add-on #1 slice 1 —
--        NEW SCOPE: lands only on the operator's go-ahead, HANDOFF.md:2003)
--
-- WHAT IS MISSING (read at origin/main 99c3bad):
--
--   * The property page ranks the buyers whose saved searches fit a listing
--     (findMatchingBuyers, lib/queries/matches.ts; MatchingBuyersCard) and
--     the match alerts raise one task per property (lib/services/
--     match-alerts.ts), but nothing records that a buyer was pitched. The agent
--     opens WhatsApp from the contact page (ChatLinks: wa.me with no text),
--     types the message, and the only trace is a `chat_link_opened` line
--     whose payload is `{ channel }` — no property.
--   * The events cannot answer the desk's question by PROPERTY. "Has anyone
--     already pitched this buyer this listing?" is a question about the
--     ORGANISATION. On a session's client events_select (0063) shows an agent
--     or a listing manager only the lines they wrote; the timelines read
--     events as the service role (doc 04, events row), but "which buyers were
--     pitched THIS property" would then be a payload scan of the
--     organisation's events: events_entity_idx is (org_id, entity_type,
--     entity_id, occurred_at) and the property is not the entity. A proposal
--     link minted for the buyer (share_links.contact_id +
--     share_link_properties) records a link, not a pitch, nor its channel.
--
-- THE FIX — one append-only table written by the session, its event written
-- by the database:
--
--   A. public.match_pitches — one row per pitch the desk PREPARED for a
--      matched buyer: the proposal link was minted and a WhatsApp (wa.me
--      click-to-chat with a prefilled text) or e-mail (mailto:) message was
--      built. The row is written BEFORE the agent opens the chat, so it
--      records neither that the chat was opened nor that anything was sent:
--      the agent sends from their own phone or mail client (doc 01 §10 —
--      "WhatsApp Business API | Click-to-chat until Phase 3"). The property,
--      the buyer, the channel, the proposal link that carried it (when one
--      did), who and when. Ids and an enum only — no text, no number, no
--      address. NO SCORE COLUMN (0043, T-B5): the match is recomputed on read.
--   B. Organisation-wide SELECT for every member — the point of the table is
--      that every screen gives the same answer. INSERT for every member
--      (createShareLink's posture: any agent may already put any listing in
--      front of any buyer), bound to the caller (`created_by = auth.uid()`,
--      and `created_at = now()` — 0128's rule for a session's events), to a
--      LIVE contact of the caller's organisation (not archived — a merged
--      duplicate is archived — and not erased: BACKLOG "Sessions can still
--      attach records to an erased contact" is not repeated on a new table),
--      and, when a link is named, to a live proposal link of the caller's
--      organisation FOR THAT BUYER THAT SHOWS THAT PROPERTY
--      (share_link_properties). authenticated may INSERT six columns only —
--      org_id, property_id, contact_id, channel, share_link_id, created_by:
--      `id` and `created_at` always come from their defaults, so BACKLOG "A
--      client-chosen primary key is an existence oracle…" is not repeated on
--      a new table. No UPDATE and no DELETE for a session. The service role
--      may read (the backup export) and change `contact_id` only (the contact
--      merge repoints it, lib/actions/merge-contacts.ts).
--   C. Keys: (org_id, property_id) -> properties (org_id, id) (0088's key) and
--      (org_id, contact_id) -> contacts (org_id, id) (0123's key), both ON
--      DELETE CASCADE — a pitch is nothing without either, and neither is
--      deleted in normal use (doc 04: DELETE denied on both). share_link_id
--      is a single-column key onto share_links(id), ON DELETE SET NULL:
--      share_links has no (org_id, id) key and adding one is the composite-
--      key series' business (0146, WHY POLICIES) — the INSERT policy binds it
--      for sessions, its only writers.
--   D. trg_match_pitches_after_insert — AFTER INSERT, SECURITY INVOKER, so
--      events_insert binds its line exactly as it binds the app's: one
--      `match_pitched` event on the CONTACT (the buyer's timeline, as 0043's
--      requirement lines are), actor = created_by, payload { pitch_id,
--      property_id, channel, share_link_id } — ids and an enum. Its timeline
--      line says "prepared", never "sent" (the commission evidence report
--      renders contact events). The row and its line commit together or not
--      at all: no pitch exists that the chain does not know about, through the
--      app or a direct PostgREST insert (0094's interaction_notes precedent),
--      and no new "throws after a commit" site is added.
--
-- WHY NOT A COLUMN ON share_links: a pitch need not carry a link, a link is
-- not a pitch, and share_links' write policies are pinned by 0146.
--
-- CONTRACT. New table, trigger and trigger function; no existing object
-- changes; no release-compat entry. The deployed app neither reads nor writes
-- the table, so this is NOT deploy-coupled: hosted 0148 first, then merge.
-- lib/supabase/database.types.ts regenerated.
--
-- VISIBLE CHANGES FOR A DIRECT POSTGREST CALLER: a new table, readable by
-- every member of the organisation (aal2) and insertable as in B (an insert
-- carrying `id` or `created_at` answers 42501).
--
-- LOCKS. CREATE TABLE ... REFERENCES takes SHARE ROW EXCLUSIVE on each table
-- it references: writers of properties, contacts, share_links and
-- organizations wait for the milliseconds to commit (readers do not; the
-- public share page's view-count UPDATE does). All four are taken FIRST, in
-- ONE statement inside the preflight, organizations last (0147's order
-- argument). A writer holding one of them and wanting another can still
-- 40P01 against this file: lock_timeout 5 s, and a 55P03 or a 40P01 keeps
-- nothing — apply again, and do NOT write the ledger row. Apply as 0131 /
-- 0147 did: outside 02:55-04:05 UTC, away from 06:00, at the middle of an odd
-- minute that is not a multiple of five. ONE transaction (checked below).
--
-- PREFLIGHT refuses, changing nothing, unless: the names are free (the table,
-- the trigger function); share_link_properties exists; 0088's
-- properties_org_id_id_key and 0123's contacts_org_id_id_key are unique
-- constraints; comm_channel holds 'whatsapp' and 'email'; events_insert is
-- exactly 0138's check (read under the fixed search_path) and the only
-- permissive INSERT policy on events — the trigger's line must be one a
-- session may write, and `match_pitched` is not reserved;
-- rls_hoisted_policy_count() reads 21.
--
-- POSTFLIGHT (same transaction): RLS on; exactly the three policies, of their
-- commands and kinds, the INSERT check carrying its contact, link and
-- property bindings; rls_aal2_coverage() empty; no bare helper or auth call
-- on the table (0147's / 0100's guards); rls_hoisted_policy_count() still 21;
-- the grants read as PRIVILEGES, never as ACL text (the 0147 lesson) — anon
-- nothing, authenticated SELECT + INSERT of exactly the six columns,
-- service_role SELECT and UPDATE of contact_id only; the four keys with their
-- delete actions; the channel check; the four indexes (one partial); the
-- trigger's shape; the function invoker, owned by postgres, with its
-- search_path, EXECUTE held by no API role.
--
-- NOT DONE HERE (BACKLOG lines in the same change): the alert task does not
-- list its buyers and pitching does not close it; a buyer's "not for me" is
-- not recorded, so the alerts may raise them again (slice 2: a disposition
-- the alerts read); no mandate trigger and no "> 5%" threshold (both
-- contradict recorded design: match-alerts.ts "deliberately no minimum
-- drop"; becameMatchable keys on property status); no Telegram (t.me cannot
-- prefill a message to a user); no consent gate (OPERATOR DECISION: if
-- pitches require contacts.consent_marketing, the contacts EXISTS below gains
-- `and c.consent_marketing`); share_links.view_count counts link-preview
-- fetches as opens (unmeasured — BACKLOG). Erasure needs no step: a row holds
-- ids only and the contact row survives its erasure (a redaction, not a
-- delete), like share_links.contact_id and the events; the INSERT policy
-- refuses a new pitch to an erased contact.
--
-- ROLLBACK, a forward migration in ONE transaction, ONLY after the app is back
-- on a release that neither reads nor writes the table: drop the trigger, the
-- function and the table (supabase/tests/revert-0148.ts is that SQL). The
-- `match_pitched` lines stay on the chain (append-only) and keep rendering
-- (their EVENT_LINES entry stays). Rolling the DATABASE back first: the
-- action's insert answers PGRST205 (certainlyRolledBack) and hands back the
-- link with "the pitch could not be recorded", but the card's read throws
-- (unwrapRows) and takes the property page to its error boundary.
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count 147 -> 148, a grants row); scripts/backup/export-tables.mjs
-- (TABLES, PRIMARY_KEYS); lib/supabase/database.types.ts;
-- lib/actions/merge-contacts.ts (the repoint) and
-- lib/actions/merge-contacts-org-scope.test.ts (REPOINTS, the chain count at
-- :195); tests/unit/merge-repoints-every-fk.test.ts (it reads inline
-- `references contacts` only; this table's composite key is a table
-- constraint); supabase/tests/contact-links-org-isolation.test.ts (the exact
-- key list at :268 / :349 gains match_pitches_org_contact_fkey);
-- supabase/tests/contact-merge-org-isolation.test.ts (the exact link list at
-- :434 gains match_pitches.contact_id); docs/04_RLS_POLICY_MATRIX.md (a row).
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3), as does one
-- execute_sql call; applied hosted inside the md5-guarded DO (DECISIONS
-- T-unit-type-apply-atomic). The file's LAST result is a one-row summary.
-- =============================================================================

set local lock_timeout = '5s';
-- pg_get_expr's output depends on the session's search_path: pin and compare
-- under the FIXED path local and hosted both use (0138's idiom)
set local search_path = "$user", public, extensions;

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0148 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preflight: the names are free, and what the table and its trigger count on
-- is in place
-- ---------------------------------------------------------------------------
do $$
declare
  v_check text;
begin
  -- the locks CREATE TABLE ... REFERENCES needs, first, in ONE statement —
  -- organizations LAST (header, LOCKS)
  lock table public.properties, public.contacts, public.share_links, public.organizations
    in share row exclusive mode;

  if to_regclass('public.match_pitches') is not null then
    raise exception '0148 aborted: match_pitches already exists — nothing was changed';
  end if;
  if exists (select 1 from pg_proc p
              where p.pronamespace = 'public'::regnamespace and p.proname = 'trg_match_pitches_after_insert') then
    raise exception '0148 aborted: a function named trg_match_pitches_after_insert already exists — nothing was changed';
  end if;
  if to_regclass('public.share_link_properties') is null then
    raise exception '0148 aborted: share_link_properties (0023) is missing — nothing was changed';
  end if;

  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.properties'::regclass and c.conname = 'properties_org_id_id_key'
                    and c.contype = 'u')
     or not exists (select 1 from pg_constraint c
                     where c.conrelid = 'public.contacts'::regclass and c.conname = 'contacts_org_id_id_key'
                       and c.contype = 'u') then
    raise exception '0148 aborted: properties_org_id_id_key (0088) or contacts_org_id_id_key (0123) is missing — nothing was changed';
  end if;

  if (select count(*) from pg_enum e
       where e.enumtypid = 'public.comm_channel'::regtype and e.enumlabel in ('whatsapp', 'email')) <> 2 then
    raise exception '0148 aborted: comm_channel does not hold both whatsapp and email — nothing was changed';
  end if;

  -- the trigger's line must be one a session may write: events_insert is
  -- exactly 0138's check, and the only permissive INSERT policy on events
  select pg_get_expr(p.polwithcheck, p.polrelid) into v_check
    from pg_policy p
   where p.polrelid = 'public.events'::regclass and p.polname = 'events_insert' and p.polcmd = 'a';
  if v_check is distinct from
     '((org_id = ( SELECT current_org_id() AS current_org_id)) AND (actor_id = ( SELECT auth.uid() AS uid)) AND (NOT ((entity_type = ''deal''::text) AND (event_type = ANY (ARRAY[''won''::text, ''lost''::text, ''won_override''::text])))) AND (event_type <> ''stage_changed''::text) AND (event_type <> ALL (ARRAY[''erased''::text, ''retention_purged''::text])) AND (event_type <> ALL (ARRAY[''enquiry_alert''::text, ''lead_escalation''::text, ''opened''::text])) AND (occurred_at = now()))' then
    raise exception '0148 aborted: events_insert''s check is not 0138''s (%) — nothing was changed', coalesce(v_check, 'missing');
  end if;
  if (select count(*) from pg_policy p
       where p.polrelid = 'public.events'::regclass and p.polpermissive and p.polcmd in ('a', '*')) <> 1 then
    raise exception '0148 aborted: events_insert is not the only permissive INSERT policy on events — nothing was changed';
  end if;

  if public.rls_hoisted_policy_count() <> 21 then
    raise exception '0148 aborted: rls_hoisted_policy_count() reads %, not 21 — nothing was changed', public.rls_hoisted_policy_count();
  end if;

  raise notice '0148: preflight passed — names free, both organisation keys present, events_insert is 0138''s';
end $$;

-- ---------------------------------------------------------------------------
-- A. the table
-- ---------------------------------------------------------------------------
create table public.match_pitches (
  id            uuid        primary key default gen_random_uuid(),
  org_id        uuid        not null references public.organizations(id),
  property_id   uuid        not null,
  contact_id    uuid        not null,
  channel       public.comm_channel not null,
  -- the proposal link that carried the pitch; null when it carried none
  share_link_id uuid        references public.share_links(id) on delete set null,
  created_by    uuid        not null,
  created_at    timestamptz not null default now(),
  -- the two channels with a prefilled click-to-send link: wa.me ?text= and
  -- mailto: (t.me cannot prefill a message to a user)
  constraint match_pitches_channel_check check (channel in ('whatsapp', 'email')),
  -- the listing and the buyer are the organisation's own (the composite keys,
  -- 0088 / 0123's idiom); the record goes with either
  constraint match_pitches_org_property_fkey
    foreign key (org_id, property_id) references public.properties (org_id, id) on delete cascade,
  constraint match_pitches_org_contact_fkey
    foreign key (org_id, contact_id) references public.contacts (org_id, id) on delete cascade
);

-- the property page's card: every pitch of one listing, newest first
create index match_pitches_property_idx
  on public.match_pitches (org_id, property_id, created_at desc);
-- the buyer's side, the contact key's cascade and the merge's repoint
create index match_pitches_contact_idx
  on public.match_pitches (org_id, contact_id, created_at desc);
-- the link key's ON DELETE SET NULL and the card's embed; a null never needs finding
create index match_pitches_share_link_idx
  on public.match_pitches (share_link_id) where share_link_id is not null;

comment on table public.match_pitches is
  '0148. One row per pitch the desk PREPARED for a matched buyer: the proposal link was minted and a WhatsApp (wa.me with '
  'a prefilled text) or e-mail (mailto:) message was built. Written before the agent opens the chat: it records neither '
  'that the chat was opened nor that anything was sent (doc 01 §10, click-to-chat). The property, the buyer, the channel, '
  'the proposal link that carried it, who and when. Ids and an enum only. Organisation-wide SELECT, so every member sees '
  'who was already pitched; INSERT of six columns bound to the caller, a live contact and that buyer''s own live proposal '
  'link that shows the property; no session UPDATE or DELETE (service_role: SELECT, and UPDATE of contact_id for the '
  'contact merge). The AFTER INSERT trigger writes the match_pitched event on the contact. No score column — matches are '
  'computed on read (0043).';
comment on column public.match_pitches.share_link_id is
  'The proposal link minted for this pitch (createShareLink). Single-column key, ON DELETE SET NULL; the INSERT '
  'policy binds it to a live proposal of the same organisation, for the same contact, whose share_link_properties '
  'include this property.';

-- ---------------------------------------------------------------------------
-- B. grants and RLS
-- ---------------------------------------------------------------------------
alter table public.match_pitches enable row level security;

-- hosted's default privileges hand a new table to anon / authenticated /
-- service_role; the local CLI's do not — state the grants either way (0040's
-- REVOKE-before-GRANT rule, 0142's form)
revoke all on public.match_pitches from public, anon, authenticated, service_role;
grant select on public.match_pitches to authenticated;
-- six columns only: id and created_at always come from their defaults, so a
-- session cannot choose a key (BACKLOG "A client-chosen primary key is an
-- existence oracle…") or a time
grant insert (org_id, property_id, contact_id, channel, share_link_id, created_by)
  on public.match_pitches to authenticated;
-- the backup export reads every table as service_role; the contact merge
-- (service role) moves a duplicate's pitches onto the primary — that column only
grant select on public.match_pitches to service_role;
grant update (contact_id) on public.match_pitches to service_role;

-- every member of the organisation: "who was already pitched" is the
-- organisation's fact, not the reader's (a session's events_select would hide
-- a colleague's line)
create policy match_pitches_select on public.match_pitches for select
  using (org_id = (select public.current_org_id()));

create policy match_pitches_insert on public.match_pitches for insert
  with check (
    org_id = (select public.current_org_id())
    and created_by = (select auth.uid())
    -- a pitch is recorded when it happens (0128's rule for a session's events);
    -- the column is not insertable either — this holds if a grant ever widens
    and created_at = now()
    -- the buyer is a live contact of the caller's organisation: not archived
    -- (a merged duplicate is archived) and not erased
    and exists (select 1 from public.contacts c
                 where c.id = match_pitches.contact_id
                   and c.org_id = (select public.current_org_id())
                   and not c.is_archived
                   and c.erased_at is null)
    -- a link, when named, is a live proposal of this organisation FOR THIS
    -- buyer that SHOWS THIS property (a link whose curation did not land, or
    -- a proposal of another listing, cannot be recorded as this pitch)
    and (share_link_id is null
         or exists (select 1 from public.share_links s
                     where s.id = match_pitches.share_link_id
                       and s.org_id = (select public.current_org_id())
                       and s.kind = 'proposal'
                       and s.contact_id = match_pitches.contact_id
                       and s.revoked_at is null
                       and s.expires_at > now()
                       and exists (select 1 from public.share_link_properties slp
                                    where slp.share_link_id = s.id
                                      and slp.property_id = match_pitches.property_id)))
  );

-- A TABLE CREATED AFTER 0029 DOES NOT INHERIT require_aal2 (0043 / 0094);
-- rls_aal2_coverage() must stay empty
create policy require_aal2 on public.match_pitches
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));

-- ---------------------------------------------------------------------------
-- C. the event is the database's: written in the pitch's own transaction
-- ---------------------------------------------------------------------------
create function public.trg_match_pitches_after_insert()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  -- Runs as the caller (SECURITY INVOKER): events_insert binds actor_id to
  -- auth.uid(), and match_pitches_insert binds created_by to exactly that, so
  -- a session cannot file a pitch, or its line, under anyone else's name.
  -- Ids and an enum only (T-event-typed-text-shape): the reference, the
  -- buyer's name, number and address never enter the chain. The line means
  -- "prepared" (the row is written before the chat is opened), never "sent".
  insert into public.events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (new.org_id, new.created_by, 'contact', new.contact_id, 'match_pitched',
          jsonb_build_object('pitch_id',      new.id,
                             'property_id',   new.property_id,
                             'channel',       new.channel::text,
                             'share_link_id', new.share_link_id));
  return new;
end $fn$;

comment on function public.trg_match_pitches_after_insert() is
  '0148. AFTER INSERT on match_pitches, SECURITY INVOKER: writes one match_pitched event on the contact '
  '(actor = created_by; payload pitch_id, property_id, channel, share_link_id) in the pitch''s transaction, so no '
  'pitch exists that the chain does not know about. The line records a PREPARED pitch, not a sent one. Fired by the '
  'trigger, never called: EXECUTE held by no API role.';

create trigger match_pitches_after_insert
  after insert on public.match_pitches
  for each row execute function public.trg_match_pitches_after_insert();

-- fired by the trigger, never called: strip the PUBLIC =X a new function
-- carries and whatever a default privilege added (0094 / 0133)
revoke execute on function public.trg_match_pitches_after_insert() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Postflight: abort rather than land a half-shaped table
-- ---------------------------------------------------------------------------
do $$
declare
  n      int;
  v_diag text;
begin
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.match_pitches'::regclass) then
    raise exception '0148 postflight: RLS is not enabled on match_pitches';
  end if;

  -- exactly the three policies, each of its command and kind
  select count(*) into n from pg_policy p where p.polrelid = 'public.match_pitches'::regclass;
  if n <> 3 then
    raise exception '0148 postflight: expected 3 policies on match_pitches, found %', n;
  end if;
  if (select count(*) from pg_policy p
       where p.polrelid = 'public.match_pitches'::regclass
         and ((p.polname = 'match_pitches_select' and p.polcmd = 'r' and p.polpermissive
               and p.polroles = array[0::oid] and p.polwithcheck is null)
           or (p.polname = 'match_pitches_insert' and p.polcmd = 'a' and p.polpermissive
               and p.polroles = array[0::oid] and p.polqual is null)
           or (p.polname = 'require_aal2' and p.polcmd = '*' and not p.polpermissive
               and p.polroles = array['authenticated'::regrole::oid]))) <> 3 then
    raise exception '0148 postflight: the policies on match_pitches are not the three this file wrote';
  end if;
  -- the INSERT check carries its bindings (structural: the deparsed text is
  -- read under the fixed search_path, not pinned byte for byte)
  select pg_get_expr(p.polwithcheck, p.polrelid) into v_diag
    from pg_policy p
   where p.polrelid = 'public.match_pitches'::regclass and p.polname = 'match_pitches_insert';
  if v_diag is null
     or v_diag !~ 'created_at = now\(\)'
     or v_diag !~ 'is_archived'
     or v_diag !~ 'erased_at IS NULL'
     or v_diag !~ 'share_links'
     or v_diag !~ 'share_link_properties' then
    raise exception '0148 postflight: match_pitches_insert lost a binding: %', coalesce(v_diag, 'missing');
  end if;

  select count(*) into n from public.rls_aal2_coverage();
  if n <> 0 then
    raise exception '0148 postflight: rls_aal2_coverage() lists % table(s)', n;
  end if;
  if exists (select 1 from public.rls_bare_helper_calls() g where g.tablename = 'match_pitches')
     or exists (select 1 from public.rls_bare_auth_calls() a where a.tablename = 'match_pitches') then
    raise exception '0148 postflight: a match_pitches policy calls a helper or auth function bare';
  end if;
  if public.rls_hoisted_policy_count() <> 21 then
    raise exception '0148 postflight: rls_hoisted_policy_count() reads %, not 21', public.rls_hoisted_policy_count();
  end if;

  -- grants, read as PRIVILEGES (never as ACL text — 0147)
  if has_table_privilege('anon', 'public.match_pitches', 'select, insert, update, delete, truncate, references, trigger')
     or has_any_column_privilege('anon', 'public.match_pitches', 'select, insert, update, references')
     or has_table_privilege('authenticated', 'public.match_pitches', 'insert, update, delete, truncate, references, trigger')
     or not has_table_privilege('authenticated', 'public.match_pitches', 'select')
     or has_table_privilege('service_role', 'public.match_pitches', 'insert, update, delete, truncate, references, trigger')
     or not has_table_privilege('service_role', 'public.match_pitches', 'select') then
    raise exception '0148 postflight: match_pitches table grants are wrong';
  end if;
  -- column by column: authenticated inserts exactly the six; nothing updates
  -- but the service role's contact_id
  select string_agg(a.attname, ', ' order by a.attnum) into v_diag
    from pg_attribute a
   where a.attrelid = 'public.match_pitches'::regclass and a.attnum > 0 and not a.attisdropped
     and ((has_column_privilege('authenticated', a.attrelid, a.attnum, 'insert')
             <> (a.attname in ('org_id', 'property_id', 'contact_id', 'channel', 'share_link_id', 'created_by')))
          or has_column_privilege('authenticated', a.attrelid, a.attnum, 'update, references')
          or (has_column_privilege('service_role', a.attrelid, a.attnum, 'update') <> (a.attname = 'contact_id'))
          or has_column_privilege('service_role', a.attrelid, a.attnum, 'insert, references'));
  if v_diag is not null then
    raise exception '0148 postflight: a column of match_pitches is granted beyond this file''s grants: %', v_diag;
  end if;

  -- the four keys, each with its delete action
  if (select count(*) from pg_constraint c
       where c.conrelid = 'public.match_pitches'::regclass and c.contype = 'f'
         and c.convalidated and not c.condeferrable
         and ((c.conname = 'match_pitches_org_property_fkey' and c.confrelid = 'public.properties'::regclass and c.confdeltype = 'c')
           or (c.conname = 'match_pitches_org_contact_fkey'  and c.confrelid = 'public.contacts'::regclass   and c.confdeltype = 'c')
           or (c.conname = 'match_pitches_share_link_id_fkey' and c.confrelid = 'public.share_links'::regclass and c.confdeltype = 'n')
           or (c.conname = 'match_pitches_org_id_fkey' and c.confrelid = 'public.organizations'::regclass and c.confdeltype = 'a'))) <> 4
     or (select count(*) from pg_constraint c
          where c.conrelid = 'public.match_pitches'::regclass and c.contype = 'f') <> 4 then
    raise exception '0148 postflight: match_pitches does not carry exactly its four keys';
  end if;
  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.match_pitches'::regclass and c.conname = 'match_pitches_channel_check'
                    and c.contype = 'c') then
    raise exception '0148 postflight: match_pitches_channel_check is missing';
  end if;

  -- the primary key and the three indexes, one of them partial
  select count(*) into n from pg_index i where i.indrelid = 'public.match_pitches'::regclass;
  if n <> 4 then
    raise exception '0148 postflight: expected 4 indexes on match_pitches, found %', n;
  end if;
  if not exists (select 1 from pg_index i join pg_class ic on ic.oid = i.indexrelid
                  where i.indrelid = 'public.match_pitches'::regclass
                    and ic.relname = 'match_pitches_share_link_idx' and i.indpred is not null) then
    raise exception '0148 postflight: match_pitches_share_link_idx is missing or not partial';
  end if;

  -- the trigger: the only non-internal one, AFTER INSERT FOR EACH ROW, enabled, no WHEN
  if (select count(*) from pg_trigger t
       where t.tgrelid = 'public.match_pitches'::regclass and not t.tgisinternal) <> 1
     or not exists (select 1 from pg_trigger t
                     where t.tgrelid = 'public.match_pitches'::regclass
                       and t.tgname = 'match_pitches_after_insert'
                       and t.tgfoid = 'public.trg_match_pitches_after_insert()'::regprocedure
                       and t.tgenabled = 'O' and not t.tgisinternal
                       and (t.tgtype & 1) = 1      -- FOR EACH ROW
                       and (t.tgtype & 2) = 0      -- AFTER
                       and (t.tgtype & 4) = 4      -- INSERT
                       and (t.tgtype & 56) = 0     -- not DELETE / UPDATE / TRUNCATE
                       and (t.tgtype & 64) = 0     -- not INSTEAD OF
                       and t.tgqual is null) then
    raise exception '0148 postflight: match_pitches_after_insert is not the AFTER INSERT row trigger this file attached';
  end if;

  -- the function: invoker, owned by postgres, its search_path, callable by no API role
  if not exists (select 1 from pg_proc p
                  where p.oid = 'public.trg_match_pitches_after_insert()'::regprocedure
                    and not p.prosecdef
                    and pg_get_userbyid(p.proowner) = 'postgres'
                    and p.proconfig = array['search_path=public, pg_temp']
                    and p.prorettype = 'trigger'::regtype)
     or has_function_privilege('anon', 'public.trg_match_pitches_after_insert()', 'execute')
     or has_function_privilege('authenticated', 'public.trg_match_pitches_after_insert()', 'execute')
     or has_function_privilege('service_role', 'public.trg_match_pitches_after_insert()', 'execute') then
    raise exception '0148 postflight: trg_match_pitches_after_insert is not this file''s invoker function, or an API role may execute it';
  end if;

  raise notice '0148: postflight passed — match_pitches live (3 policies, 4 keys, 4 indexes, 1 trigger); match_pitched written by the database';
end $$;

-- for the CLI: a one-row summary (a guarded hosted apply discards it)
select format('0148 applied — match_pitches: %s policies, %s indexes, %s keys; rls_aal2_coverage: %s; bare helper calls schema-wide: %s; list-table hoisted count: %s',
              (select count(*) from pg_policy p where p.polrelid = 'public.match_pitches'::regclass),
              (select count(*) from pg_index i where i.indrelid = 'public.match_pitches'::regclass),
              (select count(*) from pg_constraint c where c.conrelid = 'public.match_pitches'::regclass and c.contype = 'f'),
              (select count(*) from public.rls_aal2_coverage()),
              (select count(*) from public.rls_bare_helper_calls()),
              public.rls_hoisted_policy_count()) as summary;
```

## Server action and companion code (reviewed sketch)

Per CLAUDE.md guardrail 9, every touched file is written whole when this is implemented; the blocks below are the sketch to build from.

```ts
// =============================================================================
// lib/services/match-pitch.ts — PURE (no Supabase, no node:*, no next-intl):
// imported by the client button and the action. Tested in match-pitch.test.ts.
// Both imports below are client-safe (matching.ts is pure; share-links.ts
// "MUST STAY FREE OF node:* IMPORTS" by its own header).
// =============================================================================
import {
  matchProperty,
  type MatchCandidate,
  type MatchRequirement,
  type MatchVerdict,
} from "@/lib/services/matching";
import { SHARE_LOCALES, type ShareLocale } from "@/lib/services/share-links";

/**
 * Pitching a matched buyer (0148, T-match-pitch).
 *
 * CLICK-TO-SEND, NEVER SENT BY US. doc 01 §10: "WhatsApp Business API |
 * Click-to-chat until Phase 3". The agent's own WhatsApp / mail client opens
 * with the text filled in; they read it and press send. The text is a FIXED
 * template — no AI drafting (doc 01 §12.6) — and it names no person and no
 * price: the proposal page shows the price in the buyer's language, and stays
 * right if the price moves.
 *
 * WHAT THE RECORD MEANS: the match_pitches row (and its `match_pitched` line)
 * is written when the link is minted and the message is built — BEFORE the
 * agent opens the chat. It says "prepared", never "opened" or "sent".
 */

export const PITCH_CHANNELS = ["whatsapp", "email"] as const; // = match_pitches_channel_check
export type PitchChannel = (typeof PITCH_CHANNELS)[number];

/** The pitch's row was certainly NOT written (certainlyRolledBack). The link still comes back (T-one-time-secrets). */
export const PITCH_NOT_RECORDED_NOTICE =
  "The link was created, but the pitch could not be recorded, so this buyer will not show as pitched on the property. Send it, then tell an admin.";
/** The pitch's row may or may not be there. */
export const PITCH_UNCONFIRMED_NOTICE =
  "The link was created, but recording the pitch could not be confirmed. Reload the property before pitching this buyer again.";

/** The proposal page's language: the first of the buyer's languages it speaks, else English. */
export function pitchLocale(languages: readonly string[] | null | undefined): ShareLocale {
  for (const l of languages ?? []) {
    const code = l.trim().toLowerCase();
    if ((SHARE_LOCALES as readonly string[]).includes(code)) return code as ShareLocale;
  }
  return "en";
}

/** The best verdict among a buyer's ACTIVE searches — the shared engine (T-B5), never a second copy. */
export function bestMatch(
  requirements: readonly MatchRequirement[],
  property: MatchCandidate,
): MatchVerdict | null {
  let best: MatchVerdict | null = null;
  for (const req of requirements) {
    const v = matchProperty(req, property);
    if (v.eligible && (!best || v.score > best.score)) best = v;
  }
  return best;
}

/** wa.me wants digits only (ChatLinks' rule: `phoneE164?.replace(/^\+/, "")`), E.164 length. */
export function whatsappDigits(phoneE164: string | null | undefined): string | null {
  const digits = phoneE164?.replace(/^\+/, "") ?? "";
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

/** One address, with nothing in it that would end or re-split mailto:'s address part. */
export function mailtoAddress(email: string | null | undefined): string | null {
  const e = email?.trim() ?? "";
  return /^[^\s?&#@%,]+@[^\s?&#@%,]+$/.test(e) ? e : null;
}

export function pitchText(reference: string, url: string): string {
  return `Hello — a property that matches what you are looking for: ${reference}. Details and photos: ${url}`;
}

export interface PitchTarget {
  channel: PitchChannel;
  /** wa.me digits, or the e-mail address */
  to: string;
  reference: string;
  /** the proposal link's PATH (/p/<token>) — the origin is the browser's, as MintedLink builds it */
  path: string;
}

export function pitchHref(target: PitchTarget, origin: string): string {
  const text = pitchText(target.reference, `${origin}${target.path}`);
  if (target.channel === "whatsapp") {
    return `https://wa.me/${target.to}?text=${encodeURIComponent(text)}`;
  }
  return `mailto:${target.to}?subject=${encodeURIComponent(`Property ${target.reference}`)}&body=${encodeURIComponent(text)}`;
}

// =============================================================================
// lib/actions/match-pitches.ts
// =============================================================================
"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createShareLink } from "@/lib/actions/share-links";
import { getCurrentProfile } from "@/lib/services/auth";
import { CONTACT_CHECK_FAILED, CONTACT_UNAVAILABLE } from "@/lib/services/contact-reread";
import type { MatchCandidate, MatchRequirement } from "@/lib/services/matching";
import {
  PITCH_CHANNELS,
  PITCH_NOT_RECORDED_NOTICE,
  PITCH_UNCONFIRMED_NOTICE,
  bestMatch,
  mailtoAddress,
  pitchLocale,
  whatsappDigits,
  type PitchTarget,
} from "@/lib/services/match-pitch";
import { joinNotices } from "@/lib/services/one-time-secrets";
import { certainlyRolledBack } from "@/lib/services/rpc-outcome";
import { DEFAULT_EXPIRY_DAYS } from "@/lib/services/share-links";
import { rowsOf } from "@/lib/supabase/rows";
import { createClient } from "@/lib/supabase/server";
import { RETIRED_PROPERTY_VISIBILITY } from "@/lib/validators/properties";

/**
 * Prepare one matched buyer's pitch of one listing (0148, T-match-pitch).
 *
 * ORDER, and why: every READ first, under RLS, so a refusal changes nothing;
 * then the link (createShareLink — the one place a token is minted; its
 * `created` line is its own); then the pitch row, whose AFTER INSERT trigger
 * writes `match_pitched` in the same transaction (no logEvent here, so no
 * "throws after a commit" site). Once the link exists its token lives only in
 * this return value: a pitch row that fails is a NOTICE beside the link,
 * never a reason to withhold it (T-one-time-secrets).
 *
 * No role gate, as createShareLink has none: any agent may already put any
 * listing in front of any buyer. The database binds the rest
 * (match_pitches_insert: the caller, a live contact, and that buyer's live
 * proposal that SHOWS this property — so a link whose curation did not land
 * is refused there and answered as PITCH_NOT_RECORDED_NOTICE). The INSERT
 * grant covers six columns: never send `id` or `created_at`.
 *
 * OPERATOR DECISION PENDING (consent): contacts.consent_marketing is not read.
 * If pitches are gated on it, select it below, refuse here, and add
 * `and c.consent_marketing` to match_pitches_insert's contacts EXISTS.
 */

export type PitchActionState = {
  error: string | null;
  /** the proposal link's path — shown ONCE (only its hash is stored, 0023) */
  path: string | null;
  /** what the client builds the wa.me / mailto: link from; null on a refusal */
  pitch: PitchTarget | null;
  /** the link exists but its record is not certain — shown beside it */
  notice: string | null;
  savedAt: number | null;
};

const refuse = (error: string): PitchActionState => ({ error, path: null, pitch: null, notice: null, savedAt: null });

const pitchSchema = z.object({
  property_id: z.guid(), // z.guid(), NEVER z.uuid() (lib/validators/ids.ts; T-external-audit-2026-10-14)
  contact_id: z.guid(),
  channel: z.enum(PITCH_CHANNELS),
});
export type PitchMatchedBuyerInput = z.input<typeof pitchSchema>;

// MatchCandidate's columns (lib/queries/matches.ts CANDIDATE_COLUMNS) + what the refusals read
const PROPERTY_COLUMNS =
  "id, reference, kind, visibility, status, transaction_type, property_type, district_id, area_id, " +
  "asking_price, rent_price_month, bedrooms, bathrooms, covered_area_sqm, plot_area_sqm, " +
  "title_deed_status, vat_status, sea_distance_m, delivery_date, features";

// MatchRequirement's sixteen fields (lib/services/matching.ts:42-59)
const REQUIREMENT_COLUMNS =
  "transaction_type, property_types, district_ids, area_ids, budget_min, budget_max, bedrooms_min, " +
  "bedrooms_max, bathrooms_min, covered_area_min_sqm, plot_area_min_sqm, title_deed_required, " +
  "vat_preference, max_sea_distance_m, delivery_by, features_required";

type PitchProperty = MatchCandidate & { reference: string; kind: string; visibility: string };

export async function pitchMatchedBuyer(input: PitchMatchedBuyerInput): Promise<PitchActionState> {
  const parsed = pitchSchema.safeParse(input);
  if (!parsed.success) return refuse(parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // 1. the listing, as the caller SEES it
  const propertyRes = await supabase.from("properties").select(PROPERTY_COLUMNS).eq("id", d.property_id).maybeSingle();
  if (propertyRes.error) return refuse("Could not check that property just now — please try again.");
  const property = propertyRes.data as unknown as PitchProperty | null;
  if (!property) return refuse("That property is no longer available to you.");
  if (property.kind === "project" || property.kind === "phase") {
    return refuse("A project or a phase is not something a buyer buys — pitch one of its units.");
  }
  if (property.visibility === RETIRED_PROPERTY_VISIBILITY) return refuse("That listing is retired.");

  // 2. the buyer, as the caller sees it (contacts_select is organisation-wide)
  const contactRes = await supabase
    .from("contacts")
    .select("id, phone_e164, has_whatsapp, email, languages, is_archived, erased_at")
    .eq("id", d.contact_id)
    .maybeSingle();
  if (contactRes.error) return refuse(CONTACT_CHECK_FAILED);
  const contact = contactRes.data;
  if (!contact) return refuse(CONTACT_UNAVAILABLE);
  if (contact.erased_at) return refuse("This contact's personal data was erased — they cannot be pitched.");
  if (contact.is_archived) return refuse("This contact is archived.");

  // 3. where the pitch goes — ChatLinks' rule for WhatsApp (a number AND has_whatsapp;
  //    has_whatsapp is NOT NULL DEFAULT false, 0001:129)
  const to =
    d.channel === "whatsapp"
      ? contact.has_whatsapp
        ? whatsappDigits(contact.phone_e164)
        : null
      : mailtoAddress(contact.email);
  if (!to) {
    return refuse(
      d.channel === "whatsapp"
        ? "This contact has no WhatsApp number recorded — tick WhatsApp on the contact, or pitch by e-mail."
        : "This contact has no usable e-mail address.",
    );
  }

  // 4. the match, recomputed now — a stale card must not pitch a buyer it no longer fits
  let requirements: MatchRequirement[];
  try {
    requirements = rowsOf(
      await supabase
        .from("buyer_requirements")
        .select(REQUIREMENT_COLUMNS)
        .eq("contact_id", contact.id)
        .eq("is_active", true)
        .order("id"),
      "the buyer's saved searches",
    ) as unknown as MatchRequirement[];
  } catch {
    return refuse("Could not read this buyer's saved searches just now — please try again.");
  }
  if (!bestMatch(requirements, property)) {
    return refuse("None of this buyer's active saved searches matches this listing now.");
  }

  // 5. the link — createShareLink re-checks the property and the contact under
  //    RLS, writes its own `created` line, and revalidates /share-links
  const link = await createShareLink({
    property_ids: [property.id],
    contact_id: contact.id,
    locale: pitchLocale(contact.languages),
    title: property.reference,
    expiry_days: DEFAULT_EXPIRY_DAYS,
  });
  if (link.error || !link.path) return refuse(link.error ?? "The link could not be created.");

  // ---- committed: the link exists, and its token is in this function alone ----
  const notices: string[] = link.notice ? [link.notice] : [];
  // six columns, exactly the INSERT grant (0148): id and created_at are the defaults'
  const res = await supabase.from("match_pitches").insert({
    org_id: profile.orgId,
    property_id: property.id,
    contact_id: contact.id,
    channel: d.channel,
    share_link_id: link.linkId ?? null, // NEW field on ShareLinkActionState (below)
    created_by: profile.id,
  });
  if (res.error) {
    const refused = certainlyRolledBack(res.error.code);
    console.error("[match-pitches] link minted, pitch not recorded", {
      propertyId: property.id,
      code: res.error.code,
      refused,
    });
    notices.push(refused ? PITCH_NOT_RECORDED_NOTICE : PITCH_UNCONFIRMED_NOTICE);
  } else if (res.status !== 201) {
    // 201 Created is an insert's only success (T-log-event-hollow)
    notices.push(PITCH_UNCONFIRMED_NOTICE);
  }

  revalidatePath(`/properties/${property.id}`);
  revalidatePath(`/contacts/${contact.id}`);
  return {
    error: null,
    path: link.path,
    pitch: { channel: d.channel, to, reference: property.reference, path: link.path },
    notice: joinNotices(notices),
    savedAt: Date.now(),
  };
}

// =============================================================================
// lib/queries/match-pitches.ts — the card's "already pitched" read (no id list:
// T-worklist-id-lists; a unique order: T-list-page-order; loud: T-null-answer-guard)
// =============================================================================
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { unwrapRows } from "@/lib/supabase/unwrap";

export const PITCH_READ_CAP = 500;

export interface PitchSummary {
  channel: "whatsapp" | "email";
  /** when the pitch was PREPARED (not sent — the row is written before the chat opens) */
  createdAt: string;
  createdBy: string;
  /**
   * share_links.view_count — every successful GET of the link (0146:368-372),
   * INCLUDING link-preview fetches (WhatsApp builds previews on the sender's
   * device; mail scanners fetch too — unmeasured, BACKLOG). Render as "link
   * views", never as "the buyer opened it". null when no link.
   */
  linkViews: number | null;
  linkLastOpenedAt: string | null;
}

/** The latest pitch per buyer for one listing. `capped` = more pitches than were read. */
export async function latestPitchesByContact(
  supabase: SupabaseClient<Database>,
  propertyId: string,
): Promise<{ byContact: Map<string, PitchSummary>; capped: boolean }> {
  // NB unwrapRows throws to the page's error boundary on any failure — including
  // a rolled-back table (PGRST205). That is loud by design (T-null-answer-guard).
  const rows = unwrapRows(
    await supabase
      .from("match_pitches")
      .select("contact_id, channel, created_at, created_by, share_links(view_count, last_opened_at)")
      .eq("property_id", propertyId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(PITCH_READ_CAP),
    "match pitches",
  );
  const byContact = new Map<string, PitchSummary>();
  for (const r of rows) {
    if (byContact.has(r.contact_id)) continue;
    const l = r.share_links as { view_count: number; last_opened_at: string | null } | null;
    byContact.set(r.contact_id, {
      channel: r.channel as PitchSummary["channel"],
      createdAt: r.created_at,
      createdBy: r.created_by,
      linkViews: l?.view_count ?? null,
      linkLastOpenedAt: l?.last_opened_at ?? null,
    });
  }
  return { byContact, capped: rows.length >= PITCH_READ_CAP };
}

// =============================================================================
// lib/actions/share-links.ts — DELTA (the only change to an existing action;
// written as the COMPLETE file when implemented, CLAUDE.md:55)
// =============================================================================
// export type ShareLinkActionState = {
//   error: string | null;
//   path: string | null;
//   /** the link's id — never a secret; lets a caller record what carried it (0148) */
//   linkId: string | null;
//   savedAt: number | null;
//   notice: string | null;
// };
// const refuse = (error: string): ShareLinkActionState =>
//   ({ error, path: null, linkId: null, savedAt: null, notice: null });
// ...createShareLink / createAvailabilityLink success:
//   return { error: null, path: shareLinkPath(token), linkId: link.id, savedAt: Date.now(), notice: joinNotices(notices) };
// Tests that toEqual a full state gain `linkId: null`: lib/actions/contact-link-reread.test.ts:300, :311, :319.

// =============================================================================
// lib/actions/merge-contacts.ts — DELTA (in the `repoints` list; service role,
// org-bounded, the shape tests/unit/merge-repoints-every-fk.test.ts reads)
// =============================================================================
//    admin
//      .from("match_pitches")
//      .update({ contact_id: primaryId })
//      .eq("org_id", orgId)
//      .eq("contact_id", duplicateId),

// =============================================================================
// tests/unit/merge-repoints-every-fk.test.ts — DELTA (inside foreignKeysToContacts,
// after the CREATE TABLE column scan): keys declared as a TABLE CONSTRAINT
// =============================================================================
//    for (const m of sql.matchAll(/create table (?:if not exists )?(?:public\.)?([a-z_]+)\s*\(([\s\S]*?)\n\);/gi)) {
//      for (const c of m[2].matchAll(/foreign key\s*\(\s*org_id\s*,\s*([a-z_]+)\s*\)\s*references\s+(?:public\.)?contacts\b/gi)) {
//        found.set(`${m[1]}.${c[1]}`, { table: m[1], column: c[1] });
//      }
//    }

// =============================================================================
// CATALOGUE TESTS THAT GO RED WITH 0148 — update in the same PR
// =============================================================================
// - lib/actions/merge-contacts-org-scope.test.ts:139-154 REPOINTS gains
//     ["match_pitches", "contact_id", []],
//   (the chain count at :195 is 2 + 1 + REPOINTS.length + 1).
// - supabase/tests/contact-merge-org-isolation.test.ts:434 "the live links onto
//   contacts are exactly…" gains "match_pitches.contact_id" (sorted), and its
//   merge case gains a row: D's pitches move onto P, org B's are untouched.
// - supabase/tests/contact-links-org-isolation.test.ts:268 / :349
//   `toEqual(KEYS_0139)` — the live catalogue now holds a fourteenth key:
//     { rel: "match_pitches", conname: "match_pitches_org_contact_fkey",
//       def: "FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id) ON DELETE CASCADE",
//       convalidated: true }
//   (add it as a 0148 list beside KEYS_0139 so the 0139 assertions keep their meaning).
// - tests/unit/one-time-secret-notices.test.ts:134-142 gains the third minting
//   surface, ["properties", "pitch-buyer-button.tsx"] (its state variable regex adapted).

// =============================================================================
// lib/services/events.ts — DELTA (EVENT_LINES) + messages/{en,el,ru}.json events.*
// =============================================================================
//  // 0148: written by the match_pitches trigger, on the CONTACT, when a pitch is
//  // PREPARED — before the chat is opened. Never "sent": describeEvent lines
//  // render in the commission evidence report, which includes contact events
//  // (lib/services/evidence.ts:264). The reference is not in the payload (ids only).
//  match_pitched: (p, t) => {
//    const channel = asText(p.channel);
//    return channel ? t("matchPitchPreparedChannel", { channel }) : t("matchPitchPrepared");
//  },
//  en.json: "matchPitchPrepared": "Prepared a pitch of a matching property",
//           "matchPitchPreparedChannel": "Prepared a pitch of a matching property ({channel})"
//  (el / ru strings from a reader of each language, as chatOpenedChannel's were)

// =============================================================================
// components/features/properties/pitch-buyer-button.tsx — CLIENT sketch, one per
// MatchingBuyersCard row (rows are per REQUIREMENT, key=requirementId; a buyer
// with two matching searches shows two rows — the badge reads byContact). The
// card passes canWhatsapp / canEmail booleans computed server-side from
// contacts.phone_e164 / has_whatsapp / email added to the findMatchingBuyers select.
// =============================================================================
// "use client";
// const [pending, startTransition] = useTransition();
// const [minted, setMinted] = useState<PitchActionState | null>(null);
// const run = (channel: PitchChannel) => startTransition(async () => {
//   try {
//     const res = await pitchMatchedBuyer({ property_id: propertyId, contact_id: contactId, channel });
//     setMinted(res);
//     if (res.error) toast.error(res.error);
//     if (res.notice) toast.warning(res.notice);
//   } catch {
//     // a rejection is an UNKNOWN outcome: a link may exist (check Share links)
//     toast.error("Could not confirm the pitch — check Share links before pitching this buyer again.");
//   }
// });
// // Two clicks, not one: window.open after an awaited action is popup-blocked,
// // so the result renders an ANCHOR the agent clicks (a user gesture), and the
// // copy-once card for the link itself. The badge reads "Pitch prepared <date>".
// {minted?.path && minted.pitch ? (<>
//   <a href={pitchHref(minted.pitch, window.location.origin)} target="_blank" rel="noopener noreferrer">
//     {minted.pitch.channel === "whatsapp" ? "Open WhatsApp" : "Open e-mail"}
//   </a>
//   <MintedLink path={minted.path} heading="Pitch link" notice={minted.notice} onDone={() => setMinted(null)} />
// </>) : null}

// TESTS TO ADD (vitest): lib/services/match-pitch.test.ts (pitchLocale, bestMatch uses
// matchProperty's eligibility, whatsappDigits / mailtoAddress shapes incl. % and ',',
// pitchHref encodes the text and never the address); lib/actions/match-pitches.test.ts
// (mocked client: every refusal before createShareLink writes nothing; the insert body
// carries exactly the six granted columns; the link is returned when the pitch insert is
// refused (NOT_RECORDED), hollow / 5xx / no code (UNCONFIRMED), 201 (no notice)); add
// pitchMatchedBuyer to lib/actions/malformed-ids.test.ts with GUID_SHAPES.
// supabase/tests/match-pitches.test.ts as proposed, plus: an explicit `id` or `created_at`
// answers 42501; a live proposal for this contact that does NOT include this property
// answers 42501; the match_pitched line renders "Prepared a pitch…" in en/el/ru.
```
