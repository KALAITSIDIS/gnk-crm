import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0149 — its documented ROLLBACK, run as ONE transaction
 * (one execute_sql call, or a forward migration file): note_share_link_miss
 * and note_public_listing_hit get 0023's / 0066's bodies back (CREATE OR
 * REPLACE keeps their grants and comments), and the three key-shape CHECKs
 * and the three window_start indexes go. No row moves: every row valid at
 * 0149 is valid before it. Under 0149's own lock discipline: a bounded wait,
 * the three tables locked up front in one statement (inside a DO block — the
 * CLI refuses a top-level LOCK).
 *
 * Used by anon-counter-key-shape.test.ts to replay 0149 over the state before
 * it, to plant what its preflight must clear or refuse, and to prove the
 * rollback — always inside a rolled-back transaction. Not a test file: it
 * registers no tests. Never pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

export const MIGRATION_0149 = "0149_anon_counter_key_shape.sql";
export const readMigration0149 = () =>
  readFileSync(join(MIGRATIONS, MIGRATION_0149), "utf-8").replace(/\r\n/g, "\n");

export const COUNTER_TABLES_0149 = ["share_link_attempts", "public_listing_attempts", "public_enquiry_attempts"] as const;

/** md5(replace(prosrc, chr(13), '')) of each body, as 0149's preflight and postflight pin them. */
export const BODY_MD5_0149 = {
  note_share_link_miss: {
    /** 0023's file, as a database built from the migrations holds it */
    before: "607eeadee42bd274b3d6d1723a9493be",
    /** hosted's: 0023's statements without the file's one comment line (read 2026-10-17) */
    beforeHosted: "b6364a709b93d4aa3ed331cc4725ba21",
    after: "f64695308c34f5de8a78989858a25b87",
  },
  note_public_listing_hit: {
    before: "ec4f1019ea58c9ded3b40b36c6ac5992",
    after: "0668fb401dd5522e9593a22226433340",
  },
} as const;

/** Hosted's pre-0149 note_share_link_miss body: 0023's code without its comment line. */
export const HOSTED_SHARE_LINK_MISS_0023 = `
create or replace function public.note_share_link_miss(p_ip_hash text, p_limit int default 20)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v_window timestamptz := date_trunc('hour', now())
                        + (floor(extract(minute from now()) / 15) * interval '15 minutes');
  v_attempts int;
begin
  insert into share_link_attempts (ip_hash, window_start, attempts)
  values (p_ip_hash, v_window, 1)
  on conflict (ip_hash, window_start)
  do update set attempts = share_link_attempts.attempts + 1
  returning attempts into v_attempts;

  delete from share_link_attempts where window_start < now() - interval '2 hours';

  return v_attempts > p_limit;
end $fn$;
`;

export const REVERT_0149_SQL = `
set local lock_timeout = '5s';
do $$
begin
  lock table public.share_link_attempts, public.public_listing_attempts, public.public_enquiry_attempts
    in access exclusive mode;
end $$;

create or replace function note_share_link_miss(p_ip_hash text, p_limit int default 20)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v_window timestamptz := date_trunc('hour', now())
                        + (floor(extract(minute from now()) / 15) * interval '15 minutes');
  v_attempts int;
begin
  insert into share_link_attempts (ip_hash, window_start, attempts)
  values (p_ip_hash, v_window, 1)
  on conflict (ip_hash, window_start)
  do update set attempts = share_link_attempts.attempts + 1
  returning attempts into v_attempts;

  -- opportunistic prune so the table cannot grow forever
  delete from share_link_attempts where window_start < now() - interval '2 hours';

  return v_attempts > p_limit;
end $fn$;

create or replace function public.note_public_listing_hit(p_ip_hash text, p_limit int default 120)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v_window timestamptz := date_trunc('hour', now())
                        + (floor(extract(minute from now()) / 15) * interval '15 minutes');
  v_attempts int;
begin
  insert into public_listing_attempts (ip_hash, window_start, attempts)
  values (p_ip_hash, v_window, 1)
  on conflict (ip_hash, window_start)
  do update set attempts = public_listing_attempts.attempts + 1
  returning attempts into v_attempts;

  -- opportunistic prune so the table cannot grow forever (0023)
  delete from public_listing_attempts where window_start < now() - interval '2 hours';

  return v_attempts > p_limit;
end $fn$;

alter table public.share_link_attempts     drop constraint share_link_attempts_ip_hash_shape;
alter table public.public_listing_attempts drop constraint public_listing_attempts_ip_hash_shape;
alter table public.public_enquiry_attempts drop constraint public_enquiry_attempts_ip_hash_shape;

drop index public.share_link_attempts_window_start_idx;
drop index public.public_listing_attempts_window_start_idx;
drop index public.public_enquiry_attempts_window_start_idx;
`;
