# The desk-alert outbox — design (2026-09-21)

Branch `feat/enquiry-alert-outbox`, migration 0101. Record: DECISIONS
`T-enquiry-alert-outbox`; operator steps: HANDOFF 1e; activation: BACKLOG.

## The question, and the answer

*Is the internal e-mail that tells the desk about a new website enquiry
reliably persisted and retryable?* — **No, it was not.** Verified against
`46a1b6f` (gnk-crm) and `ce47c4f` (gnk-web): the enquiry committed inside
`submit_public_enquiry`, the e-mail was one provider call inside the route's
`after()`, the outcome was an event written after the fact, and nothing
persisted the intent before the send or retried after it. A killed
invocation, a provider 503, a lost answer or the platform's own timeout all
ended as a saved lead and a desk never told.

This branch builds the smallest complete answer on the database the project
already has: a transactional outbox.

## The reliability contract, and where each clause is enforced

| Clause | Where |
|---|---|
| Every accepted enquiry requiring a desk alert has a durable delivery record | `notification_jobs`, unique `(lead_id, kind)`; written by the door |
| Lead and record are created in the same transaction | one INSERT inside `submit_public_enquiry`; the migration's self-test refuses the insert and reads no lead |
| Replaying the same enquiry makes no second lead and no second job | the 0096 replay returns before any write; `enquiry-alert-outbox.test.ts` |
| Provider failures never make a committed enquiry look rejected | the send happens after the 202, from a row; the route's answer does not depend on it |
| A process interruption leaves work recoverable | the lease: a `sending` row whose `claimed_until` lapsed is claimable again; the attempt was counted at the claim |
| Temporary failures get bounded retries | `retryDelaySeconds`: 60·2^(n−1) s, cap 1 h, 8 attempts, ~2h07m total; Retry-After honoured up to the cap |
| Permanent failures are visible and actionable | state `failed` → inbox chip "Desk alert FAILED (…)" + **Retry alert**; one `enquiry_alert` event; one Sentry message (shape only) |
| Tenant isolation and staff permissions hold | RLS: org-wide SELECT only, `require_aal2`; every write is a SECURITY DEFINER function; `request_enquiry_alert_retry` checks org, the lead rule, the live lease, the accepted state and redaction in SQL |

## Shape

```
submit_public_enquiry            (0101: + insert notification_jobs, same txn)
        │
        ▼
notification_jobs  pending ──claim──▶ sending ──complete──▶ accepted
                     ▲                  │                    failed
                     └── retry (backoff)┘                    cancelled
```

* **Row**: `org_id`, `lead_id`, `kind`, `state`, `attempts`/`max_attempts`,
  `next_attempt_at`, `claimed_by`/`claimed_until`, `key_serial`,
  `last_category`/`last_result` (a category and a status or provider error
  NAME, never a body), `provider`, `provider_message_id`, timestamps. **No
  person.** The e-mail is rebuilt from the lead at send time
  (`alertFromLead` → `parseWebsiteEnquiry` + `websiteEnquiryBody` +
  the allowlisted keys of `criteria`).
* **Claim** (`claim_notification_jobs`): `for update skip locked` over due
  rows, lease, attempt counted at the claim; optionally narrowed to one lead.
  A lapsed lease with no attempts left is closed `failed` with an event.
* **Complete** (`complete_notification_job`): holder-only. `accepted` keeps
  the provider id; `retry` backs off or, on the last attempt, is terminal;
  `failed`/`cancelled` terminal. Terminal outcomes write the lead's
  `enquiry_alert` event; intermediate retries are state.
* **Retry** (`request_enquiry_alert_retry`): resets to pending with a fresh
  budget, rotates `key_serial` only after a `conflict` or when the first
  attempt is older than 24 h, signs an event with the caller.
* **Erasure**: `trg_cancel_lead_notification_jobs` on `leads.message` →
  the erasure literal cancels a PENDING job with an event. A job mid-send is
  left to its own outcome. The three erasure paths (redactLead, contact
  erasure, the retention sweep) all write the same literal, so one trigger
  covers all three. The worker also re-reads the lead and cancels on a
  redacted or missing one.

## The worker, and who runs it

`runEnquiryAlertWorker(client, {workerId, limit, leadId?})` — claim, rebuild,
one provider attempt under `Idempotency-Key: enquiry-desk-alert/<job>/<serial>`,
complete. Never throws. The rollout guard: a lead whose timeline already has
`enquiry_alert: sent` (the pre-0101 route) is closed `accepted`/`legacy_sender`
without sending.

| Caller | Cadence | Status |
|---|---|---|
| enquiry route `after()` | at once, for that lead | live with the deploy — the accelerator |
| staff **Retry alert** | on demand | live with the deploy |
| `GET\|POST /api/internal/enquiry-alerts` via Vercel cron | daily 06:00 UTC ±59 min (Hobby's maximum) | needs `CRON_SECRET` in Vercel production |
| the same route via `pg_cron` + `pg_net` | every 2 min | needs the operator's `pg_net` decision; prepared in `supabase/activation/0102_enquiry_alerts_cron.sql` |

No in-memory timer stands in for durable scheduling.

## Provider facts relied on (Resend docs, read 2026-09-21)

`Idempotency-Key` ≤ 256 chars, remembered **24 hours**; same key + same
payload → the first response, no second send; same key + different payload
→ 409 `invalid_idempotent_request` (→ `conflict`, terminal, key rotated on
retry); same key in flight → 409 `concurrent_idempotent_requests` (→
transient); default **10 req/s per team**, 429 on excess (→ transient,
Retry-After honoured). A 2xx means **accepted by the provider**; nothing here
confirms delivery, and the words used (`accepted`, "Desk alerted") say so.

## Deployment order, rollback, activation

1. Push the branch (free CI rehearsal). 2. Apply 0101 to hosted per HANDOFF
§3 — **additive**: the door's signature, defaults, return shape and grants
are unchanged, so the deployed route keeps working (`release-compat`
`outbox-door`). 3. Merge; confirm the deploy. 4. `CRON_SECRET` in Vercel +
redeploy. 5. Decide `pg_net`.

*App rollback* (to a meta-door commit): the old `after()` sender resumes;
rows queue pending until the outbox code returns, and the guard closes them.
*DB rollback* (drop the table, trigger and three functions; restore 0098's
door): the deployed worker's claim errors on every enquiry and **nothing
sends**; pending rows are dropped with the table — read them first, do not
roll back with rows pending. *No historical replay*: the table starts empty;
a backfill would be a separate, reviewed selection.

## Limitations, stated

* Acceptance ≠ delivery. Bounces are not read back.
* An ambiguous timeout is retried under the same key, which the provider
  keeps for 24 h. **Reviewed 2026-09-21 (migration 0102):** the schedule
  fitting inside 24 h proved nothing about when a sweep actually runs, so the
  window is now ENFORCED — `notification_key_window()` = 20 h; the claim
  closes a row first attempted outside it for a decision
  (`key_window_expired`), the worker refuses to schedule a retry the window
  cannot hold (`retry_beyond_window`), and Retry-After is honoured in full.
  A manual retry after the window mints a new key with a fresh lifetime and
  could, in the rare case the lost answer was a success, send a second
  e-mail — a person chose that, and the inbox says so before they click.
* A sweep claims only what its 45-second budget fits (four rows at the
  provider's 8-second worst case) and hands back unattempted what a slow
  batch cannot reach (`released`, attempt returned). A failed claim is a
  503 from the sweep, never a 200.
* The rollout guard lives in the claim's transaction (0102); the worker no
  longer reads the events table.
* Until `CRON_SECRET` is set the sweep is inert and the system behaves as
  before 0101 for anything the accelerator misses — except that it is now
  visible ("Desk alert queued") instead of silent.
* The inbox shows the status only for leads created after 0101.
