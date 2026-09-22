# Escalation visibility and safe recovery — design (2026-09-22, fifth brief)

Branch `feat/audit-2026-09-22-escalation-visibility-recovery` (worktree
`.worktrees/gnk-crm/audit-e`), migration 0111. Record: DECISIONS
`T-audit-2026-09-22-escalation-visibility-recovery`; operator steps: HANDOFF
row 1h. gnk-web is not involved (both surfaces live in the CRM).

## The question, and the answer

*Can staff see what happened to a lead's escalation e-mail, and can an admin
recover one that stopped?* — **No.** Verified against `7f12eaa` (the brief's
own reference commit; `main` and `origin/main` were still there, clean):

| Observation | Where | Holds? |
|---|---|---|
| The inbox shows a notification status only for `kind = enquiry_desk_alert` | `app/(app)/leads/page.tsx` — `.find((j) => j.kind === "enquiry_desk_alert")` feeding `DeskAlertChip` | yes |
| The staff retry targets only the desk alert | `request_enquiry_alert_retry(p_lead_id)` (0104): `where lead_id = p_lead_id and kind = 'enquiry_desk_alert'` | yes |
| The worker supports `lead_escalation` and deliberately stops some failures for a person | `enquiry-alert-worker.ts` `settle()`: `conflict` and `permanent` are terminal; `scheduleRetry` closes `retry_beyond_window`; the claim closes `key_window_expired` — all "for a decision", and only the desk-alert chip ever offers one | yes |
| No escalation status or recovery control exists | `components/features/leads/` has `desk-alert.tsx` only; no lead detail page; Settings → Lead escalation edits the policy, not jobs | yes |
| The accelerator claims "any due job of this lead, limit 1" | `retryEnquiryAlert` → `runEnquiryAlertWorker({ leadId, limit: 1 })` → `claim_notification_jobs(... p_lead_id)` orders by `next_attempt_at` over BOTH kinds | yes — with an escalation row due, the desk-alert retry could claim the escalation instead |

What already works and is reused unchanged: the outbox row and its state
machine (0101–0104), the claim's lease and key-window closures, the worker's
send-time rechecks for escalations (policy, lead, recipients), the stable
payload per key (finding 2 of the afternoon brief), the events written under
`lead_escalation`, the redaction trigger, the two sweeps.

## Decisions

1. **Recovery is a second SQL function, not a widening of the first.**
   `request_enquiry_alert_retry(p_lead_id)` keeps its signature, body and
   rules (an assignee may retry a desk alert). The escalation gets
   `request_lead_escalation_recovery(p_job_id, p_action, p_reason)`: admin
   only, by the job's immutable id, refusing any other kind.
2. **Two disjoint operations, decided by the row — never by the browser.**
   `retry` reuses the provider key and is permitted only while the key is
   safe to present again (no conflict, not `key_window_expired` /
   `retry_beyond_window`, first attempt inside `notification_key_window()`).
   `resend` rotates the key (a NEW logical send) and is permitted only when
   `retry` is not — so the same row never admits both, the function refuses
   the wrong one with a sentence, and the UI can only ever offer the one the
   database would accept. Nothing rotates a key automatically.
3. **Source states.** `failed`; `sending` with a lapsed lease; `cancelled`
   with a recoverable reason (`escalation_disabled`, `no_recipient` — the
   policy was the problem). Refused: `accepted`; a live lease; `pending`
   (queued or retry scheduled: the worker owns it, and "send it now" is not
   in this brief); `cancelled` because the lead was no longer eligible
   (`lead_answered`, `lead_closed`, `lead_redacted`, `lead_unreadable`,
   `lead_missing`, `org_mismatch`).
4. **Eligibility is re-checked at recovery, in SQL:** the lead is still open
   and unanswered and not redacted; the policy is enabled; at least one
   configured recipient is an active admin/agent of the org with an e-mail
   and is not the lead's assignee. The worker checks all of this again at
   send time, as before.
5. **Concurrency:** the row is locked `for update`; the second of two
   simultaneous requests re-reads a row that is already `pending` (or
   `sending` under the accelerator's lease) and is refused.
6. **Audit:** one `lead_escalation` event `outcome: recovery_requested` with
   `actor_id` = the admin, `action`, `job_id`, `key_serial`, `key_rotated`,
   `previous_state`, `previous_category`, `previous_result`, `reason` (≤ 200
   chars, required for `resend`, optional for `retry`; the dialog says the
   reason goes on the timeline). Ids and words only — no address, no name.
   The insert goes through `trg_events_hash`, so the id is drawn under the
   org's chain lock (0109) and the chain, checkpoints and history are
   untouched.
7. **Exact-job targeting in the claim.** `claim_notification_jobs` gains
   `p_job_id uuid default null` (drop the five-argument function first: a
   second defaulted overload makes PostgREST's four-named-argument call from
   the deployed worker ambiguous — the 0110 lesson). The worker gains
   `jobId`. Both staff actions pass the job id they were given back; the
   enquiry route's `after()` and the sweep are untouched.
8. **UI:** `EscalationChip` beside `DeskAlertChip` on a website lead's row.
   Same tones, same compact chip, status wording from a pure function
   (`escalationStatus`) a test pins. Retry is one click; Review & resend
   opens a dialog that says the provider may already have accepted the
   earlier e-mail, asks for a reason, and only then calls the action.
   Provider acceptance is worded "accepted by the provider", never
   "delivered". Non-admins see the status without the controls (the server
   refuses them anyway). A lead with no escalation row renders nothing.

## Shape

```
inbox row ── EscalationChip ──(admin)──▶ recoverLeadEscalation(jobId, action, reason)
                                              │  caller's session
                                              ▼
                     request_lead_escalation_recovery(p_job_id, p_action, p_reason)
                       admin · aal2 · org · kind · lead eligible · policy on ·
                       recipients · state · key reusable? → pending, event
                                              │  after()
                                              ▼
                     runEnquiryAlertWorker({ leadId, jobId, limit: 1 })
                       claim_notification_jobs(..., p_job_id) → this row only
```

## Status wording (escalationStatus)

| Row | Label | Recovery |
|---|---|---|
| pending, attempts 0 | Escalation queued | none |
| pending, attempts n | Escalation retrying (n of m, last X) — next in N min | none |
| sending, lease live | Escalation sending… | none |
| sending, lease lapsed | Escalation stuck (n of m) — will be picked up | retry |
| accepted | Escalation accepted by the provider (HH:MM) — not a delivery receipt | none |
| failed, conflict | Escalation needs a decision — the provider holds an earlier version of this e-mail and may already have sent it | resend |
| failed, key_window_expired / retry_beyond_window / key older than 20 h | Escalation needs a decision — an earlier attempt may have reached the recipients; the provider key is no longer safe | resend |
| failed, other | Escalation FAILED after n attempts (X) | retry |
| cancelled, escalation_disabled | Escalation cancelled — lead escalation was switched off at send time | retry (once on) |
| cancelled, no_recipient | Escalation cancelled — nobody eligible to receive it (Settings → Lead escalation) | retry (once fixed) |
| cancelled, lead_* / org_mismatch | Escalation cancelled — the enquiry was answered / the lead was closed / the enquiry was redacted / … | none |

Every row also shows the last attempt time where one exists.

## Compatibility and rollout

* 0111 is additive: one new function; the claim's signature gains a defaulted
  sixth parameter (the deployed worker's four named arguments still resolve
  against the single function). Not deploy-coupled; apply before the merge
  per HANDOFF §3. Pins that move: the restore pack's migrations count (111)
  and its grants table (one row); `database.types.ts` regenerated.
* Rollback: drop `request_lead_escalation_recovery(uuid, text, text)`; drop the
  six-argument claim and re-create 0107's five-argument body; the app's
  `jobId` is then an unknown named argument — revert the merge first. Events
  written by recoveries stay (append-only).
* Nothing here activates escalation, sends an e-mail, changes recipients or
  touches production data.

## Tests

* DB (`supabase/tests/lead-escalation-recovery.test.ts`, real stack): a lead
  with both kinds; exact-job claim leaves the other row untouched; agent,
  cross-org and aal1 refused; answered / closed / redacted / policy-off /
  no-recipient refused; live lease and accepted refused; two concurrent
  requests → one transition; a lost answer recovers under the same key and
  clock; conflict and expired keys refuse `retry` and admit `resend` with a
  reason; cancelled reasons recoverable vs not; the event's shape; the chain
  verifies after.
* Unit: `escalationStatus` table; the worker's `p_job_id`; the action's
  contract (rpc args, refusal words, `after()` with `jobId`); the desk-alert
  action now passes `jobId`.
* e2e (`tests/e2e/lead-escalation-recovery.spec.ts`, local only): a website
  lead with a failed desk alert and a conflicted escalation shows both chips;
  Review & resend → reason → the row is pending under key 2 with the event;
  Retry on a 503-failed escalation → pending under the same key; an agent's
  browser sees the status and no controls.
