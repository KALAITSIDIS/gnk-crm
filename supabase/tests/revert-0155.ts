import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0155 — its documented ROLLBACK, run as ONE transaction
 * (one execute_sql call, or a forward migration file), and only after the
 * application that sends p_outcome has been rolled back: the five-argument
 * log_conversation goes and 0094's four-argument one comes back with its
 * comment and grants, 0094's two trigger bodies come back (CREATE OR REPLACE
 * keeps the triggers and their revoked ACLs), and the CHECK and the column
 * go. The outcome of each note logged meanwhile stays in its
 * conversation_logged event — the chain is never rewritten; the column's copy
 * is dropped. Under 0155's own lock discipline: a bounded wait, the table
 * locked up front (inside a DO block — the CLI refuses a top-level LOCK).
 *
 * Used by interaction-note-outcome.test.ts to replay 0155 over the state
 * before it, to plant what its preflight must refuse, and to prove the
 * rollback — always inside a rolled-back transaction. Not a test file: it
 * registers no tests. Never pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

export const MIGRATION_0155 = "0155_interaction_note_outcome.sql";
export const readMigration0155 = () =>
  readFileSync(join(MIGRATIONS, MIGRATION_0155), "utf-8").replace(/\r\n/g, "\n");

/** md5(replace(prosrc, chr(13), '')) of each body, as 0155's preflight and postflight pin them. */
export const BODY_MD5_0155 = {
  trg_interaction_notes_before: {
    /** 0094's — hosted's equals it (read 2026-10-18) */
    before: "61b4ab8acfb61fa9540b63c5a1b2548a",
    after: "17cfe075677f0c15a905250b731bcd64",
  },
  trg_interaction_notes_after_insert: {
    before: "eab83d599ecd9523d928b7038bb488db",
    after: "c7d880a431bb622af9eed53c9adf3a32",
  },
  log_conversation: {
    /** 0094's (text, uuid, comm_channel, text) */
    before: "d1285100ee6c5aafc3710ee182645c52",
    /** 0155's (text, uuid, comm_channel, text, text) */
    after: "1f809ba10b05116ec81f9b129d02e26a",
  },
} as const;

export const LOG_CONVERSATION_0094 = "public.log_conversation(text, uuid, public.comm_channel, text)";
export const LOG_CONVERSATION_0155 = "public.log_conversation(text, uuid, public.comm_channel, text, text)";

export const REVERT_0155_SQL = `
set local lock_timeout = '5s';
do $$
begin
  lock table public.interaction_notes in access exclusive mode;
end $$;

drop function public.log_conversation(text, uuid, public.comm_channel, text, text);

create function public.log_conversation(
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

alter table public.interaction_notes drop constraint interaction_notes_outcome_check;
alter table public.interaction_notes drop column outcome;
`;
