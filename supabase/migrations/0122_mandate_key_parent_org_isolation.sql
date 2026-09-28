-- =============================================================================
-- 0122 — a mandate belongs to the organisation of the property it names and
--        of the mandate it renews, a property key to the organisation of its
--        property, and the mandate sweeps read only the mandate's own
--        property and keys
--
-- THE GAP (BACKLOG "A mandate's and a key's own parent links are
-- organisation-blind", found by T-task-mandate-org-isolation's scouting;
-- reproduced 2026-09-28 against 6f6c5f7 on the local stack at 0121, through
-- PostgREST with aal2 sessions of two throwaway organisations, and pinned
-- RED first by supabase/tests/mandate-key-parent-org-isolation.test.ts, 15 of
-- its 19 tests):
--
--   * mandates.property_id and property_keys.property_id (0001) reference
--     properties(id) ALONE, mandates.renewed_from_id (0036) mandates(id)
--     alone, and mandates_insert / mandates_update / property_keys_insert /
--     property_keys_update check only the CALLER's organisation (saveMandate
--     and registerKey copy the form's property id without re-reading it). So
--     an admin of organisation B who learned an organisation-A property id —
--     B cannot read the property — could:
--       - INSERT a B mandate naming it (201), PATCH or UPSERT one onto it; made
--         active, it held mandates_one_active_per_property (unique on
--         property_id alone), so A could NOT activate its own mandate
--         (23505) — a denial B could impose on any property it knew, and an
--         oracle on A's mandate state;
--       - have raise_key_recall_tasks / expire_mandates raise B a reminder
--         whose title carries A's property reference and held-key count,
--         whose property_id is A's property and whose assignee is A's agent
--         (the sweeps join properties and count keys by property_id alone);
--       - file a B key on A's property (201): counted as "held" for A's
--         ended mandate, it on its own raised a "Return keys" task in A and
--         kept A's from ever self-healing;
--       - name an A mandate as a B mandate's predecessor.
--     On every link a real id (accepted) and a missing one (23503) told B
--     whether the A row exists.
--
-- THE FIX — 0119–0121's two layers:
--
--   A. THE RELATIONSHIPS, each REPLACING its single-column key (one
--      relationship per table pair, so PostgREST embeds stay unambiguous —
--      the property list's `mandates_safe!inner(type, status)` included: the
--      view exposes both org_id and property_id):
--        mandates (org_id, property_id)     → properties (org_id, id)
--          mandates_org_property_fkey, ON DELETE CASCADE as before
--        property_keys (org_id, property_id) → properties (org_id, id)
--          property_keys_org_property_fkey, ON DELETE CASCADE as before
--        mandates (org_id, renewed_from_id) → mandates (org_id, id)
--          mandates_org_renewed_from_fkey, NO ACTION as before
--      on 0088's properties_org_id_id_key and 0121's mandates_org_id_id_key;
--      MATCH SIMPLE (renewed_from_id null = no predecessor, as before); all
--      org_id columns NOT NULL (asserted). A property's delete still takes
--      its mandates and keys with it. New, as 0119–0121 did for their
--      parents: the update rule now also pins properties.org_id under a
--      property's mandates and keys, and mandates.org_id under a mandate's
--      successors — no application path writes either. Each gets a
--      referencing index; 0001's / 0036's single-column indexes stay.
--      mandates_one_active_per_property stays unique on property_id: once a
--      property's mandates are all its own organisation's, that is right.
--
--   B. THE SWEEPS. raise_key_recall_tasks gains `and p.org_id = m.org_id` in
--      its candidates' property join and `and k.org_id = m.org_id` in both of
--      its held-key tests (the count and the self-heal's NOT EXISTS);
--      expire_mandates gains `and p.org_id = m.org_id` in step 2's property
--      join. Row by row, never current_org_id() (both serve every
--      organisation in one run). With A validated they cannot fail to hold;
--      they are defence in depth for a row A could not stop (kept past a NOT
--      VALID constraint, or loaded by a replica-mode restore). NOTHING ELSE
--      moves: each body is 0121's plus exactly these lines (asserted by md5
--      against 0121's bodies), ACLs restated (recall service_role only,
--      expire its owner only).
--
-- EXISTING DATA. The preflight below counts mismatches on all three links and
-- ABORTS THE WHOLE FILE before any DDL if there are any: nothing is deleted,
-- reassigned or repaired, and no key is added NOT VALID by this file. Hosted,
-- read-only, 2026-09-28 15:11Z: 1 organisation, 17 properties, 4 mandates
-- (none renewed), 2 keys, 0 mismatches on each link; this file validates
-- trivially there.
--
-- DEPLOY ORDER: ADDITIVE — hosted before the merge. Every legitimate writer
-- takes the parent from the caller's own organisation (the UI offers only
-- the caller's properties; renewMandate copies org and property from the
-- predecessor it read under RLS); a crafted foreign id, accepted until now,
-- is refused with 23503. The sweeps copy property_id and mandate_id from the
-- same mandate row, so no nightly insert can be refused by these keys. No
-- function signature, return shape or grant changes — no release-compat
-- entry. database.types.ts is regenerated: the Relationships entries
-- mandates_property_id_fkey, property_keys_property_id_fkey and
-- mandates_renewed_from_id_fkey (and their mandates_safe twins) become the
-- composite keys; no TypeScript names either.
--
-- ROLLBACK (DECISIONS T-mandate-key-parent-org-isolation): a FORWARD
-- migration that drops the three composite keys and their three indexes,
-- re-adds `mandates_property_id_fkey foreign key (property_id) references
-- properties(id) on delete cascade`, `property_keys_property_id_fkey` (the
-- same) and `mandates_renewed_from_id_fkey foreign key (renewed_from_id)
-- references mandates(id)`, re-creates both functions from 0121's text
-- (with 0121's comments — CREATE OR REPLACE keeps this file's otherwise);
-- regenerate the types, move the verify-restore migrations pin FORWARD,
-- remove its 0122 invariant rows, remove
-- supabase/tests/mandate-key-parent-org-isolation.test.ts (its RED-at-0121
-- tests fail on the rolled-back catalogue) and the docs. No data moves either
-- way: every row valid at 0122 is valid at 0121.
--
-- NOT CHANGED HERE (BACKLOG): the profile links — mandates.created_by,
-- properties.assigned_agent_id, property_keys.current_holder_profile_id, the
-- assignee fallback's first two arms — need a profiles (org_id, id) key and
-- touch every *_by / *agent_id column: decided separately. mandates.
-- owner_contact_id (contacts has no (org_id, id) key yet) and
-- signed_document_id stay single-column.
--
-- Pins that move with this file: the migrations count (121 -> 122) and 0122
-- invariant rows in scripts/backup/verify-restore.sql. NO EXPLICIT
-- begin/commit — the CLI wraps the file (HANDOFF §3), as does one execute_sql
-- call.
-- =============================================================================

-- DROP CONSTRAINT takes ACCESS EXCLUSIVE locks on mandates, property_keys
-- and properties (the foreign-key ADDs take SHARE ROW EXCLUSIVE), held to
-- commit (0113's lesson). Give up instead and apply again; hosted's tables
-- are tiny, so the scans are instant. First, so the preflight's reads are
-- bounded too. Apply outside 03:00–04:00 UTC (expire_mandates at 03:00) and
-- away from a :x0 minute (raise_lead_sla_tasks): a collision costs at most
-- 5 s and a clean 55P03 rollback — then apply again, and do NOT write the
-- ledger row. Run twice by mistake, the file aborts at the first DROP
-- CONSTRAINT (42704) and changes nothing.
set local lock_timeout = '5s';

-- The file must run as ONE transaction (the CLI's wrapper, or one
-- execute_sql call): otherwise SET LOCAL is a no-op and a failed assertion
-- below would not undo the DDL before it.
do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0122 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0. Preflight — abort, whole, over existing mismatches on any of the links
-- ---------------------------------------------------------------------------
do $$
declare n_mp int; n_kp int; n_mr int;
begin
  select count(*) into n_mp from public.mandates m join public.properties p on p.id = m.property_id where m.org_id <> p.org_id;
  select count(*) into n_kp from public.property_keys k join public.properties p on p.id = k.property_id where k.org_id <> p.org_id;
  select count(*) into n_mr from public.mandates m join public.mandates r on r.id = m.renewed_from_id where m.org_id <> r.org_id;
  if n_mp + n_kp + n_mr > 0 then
    raise exception '0122 aborted: % mandate(s) name a property of another organisation, % key(s) do, % mandate(s) renew a mandate of another organisation — nothing was changed. '
                    'List them with the three joins in this preflight (mandates/properties, property_keys/properties, mandates/mandates on renewed_from_id) and decide before constraining',
                    n_mp, n_kp, n_mr;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- A. The relationships
-- ---------------------------------------------------------------------------
alter table public.mandates
  drop constraint mandates_property_id_fkey;
alter table public.mandates
  add constraint mandates_org_property_fkey
    foreign key (org_id, property_id) references public.properties (org_id, id) on delete cascade;
comment on constraint mandates_org_property_fkey on public.mandates is
  '0122: a mandate belongs to the organisation of the property it names, by construction. '
  'Replaces the single-column FK on property_id (ON DELETE CASCADE, as that one was).';
create index if not exists mandates_org_property_idx
  on public.mandates (org_id, property_id);

alter table public.property_keys
  drop constraint property_keys_property_id_fkey;
alter table public.property_keys
  add constraint property_keys_org_property_fkey
    foreign key (org_id, property_id) references public.properties (org_id, id) on delete cascade;
comment on constraint property_keys_org_property_fkey on public.property_keys is
  '0122: a key belongs to the organisation of the property it opens, by construction. '
  'Replaces the single-column FK on property_id (ON DELETE CASCADE, as that one was).';
create index if not exists property_keys_org_property_idx
  on public.property_keys (org_id, property_id);

alter table public.mandates
  drop constraint mandates_renewed_from_id_fkey;
alter table public.mandates
  add constraint mandates_org_renewed_from_fkey
    foreign key (org_id, renewed_from_id) references public.mandates (org_id, id);
comment on constraint mandates_org_renewed_from_fkey on public.mandates is
  '0122: a renewal names a predecessor of its own organisation, by construction. '
  'Replaces the single-column FK on renewed_from_id (NO ACTION, as that one was); '
  'a mandate with no predecessor is not checked (MATCH SIMPLE).';
create index if not exists mandates_org_renewed_from_idx
  on public.mandates (org_id, renewed_from_id)
  where renewed_from_id is not null;

-- ---------------------------------------------------------------------------
-- B1. raise_key_recall_tasks: the mandate's OWN property and keys
-- ---------------------------------------------------------------------------
-- 0121's text with three predicates added: `and p.org_id = m.org_id` in the
-- candidates' property join, `and k.org_id = m.org_id` in the held count and
-- in the self-heal's held-key test.
create or replace function public.raise_key_recall_tasks(
  p_mandate uuid default null,
  p_actor   uuid default null
)
returns int
language sql security definer set search_path = public as $$
  with candidates as (
    select m.id as mandate_id, m.org_id, m.property_id, m.created_by, m.status,
           p.reference, p.assigned_agent_id,
           (select count(*) from property_keys k
             where k.property_id = m.property_id
               and k.org_id = m.org_id
               and k.status in ('in_office', 'checked_out')) as held
      from mandates m
      join properties p on p.id = m.property_id
       and p.org_id = m.org_id
     -- both terminal, and there is no transition back to active, which is why
     -- (mandate_id, kind) is a sufficient key
     where m.status in ('expired', 'terminated')
       and (p_mandate is null or m.id = p_mandate)
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, property_id, mandate_id, kind)
    select c.org_id,
           'Return keys: ' || c.reference || ' — ' || c.held
             || case when c.held = 1 then ' key' else ' keys' end
             || ' still held (mandate ' || c.status || ')',
           -- grace, not urgency theatre: see the header
           -- 0091: anchored on the CYPRUS day, not current_date
           ((((now() at time zone 'Asia/Nicosia')::date + 7)::timestamp
             + interval '23 hours 59 minutes')
             at time zone 'Asia/Nicosia'),
           -- three-arm fallback, per 0012/0020/0047/0051: a NULL assignee is
           -- invisible on every surface, because /tasks and the agent dashboard
           -- both filter on assignee_id = me.
           coalesce(
             (select pr.id from profiles pr
               where pr.id = c.assigned_agent_id and pr.is_active),
             (select pr.id from profiles pr
               where pr.id = c.created_by and pr.is_active),
             (select pr.id from profiles pr
               where pr.org_id = c.org_id and pr.role = 'admin' and pr.is_active
               order by pr.created_at limit 1)),
           c.property_id,
           c.mandate_id,
           'key_recall'
      from candidates c
     where c.held > 0
       and not exists (
         select 1 from tasks t
          where t.mandate_id = c.mandate_id
            and t.org_id = c.org_id
            and t.kind = 'key_recall')
    returning org_id, id, mandate_id, property_id, assignee_id
  ),
  logged as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select c.org_id, p_actor, 'mandate', c.mandate_id, 'key_recall_task_created',
           jsonb_build_object('task_id', c.id,
                              'assignee_id', c.assignee_id,
                              'property_id', c.property_id,
                              'keys', d.held)
      from created c join candidates d on d.mandate_id = c.mandate_id
    returning 1
  ),
  -- self-heal: once nothing is held any more the task is COMPLETED, never
  -- deleted, so history keeps its shape. Handing the last key to the owner is
  -- the ordinary way this closes; marking it lost also closes it, because there
  -- is then nothing left to recall — the loss is its own record.
  superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from mandates m
     where t.mandate_id = m.id
       and t.org_id = m.org_id
       and t.kind = 'key_recall'
       and not t.is_done
       and (p_mandate is null or m.id = p_mandate)
       and not exists (
         select 1 from property_keys k
          where k.property_id = m.property_id
            and k.org_id = m.org_id
            and k.status in ('in_office', 'checked_out'))
    returning t.org_id, t.id, t.mandate_id
  ),
  healed as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select org_id, p_actor, 'task', id, 'superseded',
           jsonb_build_object('kind', 'key_recall', 'mandate_id', mandate_id,
                              'reason', 'keys_returned')
      from superseded
    returning 1
  )
  select count(*)::int from created;
$$;

-- create or replace keeps the ACL (0053's T-C4 lockdown); restated so hosted
-- and local cannot differ
revoke execute on function public.raise_key_recall_tasks(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.raise_key_recall_tasks(uuid, uuid) to service_role;

comment on function public.raise_key_recall_tasks(uuid, uuid) is
  'Raises key_recall tasks for ended mandates whose keys are still held, and '
  'completes the task once nothing is held. Due date is seven CYPRUS days out '
  '(0091 — current_date is the UTC day, and this function is called '
  'synchronously from a user action, so the two can disagree). Since 0121 both '
  'the duplicate guard and the self-heal read only the MANDATE''s organisation''s '
  'tasks (t.org_id = the mandate''s org_id) — a row of another organisation can '
  'neither block a reminder nor be completed, and no event lands in another '
  'organisation''s chain. Since 0122 it reads only the mandate''s organisation''s '
  'property and keys (p.org_id / k.org_id = m.org_id).';

-- ---------------------------------------------------------------------------
-- B2. expire_mandates: step 2's property join, the same way
-- ---------------------------------------------------------------------------
-- 0121's text with one predicate added (`and p.org_id = m.org_id` in step 2's
-- property join). Steps 1, 3 and 4 are 0121's.
create or replace function public.expire_mandates()
returns void
language sql security definer set search_path = public as $$
  -- 1) expiry flip first (so freshly-expired mandates can't mint a reminder
  --    in the same run), each with its system event (actor null = system/cron)
  with flipped as (
    update mandates set status = 'expired'
    where status = 'active' and expiry_date is not null and expiry_date < current_date
    returning org_id, id, expiry_date
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'mandate', id, 'status_changed',
         jsonb_build_object('from', 'active', 'to', 'expired', 'expiry_date', expiry_date)
  from flipped;

  -- 2) renewal reminders: active mandates within expiry - renewal_reminder_days,
  --    one task per expiry cycle, due Cyprus end-of-day of the expiry date,
  --    assigned to the property's agent (fallbacks: mandate creator, then the
  --    org's oldest active admin — never NULL, and never a deactivated profile)
  with created as (
    insert into tasks (org_id, title, due_at, assignee_id, property_id, mandate_id, kind)
    select m.org_id,
           'Mandate renewal: ' || p.reference || ' expires ' || to_char(m.expiry_date, 'DD Mon YYYY'),
           (m.expiry_date::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia',
           coalesce(
             (select pr.id from profiles pr where pr.id = p.assigned_agent_id and pr.is_active),
             (select pr.id from profiles pr where pr.id = m.created_by and pr.is_active),
             (select pr.id from profiles pr
               where pr.org_id = m.org_id and pr.role = 'admin' and pr.is_active
               order by pr.created_at limit 1)),
           m.property_id,
           m.id,
           'mandate_renewal'
    from mandates m
    join properties p on p.id = m.property_id
     and p.org_id = m.org_id
    where m.status = 'active'
      and m.expiry_date is not null
      and current_date >= m.expiry_date - m.renewal_reminder_days
      and not exists (
        select 1 from tasks t
        where t.mandate_id = m.id
          and t.org_id = m.org_id
          -- 0053: `tasks.mandate_id` is no longer single-kind. Without this a
          -- key_recall task dated on the expiry day would block the renewal
          -- reminder for that cycle.
          and t.kind = 'mandate_renewal'
          and (t.due_at at time zone 'Asia/Nicosia')::date = m.expiry_date)
    returning org_id, mandate_id, assignee_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'mandate', mandate_id, 'renewal_task_created',
         jsonb_build_object('assignee_id', assignee_id)
  from created;

  -- 3) self-heal: complete open renewal tasks whose mandate is no longer
  --    active or whose expiry moved (saveMandate does this at edit time with
  --    actor attribution; this is the nightly safety net)
  with superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from mandates m
     where t.mandate_id = m.id
       and t.org_id = m.org_id
       -- 0053: THE BUG THIS MIGRATION EXISTS AROUND. Without this filter, every
       -- key_recall task is completed on the next run — they hang off mandates
       -- that are BY DEFINITION no longer active, so `m.status <> 'active'`
       -- matches every one of them.
       and t.kind = 'mandate_renewal'
       and not t.is_done
       and (m.status <> 'active'
            or m.expiry_date is null
            or (t.due_at at time zone 'Asia/Nicosia')::date <> m.expiry_date)
    returning t.org_id, t.id, t.mandate_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object('mandate_id', mandate_id, 'reason', 'mandate_renewed_or_inactive')
  from superseded;

  -- 4) 0053: chase keys on mandates that have ended. Runs LAST, after the flip
  --    in step 1, so a mandate that expired overnight is already `expired` and
  --    is picked up in the same pass rather than waiting a further night.
  select raise_key_recall_tasks();
$$;

-- create or replace keeps the ACL (0007 / 0022); restated so hosted and local
-- cannot differ — pg_cron runs it as postgres and needs no grant
revoke execute on function public.expire_mandates() from public, anon, authenticated, service_role;

comment on function public.expire_mandates() is
  'Nightly (pg_cron, 03:00 UTC, as postgres): expires overdue mandates, raises and '
  'self-heals mandate_renewal reminders, then raise_key_recall_tasks(). Every '
  'organisation in one run, system-attributed. Since 0121 the renewal guard and '
  'self-heal read only the MANDATE''s organisation''s tasks (t.org_id = m.org_id); '
  'since 0122 the renewal reminder reads only its own organisation''s property '
  '(p.org_id = m.org_id).';

-- ---------------------------------------------------------------------------
-- Apply-time assertions: the shapes, the two bodies, and each key exercised
-- ---------------------------------------------------------------------------
do $$
declare
  c      record;
  n      int;
  src    text;
  v_ok   boolean;
  v_con  text;
  v_step text;
  -- the lines this file adds, exactly (newline + indentation + predicate)
  k_join    constant text := E'\n       and p.org_id = m.org_id';
  k_held    constant text := E'\n               and k.org_id = m.org_id';
  k_heal    constant text := E'\n            and k.org_id = m.org_id';
  k_renew   constant text := E'\n     and p.org_id = m.org_id';
begin
  -- each link: exactly one foreign key for the pair, the composite one,
  -- validated, the stated delete rule, NO ACTION on update, MATCH SIMPLE
  for c in
    select * from (values
      ('public.mandates'::regclass,      'public.properties'::regclass, 'mandates_org_property_fkey',      array['org_id','property_id']::name[],     'c', 'mandates_property_id_fkey'),
      ('public.property_keys'::regclass, 'public.properties'::regclass, 'property_keys_org_property_fkey', array['org_id','property_id']::name[],     'c', 'property_keys_property_id_fkey'),
      ('public.mandates'::regclass,      'public.mandates'::regclass,   'mandates_org_renewed_from_fkey',  array['org_id','renewed_from_id']::name[], 'a', 'mandates_renewed_from_id_fkey')
    ) as t(rel, ref, name, cols, del, old)
  loop
    select count(*) into n from pg_constraint where conrelid = c.rel and confrelid = c.ref and contype = 'f';
    if n <> 1 then
      raise exception '0122 aborted: expected exactly one foreign key from % to %, found %', c.rel, c.ref, n;
    end if;
    if not exists (
      select 1 from pg_constraint k
       where k.conrelid = c.rel and k.confrelid = c.ref and k.contype = 'f'
         and k.conname = c.name and k.convalidated
         and k.confdeltype::text = c.del and k.confupdtype = 'a' and k.confmatchtype = 's'
         and (select array_agg(a.attname order by x.ord) from unnest(k.conkey) with ordinality x(attnum, ord)
                join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.attnum) = c.cols
         and (select array_agg(a.attname order by x.ord) from unnest(k.confkey) with ordinality x(attnum, ord)
                join pg_attribute a on a.attrelid = k.confrelid and a.attnum = x.attnum) = array['org_id','id']::name[]) then
      raise exception '0122 aborted: % is not % -> % (org_id, id), validated, delete rule %, NO ACTION on update, MATCH SIMPLE', c.name, c.cols, c.ref, c.del;
    end if;
    if exists (select 1 from pg_constraint where conrelid = c.rel and conname = c.old) then
      raise exception '0122 aborted: the single-column % is still there (two relationships would make PostgREST embeds ambiguous)', c.old;
    end if;
  end loop;

  if (select count(*) from pg_indexes where schemaname = 'public'
        and ((indexname = 'mandates_org_property_idx'      and indexdef ~ 'ON public\.mandates USING btree \(org_id, property_id\)$')
          or (indexname = 'property_keys_org_property_idx' and indexdef ~ 'ON public\.property_keys USING btree \(org_id, property_id\)$')
          or (indexname = 'mandates_org_renewed_from_idx'  and indexdef ~ '\(org_id, renewed_from_id\) WHERE \(renewed_from_id IS NOT NULL\)$'))) <> 3 then
    raise exception '0122 aborted: a referencing index is missing or has the wrong definition';
  end if;
  -- MATCH SIMPLE skips a row with any null key column: the boundary rests on
  -- every org_id involved being NOT NULL
  if exists (select 1 from pg_attribute
              where attname = 'org_id' and not attnotnull
                and attrelid in ('public.mandates'::regclass, 'public.property_keys'::regclass, 'public.properties'::regclass)) then
    raise exception '0122 aborted: an org_id column on mandates, property_keys or properties is nullable';
  end if;
  -- 0119–0121's keys, and the referenced unique keys, untouched
  select count(*) into n from pg_constraint
   where convalidated
     and ((conname = 'tasks_org_deal_fkey'     and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, deal_id) REFERENCES deals(org_id, id)')
       or (conname = 'tasks_org_viewing_fkey'  and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, viewing_id) REFERENCES viewings(org_id, id)')
       or (conname = 'tasks_org_mandate_fkey'  and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, mandate_id) REFERENCES mandates(org_id, id)')
       or (conname = 'mandates_org_id_id_key'  and pg_get_constraintdef(oid) = 'UNIQUE (org_id, id)')
       or (conname = 'properties_org_id_id_key' and pg_get_constraintdef(oid) = 'UNIQUE (org_id, id)'));
  if n <> 5 then
    raise exception '0122 aborted: an earlier tenant-bound key (0088 / 0119 / 0120 / 0121) is missing, not validated, or changed';
  end if;

  -- raise_key_recall_tasks: definer, search_path, one overload each,
  -- service-only; each predicate in its place (comments stripped); nothing
  -- else moved relative to 0121's body
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname in ('raise_key_recall_tasks', 'expire_mandates');
  if n <> 2 then
    raise exception '0122 aborted: expected one overload each of raise_key_recall_tasks and expire_mandates, found %', n;
  end if;
  select p.prosrc into src
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'raise_key_recall_tasks'
     and p.prosecdef and 'search_path=public' = any (p.proconfig);
  if src is null then
    raise exception '0122 aborted: raise_key_recall_tasks lost SECURITY DEFINER or its search_path';
  end if;
  src := replace(src, E'\r', '');
  if regexp_replace(src, '--[^\n]*', '', 'g') !~ 'join properties p on p\.id = m\.property_id\s+and p\.org_id = m\.org_id'
     or regexp_replace(src, '--[^\n]*', '', 'g') !~ 'where k\.property_id = m\.property_id\s+and k\.org_id = m\.org_id\s+and k\.status in \(''in_office'', ''checked_out''\)\) as held'
     or regexp_replace(src, '--[^\n]*', '', 'g') !~ 'select 1 from property_keys k\s+where k\.property_id = m\.property_id\s+and k\.org_id = m\.org_id\s+and k\.status in' then
    raise exception '0122 aborted: raise_key_recall_tasks does not scope its property join and both held-key tests to the mandate''s organisation';
  end if;
  if (length(src) - length(replace(src, k_join, ''))) / length(k_join) <> 1
     or (length(src) - length(replace(src, k_held, ''))) / length(k_held) <> 1
     or (length(src) - length(replace(src, k_heal, ''))) / length(k_heal) <> 1
     or md5(replace(replace(replace(src, k_join, ''), k_held, ''), k_heal, '')) <> '00c9a0efb76421bd1b40aa8217149709' then
    raise exception '0122 aborted: raise_key_recall_tasks is not 0121''s body plus exactly the three organisation predicates';
  end if;
  if has_function_privilege('anon', 'public.raise_key_recall_tasks(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.raise_key_recall_tasks(uuid, uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.raise_key_recall_tasks(uuid, uuid)', 'execute') then
    raise exception '0122 aborted: raise_key_recall_tasks must be executable by service_role only (T-C4)';
  end if;

  -- expire_mandates: the same checks
  select p.prosrc into src
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'expire_mandates'
     and p.prosecdef and 'search_path=public' = any (p.proconfig);
  if src is null then
    raise exception '0122 aborted: expire_mandates lost SECURITY DEFINER or its search_path';
  end if;
  src := replace(src, E'\r', '');
  if regexp_replace(src, '--[^\n]*', '', 'g') !~ 'join properties p on p\.id = m\.property_id\s+and p\.org_id = m\.org_id\s+where m\.status = ''active''' then
    raise exception '0122 aborted: expire_mandates does not scope step 2''s property join to the mandate''s organisation';
  end if;
  if (length(src) - length(replace(src, k_renew, ''))) / length(k_renew) <> 1
     or md5(replace(src, k_renew, '')) <> '5615951b977927c4798645a826382211' then
    raise exception '0122 aborted: expire_mandates is not 0121''s body plus exactly the one organisation predicate';
  end if;
  if has_function_privilege('anon', 'public.expire_mandates()', 'execute')
     or has_function_privilege('authenticated', 'public.expire_mandates()', 'execute')
     or has_function_privilege('service_role', 'public.expire_mandates()', 'execute') then
    raise exception '0122 aborted: expire_mandates must be callable by its owner only (0022; pg_cron runs it as postgres)';
  end if;

  -- the keys, exercised: two organisations; A's property, mandate and key
  -- (accepted), then three cross-organisation rows, each in its own
  -- sub-block and each refused by ITS key at ITS step (0121's probe shape).
  -- Needs no profile, so it runs on an empty database too.
  declare
    v_org_a uuid; v_org_b uuid; v_prop_a uuid; v_prop_b uuid; v_mandate_a uuid;
    v_verdicts text[] := '{}';
  begin
    for c in
      select * from (values
        ('mandate', 'mandates_org_property_fkey'),
        ('key',     'property_keys_org_property_fkey'),
        ('renewal', 'mandates_org_renewed_from_fkey')
      ) as t(kind, expect)
    loop
      v_ok := null; v_con := null; v_step := 'setup';
      begin
        insert into organizations (name, slug)
          values ('0122 probe A (rolled back)', '0122-probe-a-' || replace(gen_random_uuid()::text, '-', ''))
          returning id into v_org_a;
        insert into organizations (name, slug)
          values ('0122 probe B (rolled back)', '0122-probe-b-' || replace(gen_random_uuid()::text, '-', ''))
          returning id into v_org_b;
        insert into properties (org_id, reference, property_type) values (v_org_a, 'ZZZ0122-probe-a', 'apartment')
          returning id into v_prop_a;
        insert into properties (org_id, reference, property_type) values (v_org_b, 'ZZZ0122-probe-b', 'apartment')
          returning id into v_prop_b;
        -- the same-organisation links: all accepted
        v_step := 'own';
        insert into mandates (org_id, property_id, type) values (v_org_a, v_prop_a, 'open') returning id into v_mandate_a;
        insert into mandates (org_id, property_id, type, renewed_from_id) values (v_org_a, v_prop_a, 'open', v_mandate_a);
        insert into property_keys (org_id, property_id, key_code) values (v_org_a, v_prop_a, 'ZZZ0122-K');
        -- organisation B's row naming organisation A's parent: the
        -- single-column keys accepted each of these
        v_step := 'cross';
        if c.kind = 'mandate' then
          insert into mandates (org_id, property_id, type) values (v_org_b, v_prop_a, 'open');
        elsif c.kind = 'key' then
          insert into property_keys (org_id, property_id, key_code) values (v_org_b, v_prop_a, 'ZZZ0122-KB');
        else
          insert into mandates (org_id, property_id, type, renewed_from_id) values (v_org_b, v_prop_b, 'open', v_mandate_a);
        end if;
        raise exception using errcode = 'P0122', message = '0122 probe: a cross-organisation row was ACCEPTED';
      exception
        when foreign_key_violation then
          get stacked diagnostics v_con = constraint_name;
          v_ok := (v_con = c.expect and v_step = 'cross');
        when sqlstate 'P0122' then
          v_ok := false;
      end;
      if v_ok is distinct from true then
        raise exception '0122 aborted: the % probe was not refused by % at the cross-organisation step (met % at the % step)',
          c.kind, c.expect, coalesce(v_con, 'no foreign-key violation'), v_step;
      end if;
      v_verdicts := v_verdicts || c.kind;
    end loop;
    raise notice '0122: probes refused by their keys: %', v_verdicts;
  end;

  raise notice '0122: mandates (org_id, property_id / renewed_from_id) and property_keys (org_id, property_id) tenant-bound; the sweeps read only the mandate''s own property and keys';
end $$;
