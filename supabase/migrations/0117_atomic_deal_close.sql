-- =============================================================================
-- 0117 — closing a deal is one transaction: the lock, the check, the write and
--        its events commit together or not at all
--
-- THE DEFECT (BACKLOG "markDealLost and markDealWon do not fold the open-status
-- check into their UPDATE"; reproduced 2026-09-25 against 6366ef8 by
-- supabase/tests/deal-close-actions.test.ts — the REAL actions, the real local
-- stack, interleaving held by a request gate, never a sleep). Both actions read
-- `status = 'open'`, then updated the row by id alone, then wrote their events
-- as separate requests:
--
--   * two overlapping Lost requests both succeeded: two `lost` events;
--   * overlapping Won and Lost both succeeded and the LATER write stood — a
--     "lost" deal left carrying won_at and final_value, or a "won" one carrying
--     lost_at and the Lost reason; one event of each kind in the chain;
--   * two overlapping override Wins wrote two `won_override` and two `won`;
--   * an event insert refused after the UPDATE left the deal closed with no
--     event (or with `won_override` and no `won`), and the action threw;
--   * a sequential Won then Lost WAS refused — the gap is the read-then-write.
--
-- Nothing in the database stopped any of it: no CHECK ties status to its
-- timestamps, `deals_update` (0100) restricts rows not columns, and no trigger
-- guards a transition.
--
-- A. close_deal(...) — the ONE closing path for the app, modelled on
--    move_deal_to_stage (0067): SECURITY INVOKER, so deals_update / deals_select
--    / offers_select / events_insert and require_aal2 all apply unchanged to a
--    direct RPC call. The deal row is locked (FOR NO KEY UPDATE: it serialises
--    competing closes exactly as FOR UPDATE would, but — unlike FOR UPDATE — it
--    does not block the FOR KEY SHARE that every foreign-key check on a task,
--    offer or viewing takes on its deal, so a close cannot deadlock against the
--    nightly nudge sweep THROUGH A FOREIGN-KEY CHECK. One rarer cycle predates
--    0117 and remains: the close's supersede trigger locks the deal's open
--    no-contact nudges, then waits for the org's events-chain lock, which the
--    sweep may already hold while it updates those same nudges (arm 3 after a
--    threshold change, arm 5 for a deactivated assignee). PostgreSQL aborts
--    one side (40P01): a close that loses answers "nothing was changed", a
--    sweep that loses runs again the next night — BACKLOG) and its status is
--    checked UNDER the lock; the
--    UPDATE is conditional on `status = 'open'` as well; every event of the
--    close (`won_override`, `won`, `lost`) is inserted in the same transaction,
--    so a refused event rolls the status, stage, timestamps, price, reason —
--    and the nudge supersession the status change fires — back with it. A
--    request that finds the deal already closed writes NOTHING and says so:
--    `already_closed` (the same outcome — a double submit or a retry) or
--    `conflict` (the other outcome committed first). Idempotency is per OPEN
--    LIFECYCLE: it keys on the row's current status, never on "a terminal event
--    exists".
--
--    The rules it carries, unchanged from the actions (DECISIONS T3.4,
--    T-close-the-books / WF-2, T-event-typed-text-shape):
--      - Won needs an accepted offer; without one, only an admin, and only with
--        the explicit override, and then `won_override` is written before `won`;
--      - final_value = the closer's typed figure, else the accepted offer's
--        amount, else null (override closes may leave it blank);
--      - the deal moves to its type's is_won / is_lost stage when there is one
--        (lowest sort_order — nothing in the schema makes it unique), else keeps
--        its stage;
--      - Lost needs a reason, which lands on `deals.lost_reason` and NEVER in an
--        event (SEC-03); the `lost` payload is `{ stage? }`, `won` is
--        `{ override, final_value?, stage?, offer_id? }`, `won_override` is
--        `{ reason }` with its fixed English sentence.
--    Additions, each small: `won` names the accepted offer that justified it
--    (`offer_id`, an id — SEC-03 permits it); the offer is read in the deal's
--    OWN organisation (offers.deal_id carries no tenant FK), newest first as the
--    dialog's prefill reads it, and FOR SHARE, so it cannot be withdrawn
--    between the check and the commit; NaN — which numeric admits and which
--    passes ">= 0" — is refused as a price whether typed or taken from the
--    offer; the reason is trimmed with exactly the characters JavaScript's
--    trim() removes and measured in UTF-16 units, as the form's zod rule is, so
--    the database never refuses what the form accepted; and a close clears the
--    OTHER outcome's columns, so a row never carries both.
--
--    Refusals are `raise exception '<sentence>'` (P0001), the repo convention:
--    the action shows the sentence. The deal id cannot be used as an oracle:
--    the role check runs before any deal is read (a listing manager is refused
--    THERE), and a deal the caller cannot see — another organisation's, another
--    agent's — is 'Deal not found'. The permission sentence after the lock is a
--    defensive fallback; under today's policies no admin or agent can see a
--    deal without being able to lock it.
--
--    EXECUTE: authenticated only. Not anon, and not service_role: a close needs
--    an accountable actor (events_insert binds actor_id to auth.uid()) and the
--    service role would bypass every policy above.
--
-- B. deals_closed_guard — a BEFORE UPDATE trigger binding USER SESSIONS
--    (PostgREST's `authenticated` and `anon`) on a row that is ALREADY won or
--    lost: it refuses (i) the other terminal status, (ii) reopening, and
--    (iii) any change to the closing details (won_at, lost_at, lost_reason,
--    final_value, stage_id, stage_entered_at). This is what protects the window
--    this repo always has — the hosted migration lands BEFORE the app that
--    calls close_deal deploys: the deployed actions' competing second UPDATE now
--    fails before they reach their logEvent, so no outcome is overwritten and no
--    second terminal event is written — and it stops a direct PATCH flipping a
--    closed deal, in one request or in two (reopen, then close).
--    It does NOT bind the maintenance roles — service_role, postgres, and
--    SECURITY DEFINER bodies owned by postgres. That is deliberate: it is the
--    operator's correction path (a mistyped final value, corrected there with
--    its event by hand) and a future reopen workflow's (a definer RPC with its
--    own event). FOR THE PENDING ERASURE DECISION (BACKLOG): contact erasure
--    writes on the admin's USER session — only its notes redaction and storage
--    go through the service role — so a step that blanks `deals.lost_reason`
--    must run on the admin client or in a definer function; written like its
--    neighbours, on the user session, this guard refuses it. No
--    reopen or correction workflow exists today, and no writer surveyed on
--    2026-09-25 touches those columns on a closed row (updateDealSection,
--    recomputeDealHealth, logDealContact, leads.logConversation, the offer
--    paths, mergeContacts, the supersede trigger).
--
-- NOT DONE HERE (BACKLOG): a direct PostgREST PATCH can still take an OPEN deal
-- to won/lost without close_deal (no accepted-offer check, no event). Refusing
-- that is deploy-coupled — it would refuse the deployed actions' own closes
-- until the new app ships — so it belongs in a later migration applied AFTER
-- the deploy. The Won follow-ups (the listing-status and live-hold prompts, the
-- health recompute) stay app-side after the commit, run only by the request
-- that committed the close.
--
-- Pins that move with this file: the migrations count (116 -> 117) and two
-- grants rows in scripts/backup/verify-restore.sql; database.types.ts gains
-- close_deal.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- A. close_deal
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
security invoker
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
  -- 1. who is asking — from the session, never from a parameter
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

  -- 4. the row, locked. A row lock under RLS needs the SELECT *and* the UPDATE
  --    policy, so a caller who may look but not change gets no row here.
  select id, org_id, deal_type, status, stage_id, property_id, agent_id
    into v_deal
    from deals
   where id = p_deal_id and org_id = v_org
     for no key update;
  if not found then
    -- defensive: under today's policies an admin or agent who can see a deal
    -- can also lock it, so this sentence is not reached
    if exists (select 1 from deals where id = p_deal_id and org_id = v_org) then
      raise exception 'You do not have permission to close this deal';
    end if;
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
      from offers o
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
      from deal_stages s
     where s.org_id = v_deal.org_id and s.deal_type = v_deal.deal_type and s.is_won
     order by s.sort_order, s.id
     limit 1;

    update deals
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
      raise exception 'You do not have permission to close this deal';
    end if;

    if v_override then
      insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
      values (v_deal.org_id, v_uid, 'deal', v_deal.id, 'won_override',
              jsonb_build_object('reason', 'marked won without an accepted offer'));
    end if;
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
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
      from deal_stages s
     where s.org_id = v_deal.org_id and s.deal_type = v_deal.deal_type and s.is_lost
     order by s.sort_order, s.id
     limit 1;

    update deals
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
      raise exception 'You do not have permission to close this deal';
    end if;

    -- the act and the stage; the reason stays on the row (SEC-03)
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
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

revoke execute on function public.close_deal(uuid, text, numeric, text, boolean) from public, anon, service_role;
grant  execute on function public.close_deal(uuid, text, numeric, text, boolean) to authenticated;

comment on function public.close_deal(uuid, text, numeric, text, boolean) is
  'Marks an OPEN deal won or lost in one transaction: row lock, status checked under it, '
  'guarded rules (accepted offer or admin override; mandatory lost reason), the UPDATE and '
  'every event of the close. A deal already closed is left untouched and answered '
  '{result: already_closed | conflict}. SECURITY INVOKER — RLS and require_aal2 apply (0117).';

-- ---------------------------------------------------------------------------
-- B. deals_closed_guard
-- ---------------------------------------------------------------------------
create or replace function public.trg_deals_closed_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.status = 'open' then
    return new;
  end if;
  -- user sessions only; the maintenance roles are the correction path (header)
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
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
  before update on public.deals
  for each row execute function public.trg_deals_closed_guard();

-- ---------------------------------------------------------------------------
-- Apply-time assertions. The behaviour needs sessions and is proven by
-- supabase/tests/deal-close.test.ts (database) and deal-close-actions.test.ts
-- (the real actions); here the shape.
-- ---------------------------------------------------------------------------
do $$
declare
  n   int;
  src text;
  sig constant text := 'public.close_deal(uuid,text,numeric,text,boolean)';
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'close_deal';
  if n <> 1 then raise exception '0117 aborted: expected one close_deal, found %', n; end if;

  select p.prosrc into src from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'close_deal'
     and not p.prosecdef and 'search_path=public' = any (p.proconfig)
     and p.prorettype = 'jsonb'::regtype
     and pg_get_function_identity_arguments(p.oid)
         = 'p_deal_id uuid, p_outcome text, p_final_value numeric, p_lost_reason text, p_override boolean';
  if src is null then
    raise exception '0117 aborted: close_deal lost its signature, jsonb return, SECURITY INVOKER or search_path';
  end if;
  -- read the CODE: comments stripped, so a word or a semicolon in one can
  -- neither satisfy nor blind the checks below
  src := regexp_replace(src, '--[^\n]*', '', 'g');
  if src !~* 'for no key update'
     or (select count(*) from regexp_matches(src, 'where id = v_deal.id and status = ''open''', 'g')) <> 2 then
    raise exception '0117 aborted: close_deal no longer locks the row and folds status = open into both UPDATEs';
  end if;
  -- SEC-03 tripwire (the behavioural proof is the DB test): no event insert
  -- mentions the reason — and all three inserts are read to their payload
  if (select count(*) from regexp_matches(src, 'into events[^;]*jsonb_build_object', 'g')) <> 3 then
    raise exception '0117 aborted: the SEC-03 check no longer reads all three event inserts';
  end if;
  if src ~* 'into events[^;]*(v_reason|p_lost_reason|lost_reason)' then
    raise exception '0117 aborted: a close_deal event carries the lost reason';
  end if;

  if has_function_privilege('anon', sig, 'execute')
     or has_function_privilege('service_role', sig, 'execute')
     or not has_function_privilege('authenticated', sig, 'execute') then
    raise exception '0117 aborted: close_deal grants are wrong';
  end if;
  if has_function_privilege('authenticated', 'public.trg_deals_closed_guard()', 'execute')
     or has_function_privilege('anon', 'public.trg_deals_closed_guard()', 'execute')
     or has_function_privilege('service_role', 'public.trg_deals_closed_guard()', 'execute') then
    raise exception '0117 aborted: the guard trigger body is callable';
  end if;

  select count(*) into n from pg_trigger t
   where t.tgrelid = 'public.deals'::regclass and t.tgname = 'deals_closed_guard' and not t.tgisinternal
     and t.tgfoid = 'public.trg_deals_closed_guard()'::regprocedure
     and (t.tgtype & 2) = 2      -- BEFORE
     and (t.tgtype & 1) = 1      -- FOR EACH ROW
     and (t.tgtype & 16) = 16;   -- UPDATE
  if n <> 1 then raise exception '0117 aborted: deals_closed_guard is not a BEFORE UPDATE row trigger on deals'; end if;

  -- without a session it refuses before it reads anything
  begin
    perform public.close_deal(gen_random_uuid(), 'lost', null, 'probe reason', false);
    raise exception '0117 aborted: close_deal ran without a session';
  exception
    when raise_exception then
      if sqlerrm <> 'Not authenticated.' then raise; end if;
  end;

  raise notice '0117: close_deal (invoker, authenticated only) and deals_closed_guard installed';
end $$;
