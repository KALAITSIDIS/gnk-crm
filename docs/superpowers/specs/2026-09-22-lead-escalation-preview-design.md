# Lead escalation activation preview — design (2026-09-22, sixth brief)

Branch `feat/audit-2026-09-22-escalation-preview` (worktree
`.worktrees/gnk-crm/audit-f`), migration 0112. Record: DECISIONS
`T-audit-2026-09-22-escalation-preview`. gnk-web is not involved.

## The question, and the answer

*Was the previous audit right, and what is the next justified improvement?*
Verified against CRM `415bfa3` and site `ce47c4f` — both `main` = `origin/main`,
clean, exactly the commits the previous audit examined; CI run 35744920304
green on `415bfa3`. Local stack at 0111; hosted read-only at 0111.

| Previous finding | Where it lives now | Holds? |
|---|---|---|
| Escalation status beside the desk-alert status | `app/(app)/leads/page.tsx` renders `DeskAlertChip` and `EscalationChip` from the same `notification_jobs` join | fixed |
| Recovery targets the exact job | `request_lead_escalation_recovery(p_job_id, …)` (0111); `claim_notification_jobs(… p_job_id)`; both staff actions pass `jobId` | fixed |
| Safe retries keep the key | 0111 `retry`: `key_serial` unchanged, `first_attempted_at` kept; admitted only while `v_key_safe` | fixed |
| Explicit resends rotate the key and need a reason | 0111 `resend`: `key_serial + 1`, clock and presentation count cleared, `p_reason` required, ≤ 200 chars | fixed |
| Admin, MFA and org boundaries in SQL | 0111: `auth.uid()`, `mfa_satisfied()`, `current_role_gnk() = 'admin'`, the row read `where org_id = current_org_id() for update` | fixed |
| Concurrent recoveries → one transition | `for update` on the row; the second re-reads a pending row and is refused (`lead-escalation-recovery.test.ts` "two simultaneous requests") | fixed |
| Deployment docs record escalation OFF | HANDOFF §0, BACKLOG, DECISIONS all say so; hosted row reads `enabled: false` | holds |
| Settings lacks a preview of affected enquiries and eligible recipients | `lead-escalation-panel.tsx` is the form and the Save button only | **still present** |

No new defect was confirmed in the flow (the verification table is in the
DECISIONS entry). Unit 93/93 across the five escalation files and database
39/39 across the two escalation suites at `415bfa3` on the local stack.

## Options weighed

- **A. A read-only preflight report from existing capabilities.** Produced
  today against hosted (DECISIONS entry): policy OFF, no recipients, two
  active admins with addresses, no jobs, and zero open unanswered website
  enquiries — activating now would mint nothing. It answers for THIS
  minute; the operator activates on a later day with values of their own,
  and every future policy change would need another SQL session.
- **B. A reusable admin preview on Settings → Lead escalation.** The same
  answer, for the values in the form, at the moment of the decision, from
  the same eligibility rule the sweep applies. One migration, one action,
  one card. Chosen — it is what the previous finding asked for, and A is
  its one-off shadow.
- **C. A targeted fix.** Nothing to fix.

## Decisions

1. **One eligibility rule, in one place.** The sweep's `due` CTE moves
   into `lead_escalation_candidates(p_org, p_cfg, p_now)` — every open,
   unanswered, unredacted website lead inside the 0110 index bound, with its
   `due_at` and a `verdict`: `due` (the sweep would mint it), `not_yet_due`,
   `past_cutoff`, `already_escalated`. `raise_lead_escalations` now mints
   `verdict = 'due'` from that function and nothing else changes in it (the
   events, the unique index, the cron command). The preview reads the same
   rows. Two readers, one definition.
2. **The preview is a STABLE SECURITY DEFINER function** —
   `preview_lead_escalation(p_policy jsonb, p_limit int default 50, p_now
   timestamptz default now()) returns jsonb`. STABLE is the structural
   guarantee that it writes nothing: Postgres refuses INSERT/UPDATE inside
   a non-volatile function. Admin, `mfa_satisfied()`, `current_org_id()` —
   the same three gates as the recovery, in the same words. Authenticated-
   callable, so the advisor count moves by one WARN, by design (the 0111
   precedent).
3. **Evaluated as if ON.** The stored row may be OFF and the form may leave
   the box unticked; the question is always "what happens if these values
   are switched on". The answer says so (`evaluated_as_enabled: true`,
   `stored_enabled`).
4. **Recipient coverage is per id and per lead.** Each proposed id: found
   in the caller's org or not, active, admin/agent, an address on file —
   `eligible` with one reason word. Each lead: how many eligible recipients
   remain once its assignee is removed, and whether the ONLY eligible
   recipient is its assignee (the case the worker would cancel as
   `no_recipient` and nobody would understand).
5. **Jobs the sweep would create ≠ e-mails the worker could send.** `due`
   is the first; `would_send` is `due` with at least one eligible
   recipient; `no_recipient` is the difference. The action adds
   `providerArmed` from the environment (`enquiryAlertConfigured()`), because
   an unarmed worker claims nothing however many rows the sweep mints.
6. **Bounded and PII-free.** At most `p_limit` (form: 50, ceiling 200)
   leads, `due` first, then `not_yet_due`, `past_cutoff`,
   `already_escalated`; `truncated` says when the page did not show all.
   A lead is its id, times, status, assignee (a colleague's name), the
   property reference and the recipient count — never the enquirer's name,
   address or message. Staff names already appear on the panel.
7. **The form's values, not a form action.** The Preview button is
   `type="button"`: it reads the form with `FormData`, runs the native
   validity check, and calls the server function inside a transition. A
   `<form action>` or `formAction` would make React reset the uncontrolled
   fields when the action resolves, wiping the proposed values the admin
   just typed. The Save path is untouched.
8. **Stale on change.** Any change to the form after a preview marks it
   stale ("values changed — preview again"); the card also says that
   eligibility moves on its own after the preview (an answer, a closure, a
   redaction, a deactivated colleague, a new enquiry), and that the sweep
   and the worker decide again at their own moment.
9. **The preview's own schema.** `leadEscalationPreviewSchema` is the form
   schema without the "tick at least one person" refinement — a preview
   with nobody ticked is exactly the one that must show every enquiry as
   `no_recipient`. `leadEscalationSchema` (Save) is that schema plus the
   refinement, so the two cannot drift.

## Not done, on purpose

No policy write, no job, no event, no e-mail, no key movement from a
preview. No "activate from the preview" button — Save is the activation
and stays the only one. No digest. No hosted apply, merge, deploy or
activation from this branch.

## Verification plan

- `supabase/tests/lead-escalation-preview.test.ts` (real stack, sessions):
  refusals (agent, aal1 admin, anon, another org), org scope, every
  verdict on fixed dates (weekend, the October daylight-saving switch, the
  cutoff, a queued job), answered/closed/redacted absent, every recipient
  reason, the assignee-only case, the bound and its ordering, agreement
  with `raise_lead_escalations` on the same fixtures and instant, and that
  previewing wrote nothing to policies, leads, jobs or events.
- Unit: the reader of the RPC's document, the preview schema against the
  save schema, the action (mocked client, like the recovery action's test).
- Browser: `tests/e2e/lead-escalation.spec.ts` gains one test — the card
  renders for a fixture enquiry, a changed field marks it stale, the row
  is unchanged and no job exists afterwards.
- Gates: tsc, eslint, the unit tree, the RLS suite's cron pin, the two
  existing escalation suites unchanged.
