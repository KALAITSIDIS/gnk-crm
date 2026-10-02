-- =============================================================================
-- 0131 — a deal's stage_changed event records a movement that happened: the
--        database writes it from the row change; a session cannot write one
--
-- THE GAP (external audit brief, 2026-10-01; reproduced the same day against
-- 9913c74 on the local stack at 0130 through PostgREST with aal2 sessions of
-- throwaway organisations, pinned RED first by
-- supabase/tests/stage-movement-authentic.test.ts — 25 of the 49 tests the
-- file then had failed at 0130, each for the reason it names; the 24 that
-- passed are the paths this file must keep; the tests added since by the
-- review pin this file's own refinements):
--
--   * events_insert (0128) refuses a session's `won` / `lost` / `won_override`
--     for a deal and says nothing about `stage_changed`. An aal2 agent POSTed
--     "New → Completed" (real stage ids, real names) for a deal that stayed in
--     New and open: accepted, and report_stage_conversion counted an entry
--     into Completed and a New → Completed transition while the won outcome
--     stayed 0 (measured: moves_total 1 → 2). An admin's plausible
--     "New → Qualified" was accepted the same way — and so was a PEER agent's
--     and a LISTING MANAGER's, who may not even update that deal, and another
--     organisation's admin writing one into ITS OWN chain about this
--     organisation's deal, which that organisation's report then counted
--     (measured). Refused already: aal1, a deactivated profile, anon, and a
--     foreign org_id.
--   * The mirror image: deals_update (0100) restricts ROWS, not columns, and
--     deals_closed_guard (0118) refuses only terminal and foreign-organisation
--     stages. The deal's own agent PATCHed stage_id New → Viewing with
--     stage_entered_at 2001-01-01: the deal moved, NO event was written, and
--     the stage was "entered" in 2001 (measured). An admin PATCHed a sale deal
--     into a RENTAL stage of the organisation: accepted, no event (measured;
--     move_deal_to_stage refuses that move).
--   * move_deal_to_stage (0067) is SECURITY INVOKER and inserted its event
--     with the caller's permissions, so events_insert could not simply refuse
--     a session's stage_changed without breaking the kanban.
--
-- THE DESIGN — the event is DERIVED from the change, by the database:
--
--   B. An AFTER UPDATE row trigger on deals, deals_stage_changed_event, writes
--      the deal's stage_changed whenever an OPEN deal's stage_id changes and
--      the deal stays open in the same organisation (a maintenance move to
--      another organisation is not a pipeline movement; a session cannot
--      make one — deals_update pins org_id). Its function is SECURITY DEFINER (owner postgres,
--      search_path public, pg_temp, EXECUTE revoked from every role — like
--      trg_supersede_deal_nudges, 0020's AFTER UPDATE trigger on the same
--      table that already writes events this way). Everything in the event
--      comes from authoritative context: OLD.stage_id / NEW.stage_id (the row
--      version this UPDATE actually replaced — under the row lock, so the
--      previous stage is the one really left, however the writes race), the
--      stage names read in the deal's own organisation, NEW.org_id, NEW.id,
--      and auth.uid() for the actor (null = the system, as for every
--      maintenance write). Nothing the caller sends reaches the payload. The
--      payload is 0067's shape exactly: from / to (names; the stage id as
--      text when no stage of the deal's organisation has that id, as 0067's
--      coalesce did) and from_stage_id / to_stage_id (uuid strings) — what
--      report_stage_conversion (0130) and the timeline renderer read.
--   A. events_insert refuses a session's `stage_changed` — for a deal, and
--      under ANY other entity_type too (nothing but this trigger writes the
--      type, and describeEvent renders it by type alone: a session's
--      `stage_changed` on entity_type 'Deal' or 'offer' printed "Stage New →
--      Completed" in the admin feed — measured by the review at this file's
--      first draft). 0128's terminal clause, 0071's hoisted clauses and
--      0128's occurred_at are kept verbatim. RLS binds only sessions: the
--      trigger (a definer), the service role (imports, restores) and postgres
--      still write it.
--   C. move_deal_to_stage keeps everything that decides WHETHER a move may
--      happen — SECURITY INVOKER, so deals_select / deals_update /
--      deal_stages_select / require_aal2 stay the authority, exactly as
--      before; the row lock; no-op; open; stage exists; same deal type; not
--      won / lost; the RLS-filtered-UPDATE refusal — and drops its own event
--      INSERT (the trigger writes it in the same statement; keeping both
--      would write two).
--   D. deals_closed_guard (0118's body) gains, for a USER SESSION on an OPEN
--      (or new) deal, the two things the RPC did that a direct PATCH / UPSERT
--      skipped: the deal-type rule ('Stage belongs to another deal type', the
--      RPC's own words) — checked whenever the write sets either side of the
--      pair, so a deal_type change alone, or a new deal born in another
--      pipeline's stage, is refused too (no application path does either:
--      convertLead picks the first stage OF the chosen type, and no action
--      updates deal_type) — and, for a stage CHANGE, the database's clock:
--      stage_entered_at and last_activity_at are stamped now(), whatever the
--      request sent. So a session's direct stage write is now the same
--      movement the RPC makes: same refusals (open, own organisation, not
--      terminal, same type), same timestamps, same event. And a session may
--      not change a deal's id (measured at 0131's first draft: an aal2
--      admin re-keyed a childless deal and moved it in one PATCH, and the
--      event named the new id — the deal's earlier history detached). The
--      maintenance roles and definer bodies are not bound — 0118's rule,
--      unchanged.
--
-- WHY NOT A SECURITY DEFINER move_deal_to_stage OWNING THE TRANSITION (with
-- the guard refusing every direct session stage write): it would restate
-- deals_select / deals_update / deal_stages_select / require_aal2 / the
-- deactivated-profile and lock-wait re-reads by hand, as 0118 had to for
-- close_deal (its step 4b exists because a definer's first reads go stale
-- during a lock wait); it adds a second deal-writing definer to 0118's
-- tripwire and an authenticated-executable definer to the advisors' list
-- (+1 WARN); and a movement by any other path (the service role, a future
-- writer) would still be a stage change with no event. The trigger keeps RLS
-- the authority, adds no executable surface, and makes "one event per actual
-- movement" a property of the table rather than of the callers. Measured
-- precedent for the shape: trg_supersede_deal_nudges (0020).
--
-- CLOSING IS NOT A MOVEMENT. close_deal (0118, a definer) moves the deal into
-- its type's Won / Lost stage in the SAME UPDATE that sets status won / lost;
-- the trigger fires only when the deal is open before AND after, so a close
-- writes exactly what it wrote before — `won` (+ `won_override`) or `lost`,
-- never a `stage_changed` — and report_stage_conversion keeps counting closes
-- under `outcomes`, not as entries into the Won / Lost stage. A maintenance
-- reopen (status won/lost → open, service role) is not a movement either.
--
-- TRUSTED PATHS, deliberately. The service role and postgres are not bound by
-- RLS or by the guard (0118): an import or a restore may still write a
-- historical stage_changed event, and a maintenance stage change of an open
-- deal is now RECORDED by the trigger as a system movement (actor null),
-- with the timestamps the maintenance write chose. A deal INSERT is not a
-- movement (no event, as before; a restore's COPY is an INSERT).
--
-- HISTORICAL EVENTS ARE NOT TOUCHED. No event row is written, modified,
-- deleted or rehashed by this file, and none is certified: a deal
-- stage_changed whose `id` was assigned before this migration committed may
-- have been written by a session and is not proven to describe a real
-- movement. The mirror side holds too, and no ROW is repaired either: before
-- the boundary a session's direct PATCH could move a deal with NO event,
-- choose its stage_entered_at, or park an open deal in another pipeline's
-- stage — so the log before it may be incomplete, and a deal may sit in such
-- a stage until its next stage or type change (the read-only pre-apply count
-- below says how many). ENFORCEMENT BEGINS at this migration's commit; the postflight
-- prints the highest event id and how many deal stage_changed events exist at
-- that moment — read while ALTER POLICY holds events' ACCESS EXCLUSIVE lock,
-- so no event written under the old policy can carry a higher id — and keeps
-- it as the COMMENT on the deals_stage_changed_event trigger, where the apply
-- log is not needed to find it (and a restore carries it).
--
-- CONTRACT. move_deal_to_stage: same signature, `returns void`, SECURITY
-- INVOKER, search_path = public, grants (restated and asserted below) — so no
-- release-compat entry and no type change (database.types.ts lists no
-- trigger functions; regenerating it changes nothing). The event's shape is
-- 0067's. The deployed application calls only the RPC; it never inserts a
-- stage_changed itself, so it is NOT deploy-coupled: this file may be applied
-- before or after the merge, and either application version works against
-- either schema.
--
-- VISIBLE CHANGES FOR A DIRECT POSTGREST CALLER (the application makes none
-- of these requests): a session's POST of a stage_changed (any entity_type)
-- answers 403 / 42501; a deal INSERT or UPSERT whose stage belongs to another deal type
-- answers 400 / P0001 "Stage belongs to another deal type" — including an
-- UPSERT of a non-sale deal that omits deal_type, whose proposed INSERT row
-- takes the column's default 'sale' (send deal_type), and an UPSERT of a deal
-- whose stored stage already belongs to another type (an admin changed the
-- stage's deal_type) even when it changes neither — a plain PATCH is not
-- refused; so does a PATCH of deal_type alone that would leave the stage in
-- another pipeline; a PATCH of a deal's id answers P0001 "A deal's id cannot
-- be changed"; a PATCH that changes the stage gets stage_entered_at =
-- last_activity_at = now(), whatever it sent (a LATER PATCH of
-- stage_entered_at alone is still accepted — BACKLOG "Deal fields around a
-- close that nothing freezes").
--
-- LOCKS. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on deals (deal writes
-- wait behind it); ALTER POLICY takes ACCESS EXCLUSIVE on events (every event
-- read and write waits behind it); CREATE OR REPLACE FUNCTION takes none. The
-- file takes deals FIRST and events LAST (section A is placed after D), the
-- order every writer takes them — an UPDATE of deals, then its event — so an
-- in-flight move cannot deadlock against the apply. lock_timeout (5 s) bounds
-- each wait; a collision is a clean 55P03 (or 40P01) rollback — then apply
-- again, and do NOT write the ledger row. ONE transaction (checked below).
-- Apply as 0129 did: outside 02:55–04:05 UTC, away from 06:00, at the middle
-- of an odd minute that is not a multiple of five (the desk-alert sweep runs
-- every 2 minutes and the lead escalation every 5, and both write events).
--
-- A NEW LOCK INTERACTION, accepted: a direct UPDATE that moves a deal now
-- takes the organisation's chain lock (its event's insert) and keeps it to
-- commit, as the RPC always did. One statement cannot deadlock on it, however
-- many deals it moves: AFTER row triggers fire at the END of the statement,
-- after every row lock it takes. A TRANSACTION that moves deals in SEVERAL
-- statements can: its first movement's event holds the chain lock while a
-- later statement waits for a row a concurrent kanban move holds, and that
-- move waits for the chain lock — PostgreSQL aborts one side (40P01, clean,
-- nothing kept). The application moves one deal per transaction; a
-- maintenance bulk move should be ONE statement, or one transaction per deal.
--
-- DEPLOY ORDER. Not coupled (CONTRACT above); the working agreement's order
-- stands: branch CI green → hosted 0131 → merge. Hosted must be read
-- READ-ONLY before the apply against this preflight's five expectations:
-- events_insert's rendered check (under this file's search_path);
-- move_deal_to_stage's and trg_deals_closed_guard's code hashes (the md5
-- expression below — comments ignored; raw md5s f0012afe… / 258b2b3e…);
-- the non-internal triggers on deals exactly deals_closed_guard,
-- deals_supersede_nudges, deals_updated; and no
-- public.trg_deals_stage_changed_event() yet. The file refuses, changing
-- nothing, if any differs. It ends with one SELECT returning the
-- enforcement boundary, so the apply tool's output carries it. Record with
-- that pre-apply read one more count, not a refusal: open deals whose stage
-- is not a non-terminal stage of their own organisation and deal type —
--   select count(*) from deals d left join deal_stages s on s.id = d.stage_id
--    where d.status = 'open' and (s.id is null or s.org_id <> d.org_id
--          or s.deal_type <> d.deal_type or s.is_won or s.is_lost);
-- (0 on the local stack, 2026-10-02) — rows written before the boundary
-- that 0131 leaves as they are.
--
-- NOT CHANGED: who may move which deal (RLS — deals_select / deals_update /
-- deal_stages_select / require_aal2 — decides it for the RPC and a PATCH
-- alike, as before); close_deal; the chain trigger, its lock and the hash
-- formula; the partitions; report_stage_conversion (0130) and every reader;
-- what any session may READ; every other event type. move_deal_to_stage
-- still takes FOR UPDATE (a separate BACKLOG item, unchanged here).
--
-- NOT DONE HERE (BACKLOG — each is its own decision): whether deal_type
-- should be writable at all (0131 binds it to the stage's pipeline on an
-- open or new deal only — a won / lost deal's deal_type stays PATCHable
-- alone, 0118's closed-row branch does not compare it); created_at and
-- stage_entered_at stay PATCHable without a stage change; look-alike event
-- types (`Stage_changed`, `stage changed`) are still accepted and print on
-- the timeline (the allow-list entry; the exact `stage_changed` is refused
-- under every entity_type); the historical events above; a stage's
-- is_won / is_lost / deal_type flipped or renamed under open deals
-- (configuration); a session can still re-key OTHER records (contacts,
-- leads…) whose events are keyed by id.
--
-- ROLLBACK, a forward migration, ALL IN ONE TRANSACTION. FIRST read the
-- trigger's COMMENT (the enforcement boundary — dropping the trigger drops
-- it) into the rollback's own header, and record the rollback's own
-- max(events.id): between the two, session-written stage_changed was
-- refused; after the rollback it is accepted again. Then drop trigger
-- deals_stage_changed_event and function trg_deals_stage_changed_event AND
-- restore 0067's move_deal_to_stage (its INSERT back) together — the trigger
-- beside 0067's INSERT writes two events per move, 0067's INSERT under this
-- file's policy refuses every move; restore events_insert's 0128 check (the
-- preflight below quotes it) and 0118's guard body (raw md5 258b2b3e…).
-- supabase/tests/revert-0131.ts builds exactly that text from 0067, 0118
-- and 0128, and the test file replays it. In the same change: delete
-- supabase/tests/stage-movement-authentic.test.ts and revert-0131.ts; drop
-- the 42501 expectation of a session POST in stage-conversion-malformed.test.ts
-- (its service-role fixtures pass under either); drop 'stage_changed' from
-- session-written-events.test.ts's refused list; deal-close.test.ts's "ordinary
-- edits and non-terminal stage moves" expects ONE event again (the RPC's —
-- the direct PATCH writes none); remove verify-restore.sql's 0131 row and
-- its trg_deals_stage_changed_event grants row and move its migrations pin
-- FORWARD; restore BACKLOG's struck entry, docs/04's deals / events rows and
-- the moveDealToStage comment, which would be false again.
-- tests/e2e/pipeline-move.spec.ts passes under either. No data moves.
-- =============================================================================

set local lock_timeout = '5s';
-- pg_get_expr's output depends on the session's search_path (it qualifies
-- what is not on the path), so the policy text below is read under a FIXED
-- path — the one local and hosted both use (0127's idiom)
set local search_path = "$user", public, extensions;

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0131 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preflight: everything this file rewrites must be what it was written against
-- ---------------------------------------------------------------------------
do $$
declare
  v_check text;
  v_code  text;
  v_trg   text;
begin
  -- A. events_insert is 0128's
  select pg_get_expr(p.polwithcheck, p.polrelid) into v_check
    from pg_policy p
   where p.polrelid = 'public.events'::regclass and p.polname = 'events_insert' and p.polcmd = 'a';
  if v_check is distinct from
     '((org_id = ( SELECT current_org_id() AS current_org_id)) AND (actor_id = ( SELECT auth.uid() AS uid)) AND (NOT ((entity_type = ''deal''::text) AND (event_type = ANY (ARRAY[''won''::text, ''lost''::text, ''won_override''::text])))) AND (occurred_at = now()))' then
    raise exception '0131 aborted: events_insert''s check is not 0128''s (%) — nothing was changed', coalesce(v_check, 'missing');
  end if;

  -- C. move_deal_to_stage is 0067's CODE (comments and whitespace ignored:
  --    hosted bodies have differed from the repository by comments, 0127)
  select md5(btrim(regexp_replace(regexp_replace(replace(p.prosrc, E'\r', ''), '--[^\n]*', '', 'g'), '\s+', ' ', 'g')))
    into v_code
    from pg_proc p
   where p.oid = to_regprocedure('public.move_deal_to_stage(uuid, uuid)')
     and not p.prosecdef and 'search_path=public' = any (p.proconfig);
  if v_code is distinct from 'bcadfb1a175518e069a4fdc5ff6a237a' then
    raise exception '0131 aborted: move_deal_to_stage is not 0067''s invoker body (code md5 %) — nothing was changed', coalesce(v_code, 'missing');
  end if;

  -- D. deals_closed_guard is 0118's
  select md5(btrim(regexp_replace(regexp_replace(replace(p.prosrc, E'\r', ''), '--[^\n]*', '', 'g'), '\s+', ' ', 'g')))
    into v_code
    from pg_proc p
   where p.oid = to_regprocedure('public.trg_deals_closed_guard()')
     and not p.prosecdef and 'search_path=public, pg_temp' = any (p.proconfig);
  if v_code is distinct from '4266740fcc7f0f6159aef0c09746a762' then
    raise exception '0131 aborted: trg_deals_closed_guard is not 0118''s invoker body (code md5 %) — nothing was changed', coalesce(v_code, 'missing');
  end if;

  -- B. the triggers on deals are exactly the three this file was written
  --    against, and the new names are free
  select string_agg(t.tgname, ', ' order by t.tgname) into v_trg
    from pg_trigger t where t.tgrelid = 'public.deals'::regclass and not t.tgisinternal;
  if v_trg is distinct from 'deals_closed_guard, deals_supersede_nudges, deals_updated' then
    raise exception '0131 aborted: the triggers on deals are not the expected three (%) — nothing was changed', coalesce(v_trg, 'none');
  end if;
  if to_regprocedure('public.trg_deals_stage_changed_event()') is not null then
    raise exception '0131 aborted: public.trg_deals_stage_changed_event() already exists — nothing was changed';
  end if;

  -- the hoisted-policy count the postflight must find unchanged (0030)
  perform set_config('gnk.m0131_hoisted', public.rls_hoisted_policy_count()::text, true);

  raise notice '0131: preflight passed — events_insert is 0128''s, move_deal_to_stage 0067''s, the guard 0118''s, the triggers on deals the expected three';
end $$;

-- ---------------------------------------------------------------------------
-- B. the movement's event, derived from the row change
-- ---------------------------------------------------------------------------
create function public.trg_deals_stage_changed_event()
returns trigger
language plpgsql
security definer
-- pg_temp LAST: unlisted, it is searched FIRST for relations and types
set search_path = public, pg_temp
as $$
declare
  v_from text;
  v_to   text;
begin
  -- only as the AFTER UPDATE row trigger on public.deals: a definer body that
  -- writes the chain must not be attachable anywhere else
  if tg_when <> 'AFTER' or tg_level <> 'ROW' or tg_op <> 'UPDATE'
     or tg_table_schema <> 'public' or tg_table_name <> 'deals' then
    raise exception 'trg_deals_stage_changed_event runs only as the AFTER UPDATE row trigger on public.deals';
  end if;
  -- a movement is an open deal of one organisation changing stage and staying
  -- open (the trigger's WHEN says the same; restated so the body is right
  -- without it). A close (status → won / lost, close_deal), a reopen and a
  -- maintenance move to another organisation are not movements.
  if old.stage_id is not distinct from new.stage_id
     or old.status <> 'open' or new.status <> 'open'
     or old.org_id is distinct from new.org_id then
    return null;
  end if;

  -- names read in the deal's OWN organisation: a stage id that is not one of
  -- its stages (only a maintenance write can store one) records its id, never
  -- another organisation's stage name
  select s.name into v_from from public.deal_stages s where s.id = old.stage_id and s.org_id = new.org_id;
  select s.name into v_to   from public.deal_stages s where s.id = new.stage_id and s.org_id = new.org_id;

  insert into public.events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (
    new.org_id,
    auth.uid(),          -- the session's user; null for the service role / postgres
    'deal',
    new.id,
    'stage_changed',
    -- 0067's payload: names for the timeline, ids for the report
    jsonb_build_object(
      'from',          coalesce(v_from, old.stage_id::text),
      'to',            coalesce(v_to,   new.stage_id::text),
      'from_stage_id', old.stage_id,
      'to_stage_id',   new.stage_id
    )
  );
  return null;
end $$;

-- a trigger body: callable by nobody (explicitly from service_role too, so a
-- hosted project's default privileges cannot differ from local — 0117)
revoke execute on function public.trg_deals_stage_changed_event() from public, anon, authenticated, service_role;

comment on function public.trg_deals_stage_changed_event() is
  'AFTER UPDATE row trigger on deals (0131): writes the deal''s stage_changed event from OLD / NEW '
  'when an open deal changes stage and stays open — names read in the deal''s organisation, actor '
  'auth.uid(). The ONLY writer of a session-time deal stage_changed: events_insert refuses a session''s '
  'own. SECURITY DEFINER so the insert does not depend on the caller''s events_insert; nobody may call it.';

create trigger deals_stage_changed_event
  after update on public.deals
  for each row
  when (old.stage_id is distinct from new.stage_id and old.status = 'open' and new.status = 'open'
        and old.org_id = new.org_id)
  execute function public.trg_deals_stage_changed_event();

-- ---------------------------------------------------------------------------
-- C. move_deal_to_stage — 0067's body without its own INSERT
-- ---------------------------------------------------------------------------
create or replace function public.move_deal_to_stage(p_deal_id uuid, p_stage_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_deal record;
  v_to record;
  v_rows int;
begin
  -- Row lock: concurrent moves of the same deal serialize here. The event is
  -- written by the deals_stage_changed_event trigger (0131) from the row this
  -- UPDATE replaces, so its from-stage is always the stage actually left.
  select id, org_id, deal_type, stage_id, status
    into v_deal
    from deals
   where id = p_deal_id
     for update;
  if not found then
    raise exception 'Deal not found';
  end if;
  if v_deal.stage_id = p_stage_id then
    return; -- no-op drag back onto the same column: no movement, no event
  end if;
  if v_deal.status <> 'open' then
    raise exception 'Deal is already % — closed deals do not move stages', v_deal.status;
  end if;

  select id, deal_type, is_won, is_lost
    into v_to
    from deal_stages
   where id = p_stage_id;
  if not found then
    raise exception 'Stage not found';
  end if;
  if v_to.deal_type <> v_deal.deal_type then
    raise exception 'Stage belongs to another deal type';
  end if;
  -- Won/lost stay behind the guarded flows (T3.4): accepted-offer check,
  -- admin override, mandatory lost reason. The kanban cannot bypass them.
  if v_to.is_won or v_to.is_lost then
    raise exception 'Use the deal page to mark this deal % (guarded flow)',
      case when v_to.is_won then 'won' else 'lost' end;
  end if;

  update deals
     set stage_id = p_stage_id,
         stage_entered_at = now(),
         last_activity_at = now()
   where id = p_deal_id;
  get diagnostics v_rows = row_count;
  -- RLS filtered the UPDATE to nothing (e.g. listing manager: may see all org
  -- deals but update none). Abort: no row changed, so no event was written.
  if v_rows = 0 then
    raise exception 'You do not have permission to move this deal';
  end if;
  -- 0131: no INSERT here — the trigger wrote this movement's stage_changed
  -- (0067's payload) inside the UPDATE above, and a failure there failed it.
end $$;

-- 0011's grants, restated: create-or-replace preserves the ACL, and §4 of
-- HANDOFF says to assert rather than assume.
revoke execute on function public.move_deal_to_stage(uuid, uuid) from public, anon;
grant  execute on function public.move_deal_to_stage(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- D. deals_closed_guard — a session's stage change of an open deal is the
--    RPC's movement: same deal type, the database's clock
-- ---------------------------------------------------------------------------
create or replace function public.trg_deals_closed_guard()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_stage_ok boolean;
  v_type_ok  boolean;
begin
  -- user sessions only: the maintenance roles and SECURITY DEFINER bodies
  -- owned by postgres — close_deal among them — are not bound (0118 header)
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  -- 0131: a deal's identity is not a session's to change. Its events, its
  -- movement history and its timeline are keyed by it; a re-key (with or
  -- without a stage change in the same PATCH) would detach them
  if tg_op = 'UPDATE' and new.id is distinct from old.id then
    raise exception 'A deal''s id cannot be changed';
  end if;

  if tg_op = 'INSERT' or old.status = 'open' then
    -- a deal is born open and stays open until close_deal says otherwise
    if tg_op = 'INSERT' then
      if new.status is distinct from 'open' then
        raise exception 'A deal is created open — it is marked won or lost only from the deal page (close_deal)';
      end if;
      if new.won_at is not null or new.lost_at is not null or new.lost_reason is not null
         or new.final_value is not null then
        raise exception 'A new deal cannot carry closing details — they are written when it is marked won or lost';
      end if;
    else
      if new.status is distinct from old.status then
        raise exception 'Deal is open — it is marked % only from the deal page (close_deal)', new.status;
      end if;
      -- a maintenance reopen may leave the previous lifecycle's values on the
      -- row (0117); an ordinary edit carries them unchanged, so only a CHANGE
      -- is refused
      if (new.won_at, new.lost_at, new.lost_reason, new.final_value)
         is distinct from (old.won_at, old.lost_at, old.lost_reason, old.final_value) then
        raise exception 'Deal is open — its closing details are written only when it is marked won or lost';
      end if;
    end if;

    -- the stage: one of the deal's own organisation's non-terminal stages —
    -- and, since 0131, of the deal's own type, whichever side of that pair
    -- the write sets (a deal_type change alone would otherwise leave the
    -- stage in another pipeline). Read as the caller (deal_stages_select is
    -- org-scoped); the org predicate is explicit so the answer does not rest
    -- on RLS alone
    if tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id
       or new.deal_type is distinct from old.deal_type then
      select not (s.is_won or s.is_lost), s.deal_type = new.deal_type
        into v_stage_ok, v_type_ok
        from public.deal_stages s
       where s.id = new.stage_id and s.org_id = new.org_id;
      if v_stage_ok is null then
        raise exception 'Stage not found';
      end if;
      if not v_stage_ok then
        raise exception 'Use the deal page to mark this deal won or lost (guarded flow)';
      end if;
      -- 0131: move_deal_to_stage's deal-type rule, in its words
      if not v_type_ok then
        raise exception 'Stage belongs to another deal type';
      end if;
      -- 0131: a session's stage CHANGE is a movement — the database's clock
      -- says when the stage was entered, whatever the request sent
      -- (deals_stage_changed_event records the movement itself)
      if tg_op = 'UPDATE' and new.stage_id is distinct from old.stage_id then
        new.stage_entered_at := now();
        new.last_activity_at := now();
      end if;
    end if;
    return new;
  end if;

  -- a row already won or lost (0117, unchanged)
  if new.status is distinct from old.status then
    if new.status = 'open' then
      raise exception 'Deal is already % — a closed deal cannot be reopened', old.status;
    end if;
    raise exception 'Deal is already % — it cannot be marked %', old.status, new.status;
  end if;
  if (new.won_at, new.lost_at, new.lost_reason, new.final_value, new.stage_id, new.stage_entered_at)
     is distinct from
     (old.won_at, old.lost_at, old.lost_reason, old.final_value, old.stage_id, old.stage_entered_at) then
    raise exception 'Deal is already % — its closing details cannot be changed', old.status;
  end if;
  return new;
end $$;

-- create or replace keeps the ACL; restated so hosted and local cannot differ
revoke execute on function public.trg_deals_closed_guard() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- A. a session may not write a deal's stage_changed — LAST, so this file
--    takes deals' lock (B) before events' (here), the order every writer
--    takes them (an UPDATE of deals, then its events); the reverse could
--    deadlock against an in-flight move during the apply
-- ---------------------------------------------------------------------------
alter policy events_insert on public.events
  with check (
    -- 0071's two clauses, written as 0071 wrote them so the hoisted form
    -- renders identically (rls_hoisted_policy_count)
    org_id = (select current_org_id())
    and actor_id = (select auth.uid())
    -- 0128: won / lost / won_override are close_deal's, a definer; a session
    -- may not write them for any deal
    and not (entity_type = 'deal' and event_type in ('won', 'lost', 'won_override'))
    -- 0131: stage_changed is the deals_stage_changed_event trigger's, a
    -- definer; a session may not write it at all — for a deal or under any
    -- other entity_type, where the timeline would still print it as a move
    and event_type <> 'stage_changed'
    -- 0128: a session's event occurs at its own insert (the column's default)
    and occurred_at = now()
  );

-- ---------------------------------------------------------------------------
-- Postflight. The behaviour needs sessions and is proven by
-- supabase/tests/stage-movement-authentic.test.ts; here the shape.
-- ---------------------------------------------------------------------------
do $$
declare
  v_check    text;
  v_src      text;
  v_n        int;
  v_moves    bigint;
  v_boundary bigint;
  sig_fn  constant text := 'public.trg_deals_stage_changed_event()';
  sig_rpc constant text := 'public.move_deal_to_stage(uuid,uuid)';
begin
  -- A
  select pg_get_expr(p.polwithcheck, p.polrelid) into v_check
    from pg_policy p where p.polrelid = 'public.events'::regclass and p.polname = 'events_insert';
  if v_check !~ '\(event_type <> ''stage_changed''::text\)' or v_check !~ 'won_override' or v_check !~ 'occurred_at = now\(\)'
     or v_check !~ 'SELECT current_org_id\(\) AS current_org_id' or v_check !~ 'SELECT auth\.uid\(\) AS uid' then
    raise exception '0131 postflight: events_insert is not the 0131 check: %', v_check;
  end if;
  -- …still in its hoisted form: the count unchanged, no bare helper call
  if public.rls_hoisted_policy_count()::text is distinct from current_setting('gnk.m0131_hoisted', true) then
    raise exception '0131 postflight: rls_hoisted_policy_count moved (% → %)',
      current_setting('gnk.m0131_hoisted', true), public.rls_hoisted_policy_count();
  end if;
  if exists (select 1 from public.rls_bare_helper_calls() where policyname = 'events_insert')
     or exists (select 1 from public.rls_bare_auth_calls() where policyname = 'events_insert') then
    raise exception '0131 postflight: events_insert calls a helper or auth.uid() bare (not hoisted)';
  end if;

  -- B: the function — definer, owned by postgres, pg_temp last, callable by nobody
  if not exists (select 1 from pg_proc p
                  where p.oid = sig_fn::regprocedure and p.prosecdef
                    and pg_get_userbyid(p.proowner) = 'postgres'
                    and p.proconfig = array['search_path=public, pg_temp']
                    and p.prorettype = 'trigger'::regtype) then
    raise exception '0131 postflight: trg_deals_stage_changed_event lost its SECURITY DEFINER, owner, search_path or return type';
  end if;
  if has_function_privilege('public', sig_fn, 'execute') or has_function_privilege('anon', sig_fn, 'execute')
     or has_function_privilege('authenticated', sig_fn, 'execute') or has_function_privilege('service_role', sig_fn, 'execute') then
    raise exception '0131 postflight: trg_deals_stage_changed_event is executable by an API role';
  end if;
  -- …and the trigger: AFTER UPDATE, FOR EACH ROW, enabled, with its WHEN
  select count(*) into v_n from pg_trigger t
   where t.tgrelid = 'public.deals'::regclass and t.tgname = 'deals_stage_changed_event' and not t.tgisinternal
     and t.tgfoid = sig_fn::regprocedure and t.tgenabled = 'O'
     and (t.tgtype & 2) = 0       -- AFTER
     and (t.tgtype & 1) = 1       -- FOR EACH ROW
     and (t.tgtype & 16) = 16     -- UPDATE
     and (t.tgtype & (4 | 8 | 32)) = 0   -- not INSERT / DELETE / TRUNCATE
     and pg_get_triggerdef(t.oid) ~ ('WHEN \(\(\(old\.stage_id IS DISTINCT FROM new\.stage_id\) AND \(old\.status = ''open''::deal_status\) '
                                     'AND \(new\.status = ''open''::deal_status\) AND \(old\.org_id = new\.org_id\)\)\)');
  if v_n <> 1 then
    raise exception '0131 postflight: deals_stage_changed_event is not the AFTER UPDATE row trigger with its WHEN: %',
      (select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgrelid = 'public.deals'::regclass and t.tgname = 'deals_stage_changed_event');
  end if;

  -- C: still the invoker, same grants, and no event INSERT of its own
  select regexp_replace(p.prosrc, '--[^\n]*', '', 'g') into v_src
    from pg_proc p
   where p.oid = sig_rpc::regprocedure and not p.prosecdef and p.proconfig = array['search_path=public']
     and p.prorettype = 'void'::regtype;
  if v_src is null then
    raise exception '0131 postflight: move_deal_to_stage lost its SECURITY INVOKER, search_path or void return';
  end if;
  if v_src ~* 'insert\s+into\s+(public\.)?events' then
    raise exception '0131 postflight: move_deal_to_stage still inserts an event — every move would write two';
  end if;
  if has_function_privilege('anon', sig_rpc, 'execute')
     or not has_function_privilege('authenticated', sig_rpc, 'execute')
     or not has_function_privilege('service_role', sig_rpc, 'execute') then
    raise exception '0131 postflight: move_deal_to_stage grants are wrong';
  end if;

  -- D: the guard still runs as the caller and carries the 0131 clauses
  select regexp_replace(p.prosrc, '--[^\n]*', '', 'g') into v_src
    from pg_proc p
   where p.oid = 'public.trg_deals_closed_guard()'::regprocedure and not p.prosecdef
     and p.proconfig = array['search_path=public, pg_temp'];
  if v_src is null or v_src !~ 'Stage belongs to another deal type'
     or v_src !~ 'new\.deal_type is distinct from old\.deal_type'
     or v_src !~ 'new\.id is distinct from old\.id'
     or v_src !~ 'new\.stage_entered_at := now\(\)' or v_src !~ 'new\.last_activity_at := now\(\)'
     or v_src !~ 'current_user not in \(''authenticated'', ''anon''\)' then
    raise exception '0131 postflight: trg_deals_closed_guard is not the 0131 body';
  end if;

  -- One writer: no other function in the database writes a deal
  -- stage_changed. (A function that names the event type and inserts into
  -- events; extension-owned functions are out of scope, as in 0118.)
  select string_agg(ns.nspname || '.' || p.proname, ', ' order by ns.nspname, p.proname) into v_src
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname not in ('pg_catalog', 'information_schema')
     and p.oid <> sig_fn::regprocedure
     and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* 'insert\s+into\s+(public\.)?events'
     and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~ '''stage_changed'''
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                        and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e');
  if v_src is not null then
    raise exception '0131 postflight: a function other than trg_deals_stage_changed_event writes stage_changed events: %', v_src;
  end if;

  -- 0118's tripwire still holds: the new definer writes events, not deals
  select string_agg(ns.nspname || '.' || p.proname, ', ' order by ns.nspname, p.proname) into v_src
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where p.prosecdef
     and ns.nspname not in ('pg_catalog', 'information_schema')
     and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '(update|insert\s+into)\s+(public\.)?deals\y'
     and not (ns.nspname = 'public' and p.proname = 'close_deal')
     and not exists (select 1 from pg_depend d
                      where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                        and d.refclassid = 'pg_extension'::regclass and d.deptype = 'e');
  if v_src is not null then
    raise exception '0131 postflight: a SECURITY DEFINER function other than close_deal writes deals: %', v_src;
  end if;

  raise notice '0131: postflight passed — deal stage_changed is written by the deals_stage_changed_event trigger only; events_insert refuses a session''s';

  -- The enforcement boundary, read HERE: ALTER POLICY above holds ACCESS
  -- EXCLUSIVE on events, which it could only take once every transaction that
  -- had inserted an event ended, and no event can be inserted until this one
  -- commits. So every event with an id at or below this one was written under
  -- 0128's policy, every later one under 0131's (header). 0131 binds SESSIONS:
  -- a deal stage_changed above the boundary comes from this trigger or from
  -- the service role / postgres (an import, a restore), never from a session.
  select count(*) filter (where entity_type = 'deal' and event_type = 'stage_changed'), max(id)
    into v_moves, v_boundary
    from public.events;
  raise notice '0131: enforcement boundary — events with id <= % were written before 0131; % deal stage_changed event(s) among them stay as written, uncertified',
    coalesce(v_boundary::text, '(no events)'), v_moves;
  -- …and kept in the catalogue, where a later reader (BACKLOG's VERIFY) and a
  -- restore find it — a NOTICE is not reliably kept by every apply tool
  execute format('comment on trigger deals_stage_changed_event on public.deals is %L',
    'Writes a deal''s stage_changed from OLD / NEW (0131). Sessions may not write stage_changed from event id > '
    || coalesce(v_boundary::text, '0') || ' (rows above it come from this trigger or the service role — imports, restores); at or below it, '
    || v_moves || ' deal stage_changed event(s) were written before 0131 and are uncertified.');
end $$;

-- The enforcement boundary as this file's LAST result (execute_sql returns the
-- last statement's rows; a NOTICE may not reach the apply output).
select obj_description(t.oid, 'pg_trigger') as enforcement_boundary
  from pg_trigger t
 where t.tgrelid = 'public.deals'::regclass and t.tgname = 'deals_stage_changed_event';
