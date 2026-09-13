-- =============================================================================
-- 0094 — a conversation's words live in a table; the chain carries their digest
--        (audit 2026-09-13, SEC-03)
--
-- WHAT WAS WRONG. `events` is hash-chained, append-only and deliberately left
-- alone by erasure (0017). Three actions wrote a logged conversation's text
-- into it verbatim (`conversation_logged.payload.note`), and a contact's phone
-- and e-mail went into its `created` event. So an Article 17 erasure blanked
-- the contact row and the lead messages and left the person's number, address
-- and every note the desk had written about them readable for ever, in the
-- one table no policy lets anyone update. Nothing rendered the note either —
-- the timeline printed only the channel — so the chain held the most personal
-- text in the system and showed it to nobody.
--
-- WHAT CHANGES. The text moves to `interaction_notes`, an ordinary org-scoped
-- row that erasure and the retention sweep can blank. The event keeps what a
-- chain is for — that a conversation was logged, when, by whom, over which
-- channel — plus the note's id and SHA-256, so it still proves what was
-- written without holding it. (Identifiers in `created` payloads become
-- has_phone / has_email in the application; no migration is needed there.)
--
-- HOW A NOTE GETS ITS EVENT. An AFTER INSERT trigger writes the
-- `conversation_logged` event, so no insert path — the RPC, a direct insert,
-- a future importer — can add a note the chain does not know about, and the
-- digest in the event is computed by the database from the stored text, not
-- supplied by a caller. `log_conversation` is the API: it validates, finds the
-- entity's org through the caller's OWN read (SECURITY INVOKER — RLS decides
-- whether the lead, contact or deal exists for this session), inserts as the
-- caller and returns the id. The text is immutable except to be blanked:
-- there is no UPDATE grant for authenticated, and a BEFORE UPDATE trigger
-- refuses any rewrite that is not a redaction, so the digest in the chain
-- always describes the text that was there.
--
-- WHO BLANKS. Contact erasure (service role, after its admin check) and
-- `redact_stale_enquiries`, which now blanks the notes of the enquiries it
-- redacts — the desk's words about an enquiry go with its message.
--
-- Events written before this migration keep their inline note; the timeline
-- reader renders both shapes. Additive: apply to hosted BEFORE the merge.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
create table if not exists public.interaction_notes (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  entity_type text not null check (entity_type in ('lead', 'contact', 'deal')),
  entity_id   uuid not null,
  channel     public.comm_channel not null,
  -- null once redacted; the digest stays so the chain still verifies
  body        text,
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  redacted_at timestamptz,
  -- readable or redacted, never half of each
  constraint interaction_notes_redacted_shape check ((body is null) = (redacted_at is not null)),
  constraint interaction_notes_body_not_blank check (body is null or length(btrim(body)) > 0)
);

create index if not exists interaction_notes_entity_idx
  on public.interaction_notes (org_id, entity_type, entity_id, created_at desc);

comment on table public.interaction_notes is
  'The text of a logged conversation (0094). One row per note; the '
  'conversation_logged event carries the row''s id and SHA-256, never the '
  'text, so erasure and the retention sweep can blank `body` (setting '
  'redacted_at) while the hash chain stays intact. Insert through '
  'log_conversation(); the AFTER INSERT trigger writes the event.';

-- ---------------------------------------------------------------------------
-- 2. Grants and RLS
-- ---------------------------------------------------------------------------
alter table public.interaction_notes enable row level security;

revoke all privileges on table public.interaction_notes from anon;
revoke all privileges on table public.interaction_notes from authenticated;
-- SELECT and INSERT only. No UPDATE or DELETE for a session: redaction is the
-- service role's business (erasure, the nightly sweep), and a note is never
-- rewritten — see the BEFORE UPDATE trigger below.
grant select, insert on table public.interaction_notes to authenticated;

drop policy if exists interaction_notes_select on public.interaction_notes;
create policy interaction_notes_select on public.interaction_notes for select
  using (org_id = (select public.current_org_id()));

drop policy if exists interaction_notes_insert on public.interaction_notes;
create policy interaction_notes_insert on public.interaction_notes for insert
  with check (org_id = (select public.current_org_id())
              and created_by = (select auth.uid()));

-- A TABLE CREATED AFTER 0029 DOES NOT INHERIT require_aal2 (0066, 0084
-- learned this on their first test run); rls_aal2_coverage() must stay at 0.
drop policy if exists require_aal2 on public.interaction_notes;
create policy require_aal2 on public.interaction_notes
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));

-- ---------------------------------------------------------------------------
-- 3. Triggers: the digest is the database's, the event is mandatory, the
--    text is immutable except to be blanked
-- ---------------------------------------------------------------------------
create or replace function public.trg_interaction_notes_before()
returns trigger
language plpgsql
set search_path = public as $fn$
begin
  if tg_op = 'INSERT' then
    if new.body is null or length(btrim(new.body)) = 0 then
      raise exception 'interaction_notes: a note needs a body' using errcode = 'check_violation';
    end if;
    new.body_sha256 := encode(sha256(convert_to(new.body, 'UTF8')), 'hex');
    new.created_by  := coalesce(new.created_by, auth.uid());
    new.redacted_at := null;
    return new;
  end if;

  -- UPDATE: the only permitted change is body -> null with redacted_at set.
  if new.body is not null and new.body is distinct from old.body then
    raise exception 'interaction_notes: a note''s text is immutable — redact it, do not rewrite it'
      using errcode = 'check_violation';
  end if;
  if new.body_sha256 is distinct from old.body_sha256 then
    raise exception 'interaction_notes: the digest is the chain''s and cannot change'
      using errcode = 'check_violation';
  end if;
  return new;
end $fn$;

create or replace function public.trg_interaction_notes_after_insert()
returns trigger
language plpgsql
set search_path = public as $fn$
begin
  -- Runs as the caller: events_insert (0071) binds actor_id to auth.uid(), and
  -- the note's created_by is exactly that, so a session cannot file a note —
  -- or its event — under anyone else's name. The service role passes as ever.
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (new.org_id, new.created_by, new.entity_type, new.entity_id, 'conversation_logged',
          jsonb_build_object('channel', new.channel::text,
                             'note_id', new.id,
                             'note_sha256', new.body_sha256));
  return new;
end $fn$;

drop trigger if exists interaction_notes_before on public.interaction_notes;
create trigger interaction_notes_before
  before insert or update on public.interaction_notes
  for each row execute function public.trg_interaction_notes_before();

drop trigger if exists interaction_notes_after_insert on public.interaction_notes;
create trigger interaction_notes_after_insert
  after insert on public.interaction_notes
  for each row execute function public.trg_interaction_notes_after_insert();

-- Trigger functions are fired by the trigger, never called; strip the PUBLIC
-- =X grant a new function carries (the 0044 lesson) so PostgREST lists nothing.
revoke execute on function public.trg_interaction_notes_before() from public, anon, authenticated;
revoke execute on function public.trg_interaction_notes_after_insert() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. The API
-- ---------------------------------------------------------------------------
create or replace function public.log_conversation(
  p_entity_type text,
  p_entity_id   uuid,
  p_channel     public.comm_channel,
  p_note        text
)
returns uuid
language plpgsql
security invoker
set search_path = public as $fn$
declare
  v_org uuid;
  v_id  uuid;
begin
  if p_note is null or length(btrim(p_note)) = 0 then
    raise exception 'log_conversation: the note is empty' using errcode = 'check_violation';
  end if;
  if p_entity_type not in ('lead', 'contact', 'deal') then
    raise exception 'log_conversation: notes attach to a lead, a contact or a deal, not a %', p_entity_type
      using errcode = 'check_violation';
  end if;

  -- The caller's own read: RLS decides whether this row exists for them, so
  -- an id from another org, or one this agent may not see, is "not found".
  v_org := case p_entity_type
             when 'lead'    then (select org_id from leads    where id = p_entity_id)
             when 'contact' then (select org_id from contacts where id = p_entity_id)
             when 'deal'    then (select org_id from deals    where id = p_entity_id)
           end;
  if v_org is null then
    raise exception 'log_conversation: no % with id % is visible to you', p_entity_type, p_entity_id
      using errcode = 'no_data_found';
  end if;

  insert into interaction_notes (org_id, entity_type, entity_id, channel, body)
  values (v_org, p_entity_type, p_entity_id, p_channel, btrim(p_note))
  returning id into v_id;
  return v_id;
end $fn$;

comment on function public.log_conversation(text, uuid, public.comm_channel, text) is
  'Records a conversation (0094): inserts the note as the caller and returns '
  'its id; the AFTER INSERT trigger files the conversation_logged event with '
  'the note''s id and SHA-256. SECURITY INVOKER — RLS decides whether the '
  'entity exists for this session and whether the insert is allowed.';

revoke execute on function public.log_conversation(text, uuid, public.comm_channel, text) from public, anon;
grant  execute on function public.log_conversation(text, uuid, public.comm_channel, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. The retention sweep blanks the notes of the enquiries it redacts
--    (0092's body, plus the `notes` CTE — `create or replace` keeps the ACL)
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
  notes as (
    update interaction_notes n
       set body = null, redacted_at = now()
      from done
     where n.entity_type = 'lead'
       and n.entity_id = done.id
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
  'and blanks the interaction_notes on those leads (0094). '
  'One `redacted` event per row with a null actor and a shape-only payload. '
  'Returns the number of rows redacted. A lead with a contact is the contact''s '
  'erasure''s business (0017). Idempotent: an already-redacted row is skipped.';

-- ---------------------------------------------------------------------------
-- 6. Self-check — abort rather than land a half-shaped table
-- ---------------------------------------------------------------------------
do $$
declare
  n    int;
  def  text;
  acl  text;
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'interaction_notes' and rowsecurity) then
    raise exception '0094 aborted: interaction_notes missing or RLS off';
  end if;

  select count(*) into n from public.rls_aal2_coverage();
  if n <> 0 then
    raise exception '0094 aborted: % RLS table(s) lack require_aal2', n;
  end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'interaction_notes'
     and policyname in ('interaction_notes_select', 'interaction_notes_insert', 'require_aal2');
  if n <> 3 then
    raise exception '0094 aborted: expected 3 policies on interaction_notes, found %', n;
  end if;

  if has_table_privilege('authenticated', 'public.interaction_notes', 'update')
     or has_table_privilege('authenticated', 'public.interaction_notes', 'delete')
     or has_table_privilege('anon', 'public.interaction_notes', 'select') then
    raise exception '0094 aborted: interaction_notes grants are wider than select+insert for authenticated';
  end if;

  select count(*) into n from pg_trigger
   where tgrelid = 'public.interaction_notes'::regclass
     and tgname in ('interaction_notes_before', 'interaction_notes_after_insert');
  if n <> 2 then
    raise exception '0094 aborted: expected both triggers on interaction_notes, found %', n;
  end if;

  if has_function_privilege('anon', 'public.log_conversation(text, uuid, public.comm_channel, text)', 'execute') then
    raise exception '0094 aborted: anon can execute log_conversation';
  end if;
  if not has_function_privilege('authenticated', 'public.log_conversation(text, uuid, public.comm_channel, text)', 'execute') then
    raise exception '0094 aborted: authenticated cannot execute log_conversation';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.log_conversation(text, uuid, public.comm_channel, text)'::regprocedure) then
    raise exception '0094 aborted: log_conversation must be SECURITY INVOKER';
  end if;

  def := pg_get_functiondef('public.redact_stale_enquiries(int)'::regprocedure);
  if def !~ 'interaction_notes' or def !~* 'integer DEFAULT 24' then
    raise exception '0094 aborted: redact_stale_enquiries does not blank notes or lost its default';
  end if;
  if has_function_privilege('anon', 'public.redact_stale_enquiries(int)', 'execute')
     or has_function_privilege('authenticated', 'public.redact_stale_enquiries(int)', 'execute') then
    raise exception '0094 aborted: redact_stale_enquiries became executable by anon or authenticated';
  end if;

  select array_to_string(proacl, ',') into acl
    from pg_proc where oid = 'public.redact_stale_enquiries(int)'::regprocedure;
  raise notice '0094: interaction_notes live (3 policies, 2 triggers); log_conversation invoker; sweep blanks notes; sweep acl %', acl;
end $$;
