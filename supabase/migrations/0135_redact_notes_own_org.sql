-- =============================================================================
-- 0135 — the nightly enquiry sweep blanks only its own organisation's notes
--
-- THE GAP (BACKLOG "`redact_stale_enquiries` matches interaction notes by
-- `entity_id` with no organisation predicate", found by
-- T-insert-id-without-history's map; re-verified 2026-10-03 on the local
-- stack at 0134 by supabase/tests/redact-notes-own-org.test.ts, pinned RED
-- first — DECISIONS T-redact-notes-own-org has the count):
--
--   * redact_stale_enquiries() (0092; its notes CTE 0094) runs nightly as
--     postgres (cron `redact-stale-enquiries`, `10 3 * * *`). It redacts the
--     message of every website lead with no contact, not converted, older
--     than 24 months, and blanks the interaction notes "on those leads" —
--     matched by `n.entity_type = 'lead' and n.entity_id = done.id` only.
--     Notes outlive their lead (they are keyed by entity_id, no foreign key:
--     a lead a trusted path deleted leaves its notes behind), and a lead id
--     is chosen by the inserting session. So an aal2 admin, agent or listing
--     manager of ANOTHER organisation could INSERT a lead at the id of one of
--     our deleted leads — 0133 lets it through: the history is not theirs, and
--     a refusal would be an oracle on ours — with `source = 'website'`, no
--     contact and a `received_at` 25 months back, and the next night's sweep
--     blanked OUR notes for that id: `body` null, `redacted_at` set — an
--     irreversible cross-tenant write (measured locally through PostgREST).
--     Hosted held 25 orphaned lead ids on 2026-10-03; production was not
--     written (read-only checks and rolled-back probes only).
--   * The function's own two halves already disagreed: the leads half is
--     bounded by the row it redacts (`due` → `done` carry the lead's org_id);
--     only the notes half ignored it.
--
-- THE FIX: the same function, body unchanged but one predicate —
-- `and n.org_id = done.org_id` — so the sweep blanks the notes of the lead it
-- redacted, in that lead's organisation, and nothing else. CREATE OR REPLACE
-- keeps the oid, owner (postgres), SECURITY DEFINER, `search_path = public`,
-- its EXECUTE grants (postgres, service_role — no session role) and the cron
-- job, which calls it by name. The comment is restated with this rule.
--
-- WHY NOT a reader-side fix (refuse the colliding lead at INSERT): 0133
-- deliberately lets a row of one organisation take an id whose history is
-- another's — refusing would tell the inserting organisation that the id has
-- history somewhere (an oracle). The sweep is the reader that matched across
-- organisations, so the sweep is what changes.
--
-- CONTRACT. Cron-only (no app code calls it; tests call it as the service
-- role): no release-compat entry; the signature, the default (24), the return
-- (int, the number of leads redacted) and the event shape are unchanged;
-- database.types.ts regenerates identically. NOT deploy-coupled: hosted 0135
-- first, then merge.
--
-- LOCKS: none on any table (CREATE OR REPLACE FUNCTION locks the function's
-- catalogue row; a sweep already running keeps the old body to its end). ONE
-- transaction (checked below). Apply outside 03:05–03:20 UTC (the sweep) and
-- the usual 02:55–04:05 / 06:00 windows.
--
-- PREFLIGHT refuses, changing nothing, unless redact_stale_enquiries(integer)
-- is exactly 0094's body (its md5 — hosted's read 2026-10-03 is identical),
-- SECURITY DEFINER, owned by postgres, `search_path=public`, and executable by
-- no session role. A body that differs (a hand edit, a later migration) must be
-- read before anything replaces it.
--
-- EXISTING ROWS — READ-ONLY DIAGNOSTIC, NO REPAIR (the file's last row):
--   lead_notes_under_other_orgs_lead   notes whose lead id is held by ANOTHER
--                                      organisation's live lead (the collision
--                                      this closes);
--   of_them_redacted                   of those, notes already redacted — the
--                                      shape a cross-tenant blanking leaves
--                                      (not proof: the note's own lead may
--                                      have been redacted before it was
--                                      deleted). A blanked body cannot be
--                                      recovered from the database.
-- RESOLUTION: an operator decision per counted row, recorded in DECISIONS.
--
-- NOT CHANGED: which leads the sweep redacts; the 24-month period; the event
-- it writes; notes of the lead's own organisation; every other function.
--
-- NOT DONE HERE (BACKLOG): resolve_share_link's once-a-day `opened` throttle
-- counts an event of any organisation for the link id (it can only suppress
-- the inserting organisation's own `opened` line — split out as its own
-- entry: a 12.9k-character function anon calls, for a self-harm-only effect).
--
-- ROLLBACK, a forward migration in one transaction: restore 0094's function
-- text and comment (supabase/tests/revert-0135.ts builds exactly that from
-- 0094's file, and the test file replays it). In the same change: delete the
-- test file and helper; remove the restore pack's 0135 row and move its
-- migrations pin FORWARD; restore the BACKLOG entry. No data moves.
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count, the 0135 SECURITY row).
-- =============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0135 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preflight: the function is exactly what this file was written against
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig constant text := 'public.redact_stale_enquiries(integer)';
  v_md5 text;
begin
  select md5(p.prosrc) into v_md5
    from pg_proc p
   where p.oid = to_regprocedure(v_sig) and p.prosecdef
     and pg_get_userbyid(p.proowner) = 'postgres'
     and p.proconfig = array['search_path=public'];
  if v_md5 is distinct from '044c146a25329a36fb7b89049e2b3ab3' then
    raise exception '0135 aborted: redact_stale_enquiries is not 0094''s definer body (md5 %) — nothing was changed', coalesce(v_md5, 'missing or not the definer it was');
  end if;
  if has_function_privilege('anon', v_sig, 'execute') or has_function_privilege('authenticated', v_sig, 'execute') then
    raise exception '0135 aborted: a session role may execute redact_stale_enquiries — nothing was changed';
  end if;
  raise notice '0135: preflight passed — redact_stale_enquiries is 0094''s definer body, executable by no session role';
end $$;

-- ---------------------------------------------------------------------------
-- The sweep, its notes bounded by the redacted lead's organisation
-- ---------------------------------------------------------------------------
create or replace function public.redact_stale_enquiries(p_months int default 24)
returns int
language plpgsql security definer set search_path = public as $fn$
declare
  v_count int;
begin
  if p_months is null or p_months < 1 then
    raise exception 'redact_stale_enquiries: p_months must be a positive number of months';
  end if;

  with due as (
    select id, org_id
      from leads
     where source = 'website'
       and contact_id is null
       and status in ('new', 'contacted', 'lost', 'spam')
       and received_at < now() - make_interval(months => p_months)
       and message is distinct from '[erased at the contact''s request]'
     for update skip locked
  ),
  done as (
    update leads l
       set message = '[erased at the contact''s request]'
      from due
     where l.id = due.id
    returning l.id, l.org_id
  ),
  -- 0094: the desk's notes about the enquiry go with its message. A
  -- data-modifying CTE runs exactly once whether or not anything reads it.
  -- 0135: only the notes of the redacted lead's own organisation — notes
  -- outlive their lead, and another organisation may hold a lead at its id.
  notes as (
    update interaction_notes n
       set body = null, redacted_at = now()
      from done
     where n.entity_type = 'lead'
       and n.entity_id = done.id
       and n.org_id = done.org_id
       and n.redacted_at is null
    returning n.id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'lead', id, 'redacted',
         jsonb_build_object('reason', 'retention', 'months', p_months)
    from done;

  get diagnostics v_count = row_count;
  return v_count;
end $fn$;

comment on function public.redact_stale_enquiries(int) is
  'Nightly (03:10): redacts leads.message for website enquiries with no linked '
  'contact that did not convert and are older than p_months (default 24 — the '
  'period the public privacy notice states; the site pins the same number), '
  'and blanks the interaction_notes on those leads (0094) — only notes of the '
  'lead''s own organisation (0135: notes outlive their lead, and another '
  'organisation may hold a lead at its id). '
  'One `redacted` event per row with a null actor and a shape-only payload. '
  'Returns the number of rows redacted. A lead with a contact is the contact''s '
  'erasure''s business (0017). Idempotent: an already-redacted row is skipped.';

-- ---------------------------------------------------------------------------
-- Postflight: the shape kept, the predicate present
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig constant text := 'public.redact_stale_enquiries(integer)';
  v_src text;
begin
  select regexp_replace(p.prosrc, '--[^\n]*', '', 'g') into v_src
    from pg_proc p
   where p.oid = to_regprocedure(v_sig) and p.prosecdef
     and pg_get_userbyid(p.proowner) = 'postgres'
     and p.proconfig = array['search_path=public']
     and p.prorettype = 'int4'::regtype;
  if v_src is null then
    raise exception '0135 postflight: redact_stale_enquiries is not the definer owned by postgres with search_path public returning int';
  end if;
  if v_src !~ 'n\.entity_id = done\.id\s+and n\.org_id = done\.org_id' then
    raise exception '0135 postflight: the notes half does not bound the notes by the redacted lead''s organisation';
  end if;
  if has_function_privilege('anon', v_sig, 'execute') or has_function_privilege('authenticated', v_sig, 'execute')
     or not has_function_privilege('service_role', v_sig, 'execute') then
    raise exception '0135 postflight: redact_stale_enquiries'' EXECUTE grants changed';
  end if;
  raise notice '0135: postflight passed — the sweep blanks only the redacted lead''s own organisation''s notes';
end $$;

-- EXISTING ROWS (header) — read-only, nothing repaired; the file's LAST result
select format('lead_notes_under_other_orgs_lead=%s of_them_redacted=%s',
              count(*), count(*) filter (where n.redacted_at is not null)) as existing_rows
  from public.interaction_notes n
  join public.leads l on l.id = n.entity_id
 where n.entity_type = 'lead' and l.org_id <> n.org_id;
