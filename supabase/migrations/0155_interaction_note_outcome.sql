-- =============================================================================
-- 0155 — a logged conversation says what happened: the desk spoke to the
-- person, sent a message that has had no reply yet, or the client replied
-- (A06-b, product review 2026-10-18).
--
-- THE DEFECT. The three Log-conversation dialogs (the inbox's Log, a
-- contact's Log contact, a deal's Log contact) record THAT a conversation
-- was logged and over which channel, and nothing about how it went. "I sent
-- a WhatsApp, no reply yet" and "they rang back" read the same on a
-- customer's history — "Conversation logged (WhatsApp)" — so a colleague
-- cannot tell a buyer who answered from one who went quiet. A chat-link
-- click is a different thing again (link click only, A06-a) and stays one:
-- there is no messaging API (Do-Not-Build), so whatever is said here is the
-- agent's own claim, made deliberately in a dialog.
--
-- THE FIX.
--   1. interaction_notes.outcome: nullable text, CHECK one of 'spoke',
--      'message_sent', 'client_replied' (added NOT VALID, then VALIDATEd in
--      this transaction, so it ends validated). NULL is "not said": every
--      note before 0155, and a caller that passes none.
--   2. trg_interaction_notes_before: the outcome is immutable like the body.
--      An UPDATE that changes it is refused (check_violation), for every
--      writer. A redaction (body -> null) still passes and keeps it: it is
--      not the person's data, it is what the desk said happened.
--   3. trg_interaction_notes_after_insert: the conversation_logged payload
--      adds `outcome` when the note has one. A note without one is chained
--      exactly as 0094 chained it: channel, note_id, note_sha256.
--   4. log_conversation gains a trailing `p_outcome text DEFAULT NULL`,
--      checked against the same three words, and stores it on the note. The
--      four-argument function is DROPPED first and the five-argument one
--      created, so exactly one log_conversation exists and no call can be
--      ambiguous between two overloads. SECURITY INVOKER, search_path, the
--      return type, the comment and the grants (authenticated and
--      service_role; not PUBLIC, not anon) are as 0094 set them.
--   The application's no-note path (a contact's or a deal's Log contact
--   with no note) writes {channel, outcome} through logEvent; that needs no
--   migration.
--
-- WHAT DOES NOT CHANGE. The clock rules: any logged conversation, whatever
-- its outcome, still stamps a lead's first_response_at and a deal's
-- last_contact_at in the application (doc 02 §C4, 0025) — a message the
-- agent says they sent IS the agency's response — and a chat-link click
-- never does. RLS, the table's grants (select and insert for
-- authenticated), its indexes and the retention sweep are untouched.
--
-- EXISTING DATA. Nothing is rewritten. Every existing note reads outcome
-- NULL, and every event keeps the payload it was chained with.
--
-- LOCKS. ADD COLUMN and ADD CONSTRAINT take ACCESS EXCLUSIVE on
-- interaction_notes; the preflight takes it FIRST, so no lock is upgraded
-- later and no note lands between the checks and the DDL. For the
-- milliseconds this file runs, logging a conversation with a note waits.
-- lock_timeout bounds the wait (5 s): a collision costs a clean 55P03 —
-- apply again, and do NOT write the ledger row.
--
-- DEPLOY ORDER: hosted BEFORE the application that sends p_outcome — and
-- that order is MANDATORY, not a preference. The deployed application calls
-- log_conversation with the four NAMED arguments p_entity_type, p_entity_id,
-- p_channel and p_note; that call resolves to the new function through the
-- default, so applying this first breaks nothing (pinned over PostgREST as a
-- signed-in agent in supabase/tests/interaction-note-outcome.test.ts).
-- The other way round does NOT fail cleanly. The new application against a
-- database without 0155 gets PGRST202 for every call that names p_outcome —
-- and the dialogs always send one (Spoke is preselected) — so no note and no
-- conversation_logged event are written and the dialog shows the error. But
-- two of the three actions write a clock BEFORE that call (A06-b review):
--   - the inbox's Log (logConversation, where a note is required) has
--     already stamped the lead's first_response_at and moved a 'new' lead
--     to 'contacted';
--   - a deal's Log contact with a note (logDealContact) has already moved
--     the deal's last_contact_at and last_activity_at.
-- Each such failure leaves a lead marked answered, or a deal's no-contact
-- nudge silenced, with no logged contact behind it — the state A06 exists
-- to prevent. Only a contact's Log contact writes nothing (it has no
-- clock), and a log with no note (contact or deal) works either way: it
-- goes through logEvent. So: hosted first, then merge.
-- lib/supabase/database.types.ts: log_conversation's Args gain
-- p_outcome?: string; interaction_notes gains outcome.
--
-- ROLLBACK: the application first (to a release that does not send
-- p_outcome — mandatory, for the reason above: the new application against
-- the reverted database stamps those clocks and then fails), then a
-- FORWARD migration under the same bounded lock
-- (supabase/tests/revert-0155.ts holds the text): drop the five-argument
-- function and re-create 0094's four-argument one with its comment and
-- grants, restore 0094's two trigger bodies, drop the CHECK and the column.
-- The outcome of each note logged meanwhile stays in its conversation_logged
-- event — the chain is never rewritten — and the column's copy goes. Move
-- the verify-restore migrations pin forward and remove its 0155 row.
--
-- NUMBERING: 0150/0151 are the portal session's and 0152–0154 this
-- review's other streams'; the ledger tolerates gaps and an out-of-order
-- apply (0140, 0141's header).
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count and one 0155 row); lib/supabase/database.types.ts.
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3), as does one
-- execute_sql call; applied hosted inside the md5-guarded DO (DECISIONS
-- T-unit-type-apply-atomic), where a clean return with no rows is the success
-- signal. The file's LAST result is a read-only summary for the CLI.
-- =============================================================================

-- Bounded lock waits (0113's lesson); see LOCKS above.
set local lock_timeout = '5s';

-- The file must run as ONE transaction (the CLI's wrapper, or one
-- execute_sql call): otherwise SET LOCAL is a no-op, the preflight's LOCK is
-- released as soon as its statement ends, and a failed assertion would not
-- undo the DDL before it.
do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0155 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0. Preflight — the table, its two triggers and the three functions are
--    what this file was written against (or this file's own, on a replay)
-- ---------------------------------------------------------------------------
do $$
declare
  f          record;
  v_md5      text;
  v_fn       oid;
  v_old      oid := to_regprocedure('public.log_conversation(text, uuid, public.comm_channel, text)');
  v_new      oid := to_regprocedure('public.log_conversation(text, uuid, public.comm_channel, text, text)');
  n_missing  int;
  n_unknown  int;
  n_fns      int;
begin
  -- the lock the DDL below needs, at its strongest, BEFORE anything is read
  lock table public.interaction_notes in access exclusive mode;

  -- 1. the table is 0094's ten columns — plus this file's nullable text
  --    `outcome` on a replay, and nothing else
  with want(name, typ, required) as (
    values ('id', 'uuid'::regtype, true), ('org_id', 'uuid'::regtype, true),
           ('entity_type', 'text'::regtype, true), ('entity_id', 'uuid'::regtype, true),
           ('channel', 'public.comm_channel'::regtype, true), ('body', 'text'::regtype, false),
           ('body_sha256', 'text'::regtype, true), ('created_by', 'uuid'::regtype, false),
           ('created_at', 'timestamptz'::regtype, true), ('redacted_at', 'timestamptz'::regtype, false)
  ), have as (
    select a.attname::text as name, a.atttypid::regtype as typ, a.attnotnull as required
      from pg_attribute a
     where a.attrelid = 'public.interaction_notes'::regclass and a.attnum > 0 and not a.attisdropped
  )
  select (select count(*) from want w where not exists (select 1 from have h where (h.name, h.typ, h.required) = (w.name, w.typ, w.required))),
         (select count(*) from have h
           where not exists (select 1 from want w where (w.name, w.typ, w.required) = (h.name, h.typ, h.required))
             and not (h.name = 'outcome' and h.typ = 'text'::regtype and not h.required))
    into n_missing, n_unknown;
  if n_missing <> 0 or n_unknown <> 0 then
    raise exception '0155 aborted: public.interaction_notes is not 0094''s table (% of its columns changed or missing, % unknown) — nothing was changed', n_missing, n_unknown;
  end if;

  -- 2. a session reads and inserts notes and never updates or deletes one
  --    (0094); the outcome's immutability rests on that as well as on the
  --    trigger
  if has_table_privilege('authenticated', 'public.interaction_notes', 'update')
     or has_table_privilege('authenticated', 'public.interaction_notes', 'delete')
     or has_table_privilege('anon', 'public.interaction_notes', 'select')
     or has_table_privilege('anon', 'public.interaction_notes', 'insert') then
    raise exception '0155 aborted: the grants on public.interaction_notes are wider than 0094''s (select and insert for authenticated, nothing for anon) — nothing was changed';
  end if;

  -- 3. both of 0094's row triggers, enabled: the BEFORE one on INSERT OR
  --    UPDATE (tgtype 1|2|4|16 = 23), the AFTER one on INSERT (1|4 = 5)
  if (select count(*) from pg_trigger t
       where t.tgrelid = 'public.interaction_notes'::regclass and not t.tgisinternal
         and t.tgenabled = 'O' and t.tgqual is null and t.tgnargs = 0
         and ((t.tgname = 'interaction_notes_before'
               and t.tgfoid = to_regprocedure('public.trg_interaction_notes_before()') and t.tgtype = 23)
           or (t.tgname = 'interaction_notes_after_insert'
               and t.tgfoid = to_regprocedure('public.trg_interaction_notes_after_insert()') and t.tgtype = 5))) <> 2 then
    raise exception '0155 aborted: public.interaction_notes does not carry 0094''s two enabled row triggers — nothing was changed';
  end if;

  -- 4. the two trigger bodies are 0094's — or this file's own, on a replay.
  --    Digests of md5(replace(prosrc, chr(13), '')); hosted's equal the
  --    repository's (read 2026-10-18).
  for f in
    select * from (values
      ('public.trg_interaction_notes_before()',
       '61b4ab8acfb61fa9540b63c5a1b2548a', '17cfe075677f0c15a905250b731bcd64'),
      ('public.trg_interaction_notes_after_insert()',
       'eab83d599ecd9523d928b7038bb488db', 'c7d880a431bb622af9eed53c9adf3a32')
    ) as x(sig, before_md5, after_md5)
  loop
    select md5(replace(p.prosrc, chr(13), '')) into v_md5
      from pg_proc p
     where p.oid = to_regprocedure(f.sig) and not p.prosecdef
       and pg_get_userbyid(p.proowner) = 'postgres'
       and p.prorettype = 'trigger'::regtype
       and p.proconfig = array['search_path=public'];
    if v_md5 is null then
      raise exception '0155 aborted: % is not the SECURITY INVOKER trigger function owned by postgres with search_path=public this file replaces — nothing was changed', f.sig;
    end if;
    if v_md5 <> f.before_md5 and v_md5 <> f.after_md5 then
      raise exception '0155 aborted: the body of % is not 0094''s (md5 %) — read it before replacing it; nothing was changed', f.sig, v_md5;
    end if;
    -- fired by its trigger, never called: no session may call it (0094)
    if has_function_privilege('anon', f.sig, 'execute') or has_function_privilege('authenticated', f.sig, 'execute') then
      raise exception '0155 aborted: anon or authenticated may execute % — nothing was changed', f.sig;
    end if;
  end loop;

  -- 5. exactly one log_conversation: 0094's (text, uuid, comm_channel, text),
  --    or this file's with p_outcome on a replay — never both, never another
  select count(*) into n_fns
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'log_conversation';
  if n_fns <> 1 then
    raise exception '0155 aborted: there are % functions named public.log_conversation; this file replaces exactly one — nothing was changed', n_fns;
  end if;
  v_fn := coalesce(v_old, v_new);
  if v_fn is null then
    raise exception '0155 aborted: public.log_conversation is neither 0094''s (text, uuid, comm_channel, text) nor this file''s — nothing was changed';
  end if;
  select md5(replace(p.prosrc, chr(13), '')) into v_md5
    from pg_proc p
   where p.oid = v_fn and not p.prosecdef
     and pg_get_userbyid(p.proowner) = 'postgres'
     and p.prorettype = 'uuid'::regtype and not p.proretset
     and p.proconfig = array['search_path=public']
     and ((v_fn = v_old and p.proargnames = array['p_entity_type', 'p_entity_id', 'p_channel', 'p_note'] and p.pronargdefaults = 0)
       or (v_fn = v_new and p.proargnames = array['p_entity_type', 'p_entity_id', 'p_channel', 'p_note', 'p_outcome']
           and p.pronargdefaults = 1 and pg_get_expr(p.proargdefaults, 0) = 'NULL::text'));
  if v_md5 is null then
    raise exception '0155 aborted: public.log_conversation is not the SECURITY INVOKER uuid function owned by postgres with search_path=public and the named arguments this file replaces — nothing was changed';
  end if;
  if (v_fn = v_old and v_md5 <> 'd1285100ee6c5aafc3710ee182645c52')
     or (v_fn = v_new and v_md5 <> '1f809ba10b05116ec81f9b129d02e26a') then
    raise exception '0155 aborted: the body of public.log_conversation is not 0094''s (md5 %) — read it before replacing it; nothing was changed', v_md5;
  end if;
  -- the grants this file keeps: authenticated and service_role may call it; anon and PUBLIC may not
  if has_function_privilege('anon', v_fn, 'execute')
     or not has_function_privilege('authenticated', v_fn, 'execute')
     or not has_function_privilege('service_role', v_fn, 'execute')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where p.oid = v_fn and a.grantee = 0) then
    raise exception '0155 aborted: the grants on public.log_conversation are not authenticated + service_role without anon or PUBLIC — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The column, and its three words for every writer — NOT VALID, then
--    VALIDATE, in this transaction (so it ends validated; the postflight
--    asserts it)
-- ---------------------------------------------------------------------------
alter table public.interaction_notes add column if not exists outcome text;

-- Replay guard (0077's idiom): drop-if-exists before the add.
alter table public.interaction_notes drop constraint if exists interaction_notes_outcome_check;
alter table public.interaction_notes
  add constraint interaction_notes_outcome_check
  check (outcome is null or outcome in ('spoke', 'message_sent', 'client_replied')) not valid;
alter table public.interaction_notes validate constraint interaction_notes_outcome_check;

comment on column public.interaction_notes.outcome is
  'What the desk said happened (0155, A06-b): spoke, message_sent (no reply '
  'yet) or client_replied — the agent''s own claim from a Log-conversation '
  'dialog, never synchronised from a messaging app. NULL = not said (every '
  'note before 0155). Immutable once written (trg_interaction_notes_before); '
  'the conversation_logged event carries it.';

comment on constraint interaction_notes_outcome_check on public.interaction_notes is
  'A note''s outcome is one of spoke, message_sent, client_replied, or not said (NULL), for every writer (0155).';

-- ---------------------------------------------------------------------------
-- 2. The triggers: the outcome is fixed with the note, and its event says it
--    (CREATE OR REPLACE keeps the OIDs, so the triggers and the revoked ACLs)
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
  -- 0155: what the desk said happened is fixed with the note, as its event
  -- carries it; a redaction blanks the text and keeps the outcome.
  if new.outcome is distinct from old.outcome then
    raise exception 'interaction_notes: a note''s outcome is immutable — log the conversation again instead'
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
  -- 0155: the outcome joins the payload when the note has one; a note without
  -- one is chained exactly as 0094 chained it.
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (new.org_id, new.created_by, new.entity_type, new.entity_id, 'conversation_logged',
          jsonb_build_object('channel', new.channel::text,
                             'note_id', new.id,
                             'note_sha256', new.body_sha256)
          || case when new.outcome is null then '{}'::jsonb
                  else jsonb_build_object('outcome', new.outcome) end);
  return new;
end $fn$;

-- ---------------------------------------------------------------------------
-- 3. The API: log_conversation takes the outcome. 0094's four-argument
--    function goes first, so exactly one log_conversation exists; the
--    deployed four-named-argument call resolves through the default.
-- ---------------------------------------------------------------------------
drop function if exists public.log_conversation(text, uuid, public.comm_channel, text);

create or replace function public.log_conversation(
  p_entity_type text,
  p_entity_id   uuid,
  p_channel     public.comm_channel,
  p_note        text,
  p_outcome     text default null
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
  -- 0155: what happened, as the desk said it; NULL when the caller did not say
  if p_outcome is not null and p_outcome not in ('spoke', 'message_sent', 'client_replied') then
    raise exception 'log_conversation: the outcome must be spoke, message_sent or client_replied'
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

  insert into interaction_notes (org_id, entity_type, entity_id, channel, body, outcome)
  values (v_org, p_entity_type, p_entity_id, p_channel, btrim(p_note), p_outcome)
  returning id into v_id;
  return v_id;
end $fn$;

comment on function public.log_conversation(text, uuid, public.comm_channel, text, text) is
  'Records a conversation (0094; outcome 0155): inserts the note as the caller '
  'and returns its id; the AFTER INSERT trigger files the conversation_logged '
  'event with the note''s id and SHA-256, and its outcome when one is given '
  '(spoke, message_sent, client_replied; NULL = not said). SECURITY INVOKER — '
  'RLS decides whether the entity exists for this session and whether the '
  'insert is allowed.';

revoke execute on function public.log_conversation(text, uuid, public.comm_channel, text, text) from public, anon;
grant  execute on function public.log_conversation(text, uuid, public.comm_channel, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Postflight — the shape, then the behaviour, inside a block that undoes
--    what it writes
-- ---------------------------------------------------------------------------
do $$
declare
  v_fn       oid := to_regprocedure('public.log_conversation(text, uuid, public.comm_channel, text, text)');
  v_org      uuid := gen_random_uuid();
  v_contact  uuid;
  v_id       uuid;
  v_outcome  text;
  v_payload  jsonb;
  v_keys     text[];
  v_con      text;
begin
  -- the column and its validated CHECK, exactly
  if not exists (select 1 from pg_attribute a
                  where a.attrelid = 'public.interaction_notes'::regclass and a.attname = 'outcome'
                    and not a.attisdropped and a.atttypid = 'text'::regtype and not a.attnotnull and not a.atthasdef) then
    raise exception '0155 postflight: public.interaction_notes.outcome is not a nullable text column without a default';
  end if;
  if (select count(*) from pg_constraint c
       where c.conrelid = 'public.interaction_notes'::regclass and c.conname = 'interaction_notes_outcome_check'
         and c.contype = 'c' and c.convalidated
         and pg_get_constraintdef(c.oid) = 'CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY[''spoke''::text, ''message_sent''::text, ''client_replied''::text]))))') <> 1 then
    raise exception '0155 postflight: public.interaction_notes does not carry the validated CHECK interaction_notes_outcome_check';
  end if;

  -- one log_conversation, with p_outcome defaulted, closed to anon and PUBLIC
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'log_conversation') <> 1
     or not exists (select 1 from pg_proc p
                     where p.oid = v_fn and p.prorettype = 'uuid'::regtype and not p.proretset
                       and p.proargnames = array['p_entity_type', 'p_entity_id', 'p_channel', 'p_note', 'p_outcome']
                       and p.pronargdefaults = 1 and pg_get_expr(p.proargdefaults, 0) = 'NULL::text') then
    raise exception '0155 postflight: public.log_conversation is not the one five-argument function with p_outcome DEFAULT NULL';
  end if;
  if has_function_privilege('anon', v_fn, 'execute')
     or not has_function_privilege('authenticated', v_fn, 'execute')
     or not has_function_privilege('service_role', v_fn, 'execute')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where p.oid = v_fn and a.grantee = 0) then
    raise exception '0155 postflight: the grants on public.log_conversation are not authenticated + service_role without anon or PUBLIC';
  end if;
  if has_function_privilege('anon', 'public.trg_interaction_notes_before()', 'execute')
     or has_function_privilege('authenticated', 'public.trg_interaction_notes_before()', 'execute')
     or has_function_privilege('anon', 'public.trg_interaction_notes_after_insert()', 'execute')
     or has_function_privilege('authenticated', 'public.trg_interaction_notes_after_insert()', 'execute') then
    raise exception '0155 postflight: a session may execute an interaction_notes trigger function';
  end if;

  -- behaviour, undone: a throwaway organisation and contact, as the
  -- application reaches them — the deployed call, an outcome, a word that is
  -- not one, a rewrite, a redaction
  begin
    insert into public.organizations (id, name, slug) values (v_org, '0155 postflight', '0155-postflight-' || v_org::text);
    insert into public.contacts (org_id, first_name) values (v_org, '0155 postflight') returning id into v_contact;

    -- the deployed application's call: four NAMED arguments, no outcome
    v_id := public.log_conversation(p_entity_type => 'contact', p_entity_id => v_contact,
                                    p_channel => 'phone'::public.comm_channel, p_note => '0155 postflight');
    select n.outcome into v_outcome from public.interaction_notes n where n.id = v_id;
    select e.payload into v_payload from public.events e
     where e.org_id = v_org and e.event_type = 'conversation_logged' and e.payload ->> 'note_id' = v_id::text;
    select array_agg(k order by k) into v_keys from jsonb_object_keys(v_payload) k;
    if v_outcome is not null or v_keys is distinct from array['channel', 'note_id', 'note_sha256'] then
      raise exception '0155 postflight: a conversation logged without an outcome is not chained as 0094 chained it (outcome %, payload keys %)', v_outcome, v_keys;
    end if;

    -- an outcome lands on the note and in its event
    v_id := public.log_conversation(p_entity_type => 'contact', p_entity_id => v_contact,
                                    p_channel => 'whatsapp'::public.comm_channel, p_note => '0155 postflight',
                                    p_outcome => 'message_sent');
    select n.outcome into v_outcome from public.interaction_notes n where n.id = v_id;
    select e.payload into v_payload from public.events e
     where e.org_id = v_org and e.event_type = 'conversation_logged' and e.payload ->> 'note_id' = v_id::text;
    if v_outcome is distinct from 'message_sent' then
      raise exception '0155 postflight: log_conversation did not store the outcome on the note (read %)', v_outcome;
    end if;
    if v_payload ->> 'outcome' is distinct from 'message_sent' or v_payload ->> 'channel' is distinct from 'whatsapp' then
      raise exception '0155 postflight: the conversation_logged event of a note with an outcome does not carry it';
    end if;

    -- a word that is not an outcome: refused by the function, and by the table for every other writer
    begin
      perform public.log_conversation(p_entity_type => 'contact', p_entity_id => v_contact,
                                      p_channel => 'phone'::public.comm_channel, p_note => '0155 postflight',
                                      p_outcome => 'replied');
      raise exception '0155 postflight: log_conversation accepted an outcome that is not one of the three';
    exception
      when check_violation then null;
    end;
    begin
      insert into public.interaction_notes (org_id, entity_type, entity_id, channel, body, outcome)
      values (v_org, 'contact', v_contact, 'phone', '0155 postflight', 'replied');
      raise exception '0155 postflight: interaction_notes accepted an outcome that is not one of the three';
    exception
      when check_violation then
        get stacked diagnostics v_con = constraint_name;
        if v_con is distinct from 'interaction_notes_outcome_check' then
          raise exception '0155 postflight: an outcome that is not one of the three was refused by % rather than interaction_notes_outcome_check', coalesce(v_con, 'no constraint');
        end if;
    end;

    -- the outcome is immutable for every writer; a redaction passes and keeps it
    begin
      update public.interaction_notes set outcome = 'client_replied' where id = v_id;
      raise exception '0155 postflight: a note''s outcome could be rewritten';
    exception
      when check_violation then null;
    end;
    update public.interaction_notes set body = null, redacted_at = now() where id = v_id;
    if (select n.outcome from public.interaction_notes n where n.id = v_id) is distinct from 'message_sent' then
      raise exception '0155 postflight: a redaction lost the note''s outcome';
    end if;

    raise exception using errcode = 'P0001', message = '0155-postflight-undo';
  exception
    when raise_exception then
      if sqlerrm <> '0155-postflight-undo' then
        raise;
      end if;
  end;

  -- then the exact bodies: what behaves is also the text this file pins
  -- (SECURITY INVOKER, owned by postgres, search_path=public)
  if (select count(*) from pg_proc p
       where not p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres'
         and p.proconfig = array['search_path=public']
         and ((p.oid = to_regprocedure('public.trg_interaction_notes_before()')
               and md5(replace(p.prosrc, chr(13), '')) = '17cfe075677f0c15a905250b731bcd64')
           or (p.oid = to_regprocedure('public.trg_interaction_notes_after_insert()')
               and md5(replace(p.prosrc, chr(13), '')) = 'c7d880a431bb622af9eed53c9adf3a32')
           or (p.oid = v_fn
               and md5(replace(p.prosrc, chr(13), '')) = '1f809ba10b05116ec81f9b129d02e26a'))) <> 3 then
    raise exception '0155 postflight: the trigger functions and log_conversation are not the SECURITY INVOKER bodies this file wrote';
  end if;

  raise notice '0155: postflight passed — interaction_notes.outcome (validated CHECK, immutable, chained when said); one log_conversation with p_outcome DEFAULT NULL, invoker, closed to anon';
end $$;

-- for the CLI: a read-only summary (a guarded hosted apply discards it)
select '0155 applied — interaction_notes.outcome: '
       || count(*) filter (where outcome is null)::text || ' note(s) not said, '
       || count(*) filter (where outcome is not null)::text || ' with an outcome' as summary
  from public.interaction_notes;
