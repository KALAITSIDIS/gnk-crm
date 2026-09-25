-- =============================================================================
-- 0118 — a deal reaches won or lost only through close_deal
--
-- THE GAP (BACKLOG "a direct write can still close an OPEN deal", left open by
-- 0117 on purpose because refusing it was deploy-coupled). Reproduced
-- 2026-09-25 against 3a72498 on the local stack at 0117, through PostgREST
-- with a real aal2 agent session, and pinned by the "KNOWN GAP" test in
-- supabase/tests/deal-close.test.ts: `deals_closed_guard` returned at once
-- when `old.status = 'open'`, and `deals_update` (0100) restricts ROWS, not
-- columns or values. So the deal's own agent (or any admin) could:
--
--   * PATCH an open deal to won — no accepted offer, no override, no event;
--   * PATCH it to lost — no reason at all, or a one-letter one, no event;
--   * UPSERT (POST ... on_conflict=id, merge-duplicates) the same transition;
--   * INSERT a deal that is born won or lost;
--   * write closing details onto an OPEN deal (won_at, lost_at, lost_reason,
--     final_value) or park it in its type's Won / Lost stage while it stays
--     open — the kanban's own RPC refuses that move (0067), a PATCH did not.
--
-- THE DEPENDENCY, CONFIRMED BEFORE THIS FILE WAS WRITTEN (2026-09-25):
-- production (gnk-crm.vercel.app, dpl_7BFFpRnoN9cDzuk2XquP7A9Yn7FL) serves
-- aa01ef8, whose markDealWon / markDealLost call close_deal and write the
-- deal row no other way; main (3a72498) differs from it in docs only; hosted
-- is at 0117 with close_deal's body md5 = local. An application OLDER than
-- aa01ef8 closes a deal with a PATCH, which this migration refuses — see
-- DECISIONS T-deal-close-db-boundary for the deploy order and the rollback.
--
-- THE DESIGN — who may change status is decided by the ROLE the statement runs
-- as, which a PostgREST caller cannot choose (it comes from the signed JWT):
--
-- A. close_deal becomes SECURITY DEFINER (owner postgres). Its body is 0117's,
--    with the one thing an invoker body got from RLS restated explicitly —
--    see "WHAT THE DEFINER BODY RESTATES" below. Everything else (the
--    session identity, the aal2 check, the role check before any read, the
--    lock, the status under the lock, the rules, the events, the answers) is
--    0117's text. EXECUTE stays authenticated-only.
--
-- B. deals_closed_guard now fires BEFORE INSERT OR UPDATE and, for a USER
--    SESSION (current_user authenticated or anon — PostgREST's two roles),
--    also refuses on an OPEN row: any change of status; any change to won_at,
--    lost_at, lost_reason or final_value; and a move to a stage that is not
--    one of the deal's own organisation's non-terminal stages. On INSERT it
--    refuses a deal that is not open, that carries a closing detail, or that
--    starts in such a stage. On a closed row it is 0117's guard, unchanged.
--    The maintenance roles (service_role, postgres) and SECURITY DEFINER
--    bodies owned by postgres are not bound — exactly as in 0117: the
--    operator's correction path, a maintenance reopen, and now close_deal.
--
-- WHY NOT THE ALTERNATIVES (measured or reasoned, DECISIONS):
--   * a transaction-local flag set by close_deal (set_config) and read by the
--     trigger: set_config is executable by PUBLIC — a freely settable session
--     flag is not authorisation;
--   * column privileges (UPDATE / INSERT on status and the closing columns
--     revoked from authenticated): the TABLE grant must be revoked first or a
--     column revoke does nothing, every later column then needs its own grant
--     (and hosted's default grants differ from local, HANDOFF §4.2), and a
--     privilege cannot say "a non-terminal stage of your own organisation" —
--     a trigger is still needed for the stage, so it is the trigger alone;
--   * a deferred constraint trigger that checks, at commit, that a terminal
--     event exists in the same transaction: keeps the invoker body, but moves
--     the rules into a second place and makes "close_deal ran" an inference
--     from side effects.
--
-- WHAT THE DEFINER BODY RESTATES. As an invoker, close_deal was held by
-- deals_select + deals_update (the row lock needs both), offers_select (+ the
-- UPDATE policy a FOR SHARE lock also needs), deal_stages_select,
-- events_insert and require_aal2 on each. Owned by postgres (BYPASSRLS) none of
-- them applies, so:
--   - require_aal2: `mfa_satisfied()` was already checked first (0117 step 1);
--   - the organisation: `org_id = current_org_id()` was already in the lock
--     query; `current_org_id()` is NULL for a deactivated profile, refused as
--     before;
--   - deals_update's USING clause is now in the lock query: an admin of the
--     organisation, or an agent who is the deal's agent_id or created_by. (Its
--     WITH CHECK holds whenever USING does: a close changes neither org_id,
--     agent_id nor created_by.) A listing manager is refused before any read,
--     as before;
--   - offers / deal_stages: read in the DEAL's organisation, as before;
--   - events_insert (org = current org, actor = auth.uid()): the inserts use
--     v_deal.org_id (= current_org_id(), by the lock query) and auth.uid();
--   - 0117's "defensive" fallback — `exists (select 1 from deals where id and
--     org)` after the lock found nothing — is REMOVED: under RLS it could not
--     see another agent's deal, but as postgres it would answer "You do not
--     have permission" for it and "Deal not found" for a missing id: an
--     existence oracle. Every refusal after the role check is 'Deal not found'.
--   - every relation is schema-qualified, so the definer's search_path (public,
--     the repo's convention) cannot be shadowed by a pg_temp relation.
--   supabase/tests/deal-close.test.ts proves the restatement DIFFERENTIALLY:
--   for every persona, close_deal succeeds exactly where a PostgREST PATCH of
--   an ordinary column succeeds.
--
-- Unchanged: the rules, messages, payloads and answers of close_deal (no
-- signature or return-shape change, so no release-compat entry and no type
-- regeneration); the Won follow-ups stay app-side; listing status and
-- reservations are not touched; no row is repaired and no event is minted —
-- hosted (read-only, 2026-09-25) holds one deal, lost, with its lost_at,
-- reason, Lost stage and `lost` event, and no open deal carrying a closing
-- detail or a terminal stage.
--
-- NOT DONE HERE (BACKLOG — each is its own workflow, none makes a deal won or
-- lost without close_deal):
--   * the accepted offer close_deal requires is whatever offers.status says,
--     and offers have no database boundary: a user session may POST an offer
--     already 'accepted', PATCH one to accepted (what updateOfferStatus does,
--     minus its single-accepted check and its event), or re-point an accepted
--     offer's deal_id within the organisation. An agent may already record
--     and accept an offer on their own deal in the app, so this grants no new
--     authority over the Won rule; it is the offer workflow's own gap;
--   * events_insert admits hand-written `won` / `lost` / `won_override`
--     events from the same session (they change no deal);
--   * deals_insert does not bind created_by / agent_id to the caller;
--   * on a CLOSED deal, expected_value and agent_id stay editable (reports
--     read both) and deal_type is writable on any deal;
--   * an admin may flip a stage's is_won / is_lost flag (deal_stages_update)
--     with open deals sitting in it — configuration, not a transition;
--   * a direct PATCH may move an open deal to a non-terminal stage of another
--     DEAL TYPE of its own organisation (move_deal_to_stage refuses that; the
--     guard refuses terminal and foreign-organisation stages only).
--
-- Pins that move with this file: the migrations count (117 -> 118) and the
-- close_deal grants row (secdef false -> true) in
-- scripts/backup/verify-restore.sql. database.types.ts is unchanged.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A. close_deal — SECURITY DEFINER, deals_update restated
-- ---------------------------------------------------------------------------
create or replace function public.close_deal(
  p_deal_id     uuid,
  p_outcome     text,
  p_final_value numeric default null,
  p_lost_reason text    default null,
  p_override    boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid         uuid := auth.uid();
  v_org         uuid;
  v_role        user_role;
  v_deal        record;
  v_offer       record;
  v_override    boolean;          -- null unless the outcome is won
  v_offer_id    uuid;
  v_stage       record;
  v_final       numeric(14,2);
  v_reason      text;
  v_reason_len  int;
  v_rows        int;
begin
  -- 1. who is asking — from the session, never from a parameter. As a definer
  --    body this is the ONLY place require_aal2 and the account's state are
  --    enforced (0118 header)
  if v_uid is null then
    raise exception 'Not authenticated.';
  end if;
  if not (select public.mfa_satisfied()) then
    raise exception 'Second factor required.';
  end if;
  v_org  := (select public.current_org_id());
  v_role := (select public.current_role_gnk());
  if v_org is null then
    raise exception 'Account deactivated.';
  end if;

  -- 2. what is being asked — validated here too, so a direct call meets the
  --    same rules as the form (lib/validators/deals.ts). Every test is written
  --    so that NULL refuses: PostgREST passes an explicit JSON null through.
  if p_outcome is null or p_outcome not in ('won', 'lost') then
    raise exception 'Unknown outcome — a deal is closed as won or lost.';
  end if;
  if p_override is null then
    raise exception 'The override flag must be true or false.';
  end if;

  if p_outcome = 'won' then
    if p_lost_reason is not null then
      raise exception 'A lost reason applies only when a deal is marked lost.';
    end if;
    if p_final_value is not null then
      -- numeric admits NaN (which passes ">= 0") and Infinity: refuse both,
      -- and check the bound BEFORE rounding (999999999999.995 rounds over it)
      if p_final_value = 'NaN'::numeric or p_final_value < 0 or p_final_value > 999999999999 then
        raise exception 'Final value must be a positive amount.';
      end if;
      v_final := round(p_final_value, 2);
    end if;
  else
    if p_final_value is not null or p_override then
      raise exception 'A final value or an override applies only when a deal is marked won.';
    end if;
    -- exactly JavaScript's trim(): WhiteSpace + LineTerminator, no locale
    v_reason := regexp_replace(
      coalesce(p_lost_reason, ''),
      '^[\x9-\xd\x20\xa0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]+|[\x9-\xd\x20\xa0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]+$',
      '', 'g');
    -- measured in UTF-16 code units, as the form's zod rule measures it
    v_reason_len := char_length(v_reason)
                    + (select count(*) from unnest(string_to_array(v_reason, null)) c where ascii(c) > 65535);
    if v_reason_len < 3 then
      raise exception 'A reason is required.';
    end if;
    if v_reason_len > 2000 then
      raise exception 'Keep the reason under 2000 characters.';
    end if;
  end if;

  -- 3. may this person close deals at all — before any deal is read, so the
  --    answer cannot depend on (and so cannot reveal) whether an id exists
  if v_role is null or v_role not in ('admin', 'agent') then
    raise exception 'You do not have permission to close deals.';
  end if;

  -- 4. the row, locked — and deals_update's USING clause (0100), restated
  --    because a definer body is not held by RLS: an admin of the
  --    organisation, or an agent who is the deal's agent or its creator.
  --    A deal outside that — another organisation's, another agent's, a
  --    missing id — is one answer, so the id cannot be used as an oracle.
  select d.id, d.org_id, d.deal_type, d.status, d.stage_id, d.property_id, d.agent_id
    into v_deal
    from public.deals d
   where d.id = p_deal_id
     and d.org_id = v_org
     and (v_role = 'admin' or d.agent_id = v_uid or d.created_by = v_uid)
     for no key update;
  if not found then
    raise exception 'Deal not found';
  end if;

  -- 5. checked UNDER the lock: a competing close has either committed (and is
  --    seen here) or is waiting behind this one
  if v_deal.status <> 'open' then
    return jsonb_build_object(
      'result',  case when v_deal.status::text = p_outcome then 'already_closed' else 'conflict' end,
      'status',  v_deal.status,
      'deal_id', v_deal.id
    );
  end if;

  if p_outcome = 'won' then
    -- one accepted offer is the rule (T3.2), but it is an app-side check: take
    -- the newest (the dialog's prefill order), in the deal's own organisation,
    -- and hold it so it cannot be withdrawn mid-close
    select o.id, o.amount
      into v_offer
      from public.offers o
     where o.deal_id = v_deal.id and o.org_id = v_deal.org_id and o.status = 'accepted'
     order by o.created_at desc, o.id desc
     limit 1
       for share;
    v_offer_id := v_offer.id;
    v_override := v_offer_id is null;

    if v_override then
      if v_role <> 'admin' then
        raise exception 'Won requires an accepted offer — record one first, or ask an admin to override.';
      end if;
      if not p_override then
        raise exception 'No accepted offer on this deal. Tick "Admin override" to mark it won anyway.';
      end if;
    end if;

    v_final := coalesce(v_final, round(v_offer.amount, 2));
    if v_final is not null and (v_final = 'NaN'::numeric or v_final < 0) then
      raise exception 'The accepted offer''s amount is not a valid price — correct the offer first.';
    end if;

    select s.id, s.name
      into v_stage
      from public.deal_stages s
     where s.org_id = v_deal.org_id and s.deal_type = v_deal.deal_type and s.is_won
     order by s.sort_order, s.id
     limit 1;

    update public.deals
       set status           = 'won',
           won_at           = now(),
           last_activity_at = now(),
           final_value      = v_final,
           lost_at          = null,
           lost_reason      = null,
           stage_id         = coalesce(v_stage.id, stage_id),
           stage_entered_at = case when v_stage.id is not null then now() else stage_entered_at end
     where id = v_deal.id and status = 'open';
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      -- unreachable under the lock; kept so a future edit cannot write events
      -- for a transition that did not happen
      raise exception 'Deal not found';
    end if;

    if v_override then
      insert into public.events (org_id, actor_id, entity_type, entity_id, event_type, payload)
      values (v_deal.org_id, v_uid, 'deal', v_deal.id, 'won_override',
              jsonb_build_object('reason', 'marked won without an accepted offer'));
    end if;
    insert into public.events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    values (v_deal.org_id, v_uid, 'deal', v_deal.id, 'won',
            -- trim_scale: 250000.00 from numeric(14,2) reads 250000, as the
            -- action's JSON number did; absent keys stay absent
            jsonb_strip_nulls(jsonb_build_object(
              'override',    v_override,
              'final_value', trim_scale(v_final),
              'stage',       v_stage.name,
              'offer_id',    v_offer_id)));
  else
    select s.id, s.name
      into v_stage
      from public.deal_stages s
     where s.org_id = v_deal.org_id and s.deal_type = v_deal.deal_type and s.is_lost
     order by s.sort_order, s.id
     limit 1;

    update public.deals
       set status           = 'lost',
           lost_at          = now(),
           lost_reason      = v_reason,
           last_activity_at = now(),
           won_at           = null,
           final_value      = null,
           stage_id         = coalesce(v_stage.id, stage_id),
           stage_entered_at = case when v_stage.id is not null then now() else stage_entered_at end
     where id = v_deal.id and status = 'open';
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      raise exception 'Deal not found';
    end if;

    -- the act and the stage; the reason stays on the row (SEC-03)
    insert into public.events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    values (v_deal.org_id, v_uid, 'deal', v_deal.id, 'lost',
            jsonb_strip_nulls(jsonb_build_object('stage', v_stage.name)));
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'result',      'closed',
    'status',      p_outcome,
    'deal_id',     v_deal.id,
    'org_id',      v_deal.org_id,
    'property_id', v_deal.property_id,
    'agent_id',    v_deal.agent_id,
    'override',    v_override,
    'offer_id',    v_offer_id,
    'final_value', trim_scale(v_final),
    'stage',       v_stage.name));
end $$;

-- create or replace keeps the ACL; restated so hosted and local cannot differ
revoke execute on function public.close_deal(uuid, text, numeric, text, boolean) from public, anon, service_role;
grant  execute on function public.close_deal(uuid, text, numeric, text, boolean) to authenticated;

comment on function public.close_deal(uuid, text, numeric, text, boolean) is
  'Marks an OPEN deal won or lost in one transaction: row lock, status checked under it, '
  'guarded rules (accepted offer or admin override; mandatory lost reason), the UPDATE and '
  'every event of the close. A deal already closed is left untouched and answered '
  '{result: already_closed | conflict}. SECURITY DEFINER since 0118 — the only path by which '
  'a user session can make a deal won or lost; it restates deals_update and require_aal2 itself.';

-- ---------------------------------------------------------------------------
-- B. deals_closed_guard — INSERT and OPEN rows too
-- ---------------------------------------------------------------------------
create or replace function public.trg_deals_closed_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_stage_ok boolean;
begin
  -- user sessions only: the maintenance roles and SECURITY DEFINER bodies
  -- owned by postgres — close_deal among them — are not bound (header)
  if current_user not in ('authenticated', 'anon') then
    return new;
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

    -- the stage: one of the deal's own organisation's non-terminal stages.
    -- Read as the caller (deal_stages_select is org-scoped); the org predicate
    -- is explicit so the answer does not rest on RLS alone
    if tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id then
      select not (s.is_won or s.is_lost)
        into v_stage_ok
        from deal_stages s
       where s.id = new.stage_id and s.org_id = new.org_id;
      if v_stage_ok is null then
        raise exception 'Stage not found';
      end if;
      if not v_stage_ok then
        raise exception 'Use the deal page to mark this deal won or lost (guarded flow)';
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

revoke execute on function public.trg_deals_closed_guard() from public, anon, authenticated, service_role;

drop trigger if exists deals_closed_guard on public.deals;
create trigger deals_closed_guard
  before insert or update on public.deals
  for each row execute function public.trg_deals_closed_guard();

-- ---------------------------------------------------------------------------
-- Apply-time assertions. The behaviour needs sessions and is proven by
-- supabase/tests/deal-close.test.ts; here the shape.
-- ---------------------------------------------------------------------------
do $$
declare
  n   int;
  src text;
  sig constant text := 'public.close_deal(uuid,text,numeric,text,boolean)';
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'close_deal';
  if n <> 1 then raise exception '0118 aborted: expected one close_deal, found %', n; end if;

  select p.prosrc into src from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'close_deal'
     and p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres'
     and 'search_path=public' = any (p.proconfig)
     and p.prorettype = 'jsonb'::regtype
     and pg_get_function_identity_arguments(p.oid)
         = 'p_deal_id uuid, p_outcome text, p_final_value numeric, p_lost_reason text, p_override boolean';
  if src is null then
    raise exception '0118 aborted: close_deal lost its signature, jsonb return, SECURITY DEFINER, owner or search_path';
  end if;
  -- read the CODE: comments stripped, so a word in one can neither satisfy
  -- nor blind the checks below
  src := regexp_replace(src, '--[^\n]*', '', 'g');
  -- the restatements a definer body owes (header): aal2, the organisation and
  -- deals_update's USING clause in the lock query, and no existence oracle
  if src !~ 'mfa_satisfied\(\)'
     or src !~ 'd\.org_id = v_org\s+and \(v_role = ''admin'' or d\.agent_id = v_uid or d\.created_by = v_uid\)\s+for no key update' then
    raise exception '0118 aborted: close_deal no longer restates require_aal2 and deals_update in its lock query';
  end if;
  if src ~* 'permission to close this deal' then
    raise exception '0118 aborted: close_deal distinguishes a deal it may not close from a missing one (existence oracle)';
  end if;
  if (select count(*) from regexp_matches(src, 'where id = v_deal.id and status = ''open''', 'g')) <> 2 then
    raise exception '0118 aborted: close_deal no longer folds status = open into both UPDATEs';
  end if;
  -- SEC-03 tripwire, as 0117: all three event inserts read, none carries the reason
  if (select count(*) from regexp_matches(src, 'into public\.events[^;]*jsonb_build_object', 'g')) <> 3 then
    raise exception '0118 aborted: the SEC-03 check no longer reads all three event inserts';
  end if;
  if src ~* 'into public\.events[^;]*(v_reason|p_lost_reason|lost_reason)' then
    raise exception '0118 aborted: a close_deal event carries the lost reason';
  end if;

  if has_function_privilege('anon', sig, 'execute')
     or has_function_privilege('service_role', sig, 'execute')
     or not has_function_privilege('authenticated', sig, 'execute') then
    raise exception '0118 aborted: close_deal grants are wrong';
  end if;
  if has_function_privilege('authenticated', 'public.trg_deals_closed_guard()', 'execute')
     or has_function_privilege('anon', 'public.trg_deals_closed_guard()', 'execute')
     or has_function_privilege('service_role', 'public.trg_deals_closed_guard()', 'execute') then
    raise exception '0118 aborted: the guard trigger body is callable';
  end if;
  if exists (select 1 from pg_proc p where p.oid = 'public.trg_deals_closed_guard()'::regprocedure and p.prosecdef) then
    raise exception '0118 aborted: the guard must run as the caller — current_user is how it tells a user session';
  end if;

  select count(*) into n from pg_trigger t
   where t.tgrelid = 'public.deals'::regclass and t.tgname = 'deals_closed_guard' and not t.tgisinternal
     and t.tgfoid = 'public.trg_deals_closed_guard()'::regprocedure
     and (t.tgtype & 2) = 2      -- BEFORE
     and (t.tgtype & 1) = 1      -- FOR EACH ROW
     and (t.tgtype & 4) = 4      -- INSERT
     and (t.tgtype & 16) = 16;   -- UPDATE
  if n <> 1 then raise exception '0118 aborted: deals_closed_guard is not a BEFORE INSERT OR UPDATE row trigger on deals'; end if;

  -- without a session it refuses before it reads anything
  begin
    perform public.close_deal(gen_random_uuid(), 'lost', null, 'probe reason', false);
    raise exception '0118 aborted: close_deal ran without a session';
  exception
    when raise_exception then
      if sqlerrm <> 'Not authenticated.' then raise; end if;
  end;

  raise notice '0118: close_deal is SECURITY DEFINER (authenticated only); deals_closed_guard binds INSERT and open rows';
end $$;
