-- =============================================================================
-- 0139 — every link onto a contact belongs to the contact's organisation:
--        the ten single-column keys onto contacts become (org_id, <col>)
--
-- THE GAP (BACKLOG "Ten links onto `contacts` are still single-column";
-- re-measured 2026-10-03 on the local stack at 0138 and read-only on hosted,
-- pinned RED first by supabase/tests/contact-links-org-isolation.test.ts —
-- DECISIONS T-contact-links-org-isolation has the count):
--
--   * leads.contact_id, deals.buyer_contact_id / seller_contact_id,
--     offers.contact_id, share_links.contact_id, buyer_requirements.contact_id,
--     mandates.owner_contact_id, properties.owner_contact_id /
--     developer_contact_id and contacts.merged_into_id (0001's keys;
--     share_links' from 0023, buyer_requirements' from 0043) referenced
--     contacts by id ALONE, and every insert / update policy checks only the
--     CALLER's organisation. A member of organisation B who learned an
--     organisation-A contact id — B can read none of A's contacts, but an id
--     travels in links, screenshots and logs — could hang B's lead, deal,
--     offer, share link, requirement, mandate or listing on A's contact (B's
--     admin's POST /leads naming A's contact was accepted — measured by
--     T-contact-merge-org-isolation), and a real id (accepted) against a
--     missing one (23503) told B whether the A contact exists. viewings,
--     reservations and tasks are bound since 0123 / 0126; these ten were not.
--
-- THE FIX — 0123 / 0126's layer A; no function writes any of the ten columns
-- (every writer is an application action, a script or a test — measured from
-- pg_proc), so there is no layer B. Each single-column key is REPLACED, in the
-- same statement, by a composite key UNDER THE SAME NAME:
--     leads              (org_id, contact_id)           leads_contact_id_fkey                NO ACTION
--     deals              (org_id, buyer_contact_id)     deals_buyer_contact_id_fkey          NO ACTION
--     deals              (org_id, seller_contact_id)    deals_seller_contact_id_fkey         NO ACTION
--     offers             (org_id, contact_id)           offers_contact_id_fkey               NO ACTION
--     share_links        (org_id, contact_id)           share_links_contact_id_fkey          NO ACTION
--     buyer_requirements (org_id, contact_id)           buyer_requirements_contact_id_fkey   ON DELETE CASCADE
--     mandates           (org_id, owner_contact_id)     mandates_owner_contact_id_fkey       NO ACTION
--     properties         (org_id, owner_contact_id)     properties_owner_contact_id_fkey     NO ACTION
--     properties         (org_id, developer_contact_id) properties_developer_contact_id_fkey NO ACTION
--     contacts           (org_id, merged_into_id)       contacts_merged_into_id_fkey         NO ACTION
--   → contacts (org_id, id), on contacts_org_id_id_key (0123).
--     - WHY THE NAMES ARE KEPT (unlike 0123 / 0126's `<t>_org_<x>_fkey`):
--       PostgREST resolves an embed hint by column OR by constraint name, and
--       a COLUMN hint stops resolving once its key is composite (PGRST200 —
--       measured). The deals and properties CSV exports hint their parties
--       because each table has two keys onto contacts; release 1 of this work
--       (merged and deployed BEFORE this file) moved those hints to the
--       constraint NAMES, and lib/queries/enquiry-contact-suggestions.ts already
--       hinted `leads!leads_contact_id_fkey`. With the names kept every hint
--       resolves on both sides of this file — rehearsed on the local stack:
--       the old column hints answered 400 PGRST200 and the name hints 200.
--       Renamed keys would have broken them the moment this file committed.
--     - each keeps its predecessor's delete rule: NO ACTION for nine,
--       CASCADE for buyer_requirements (a plain CASCADE on a composite key
--       deletes the same rows — every child of a valid contact carries its
--       organisation). None was SET NULL, so no `SET NULL (col)` is needed.
--       contacts.merged_into_id stays NO ACTION: SET NULL would clear the
--       pointer unarchiveContact's MERGED_STAYS_ARCHIVED guard reads, CASCADE
--       would delete the merged duplicates.
--     - ON UPDATE NO ACTION as before, and it now covers contacts.org_id too
--       (no application path writes any org_id; 0132 already refuses a
--       session's primary-key change).
--     - MATCH SIMPLE, and every org_id involved is NOT NULL (asserted below),
--       so a row with no contact is exactly as before and nothing else escapes
--       the check.
--   Each referencing side gets an (org_id, <col>) index — partial where the
--   column is nullable, plain on buyer_requirements (NOT NULL); share_links
--   and mandates had no index on their contact column at all. The
--   single-column indexes stay (lookups by contact id alone).
--   A cross-organisation id and a missing id now read the same 23503 — no
--   existence oracle through THESE TEN columns. The keys bind EVERY writer,
--   the service role and definer bodies included.
--
-- NOT CHANGED HERE (BACKLOG): the profile links (created_by, agent_id,
-- assigned_agent_id, …), offers.property_id and deals.property_id, the
-- client-chosen primary-key oracle. No policy, function, grant or row changes.
--
-- EXISTING DATA. The preflight counts, for each of the ten links, the rows
-- whose organisation differs from their contact's, and ABORTS THE WHOLE FILE
-- before any DDL if there are any: nothing is deleted, reassigned or repaired
-- here, and no key is added NOT VALID. Hosted held 0 on every link on
-- 2026-10-03 (read-only). It also refuses if a key it replaces is not exactly
-- its original (0001's; 0023's for share_links, 0043's for
-- buyer_requirements — their rules are what it preserves), if any table has a second key
-- onto contacts on the same column, if a unique index covers a link column (a
-- unique index answers 23505 before a key answers 23503 — 0122's lesson), or
-- if an index name it creates is taken.
--
-- LOCKS. Every lock the DDL needs is taken at its strongest, in ONE
-- statement, BEFORE the counts: contacts — the parent — then properties,
-- deals, mandates, offers, leads, share_links, buyer_requirements. Dropping a
-- key takes ACCESS EXCLUSIVE on BOTH tables (measured), so NOT VALID +
-- VALIDATE would buy nothing inside one transaction. What can still collide
-- is a statement that holds a child and then reaches contacts — an insert's
-- key check at the end of its statement — which ends in a clean 40P01 with one
-- side rolled back whole: a page load, or this file. lock_timeout bounds EACH
-- table's wait: the LOCK can wait up to 5 s on each of its eight tables while
-- holding the ones before it — up to about 40 s during which EVERY table
-- locked so far, and the one it waits on (new readers queue behind the
-- request), is unavailable: by the end all eight, so the CRM pages, the
-- public proposal pages (resolve_share_link updates share_links) and the
-- enquiry door (it writes leads; gnk-web gives up after 8 s). Apply outside 02:55–04:05 UTC and
-- away from 06:00, at the middle of an odd minute that is not a multiple of
-- five, when the site is quiet. A collision costs that wait and a clean 55P03
-- or 40P01 rollback — apply again, and do NOT write the ledger row. Run twice
-- by mistake, the file aborts in its preflight (the keys are no longer the
-- originals) and changes nothing.
--
-- DEPLOY ORDER — APPLICATION FIRST (release 1 of this work):
--   1. the release-1 application (constraint-name embed hints; contact
--      re-reads in createLead, updateDealSection, saveOffer, createShareLink,
--      createAvailabilityLink, saveMandate, createProperty and
--      updatePropertySection) merged AND confirmed deployed on Vercel
--      production;
--   2. this file's CI green on a head containing release 1;
--   3. then hosted 0139, then merge.
--   An application from BEFORE release 1 against a database at 0139 answers
--   500 on the deals and properties CSV exports (their column hints answer
--   PGRST200). ROLLBACK FLOOR: with hosted at or past 0139, never roll the
--   application back past the release-1 merge commit. No function signature,
--   return shape or grant changes — no release-compat contract entry.
--   database.types.ts is regenerated: eleven Relationships entries (the ten
--   keys, and mandates_safe's view of the mandate owner's) keep their
--   foreignKeyName and gain org_id in `columns` / `referencedColumns`.
--
-- ROLLBACK (DECISIONS T-contact-links-org-isolation): a FORWARD migration
-- that drops the ten keys and their ten (org_id, <col>) indexes and re-adds
-- each key under the same name as it was before this file — `FOREIGN KEY
-- (<col>) REFERENCES contacts(id)`, buyer_requirements' with ON DELETE
-- CASCADE — in ONE transaction and under THIS file's lock discipline: SET
-- LOCAL lock_timeout = '5s', the one-transaction guard, and one LOCK on the
-- eight tables, contacts first, BEFORE the ALTERs (the statement in
-- supabase/tests/revert-0139.ts has neither, for the tests' rolled-back use:
-- unbounded, its first ALTER would hold contacts and leads while waiting on
-- the next table). It must come off before 0123's revert, the only one that
-- drops contacts_org_id_id_key, which its keys depend on (0126's revert is
-- independent of it). Then regenerate the types, move the verify-restore
-- migrations pin FORWARD (one more ledger row), remove its three 0139 rows
-- and the new test file, restore the BACKLOG entry and the contact-merge
-- test's B-side plants. Keep the application (release 1 holds at 0138 too).
-- No data moves either way: every row valid at 0139 is valid at 0138.
--
-- Pins that move with this file: the migrations count (138 -> 139) and three
-- 0139 rows in scripts/backup/verify-restore.sql (INTEGRITY: the ten mismatch
-- counts; INTEGRITY: dangling ids; SECURITY: no single-column key onto
-- contacts); lib/supabase/database.types.ts (eleven entries); docs/04's
-- contacts, properties, mandates, leads, deals, offers and share_links rows.
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3), as does
-- one execute_sql call. The file's LAST result is a read-only summary.
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
    raise exception '0139 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0. Preflight — abort, whole, over existing mismatches or a changed key
-- ---------------------------------------------------------------------------
do $$
declare
  n_l int; n_db int; n_ds int; n_o int; n_s int; n_r int; n_m int; n_po int; n_pd int; n_c int;
  k record;
begin
  -- every lock the DDL below needs, at its strongest, BEFORE the counts;
  -- the parent first (see LOCKS in the header)
  lock table public.contacts, public.properties, public.deals, public.mandates, public.offers,
             public.leads, public.share_links, public.buyer_requirements in access exclusive mode;

  select count(*) into n_l  from public.leads x              join public.contacts c on c.id = x.contact_id           where x.org_id <> c.org_id;
  select count(*) into n_db from public.deals x              join public.contacts c on c.id = x.buyer_contact_id     where x.org_id <> c.org_id;
  select count(*) into n_ds from public.deals x              join public.contacts c on c.id = x.seller_contact_id    where x.org_id <> c.org_id;
  select count(*) into n_o  from public.offers x             join public.contacts c on c.id = x.contact_id           where x.org_id <> c.org_id;
  select count(*) into n_s  from public.share_links x        join public.contacts c on c.id = x.contact_id           where x.org_id <> c.org_id;
  select count(*) into n_r  from public.buyer_requirements x join public.contacts c on c.id = x.contact_id           where x.org_id <> c.org_id;
  select count(*) into n_m  from public.mandates x           join public.contacts c on c.id = x.owner_contact_id     where x.org_id <> c.org_id;
  select count(*) into n_po from public.properties x         join public.contacts c on c.id = x.owner_contact_id     where x.org_id <> c.org_id;
  select count(*) into n_pd from public.properties x         join public.contacts c on c.id = x.developer_contact_id where x.org_id <> c.org_id;
  select count(*) into n_c  from public.contacts x           join public.contacts c on c.id = x.merged_into_id       where x.org_id <> c.org_id;
  if n_l + n_db + n_ds + n_o + n_s + n_r + n_m + n_po + n_pd + n_c > 0 then
    raise exception '0139 aborted: rows name a contact of another organisation — % lead(s), % deal buyer(s), % deal seller(s), % offer(s), % share link(s), % requirement(s), % mandate owner(s), % property owner(s), % property developer(s), % merge pointer(s) — nothing was changed. '
                    'List them with the ten joins in this preflight and decide before constraining',
                    n_l, n_db, n_ds, n_o, n_s, n_r, n_m, n_po, n_pd, n_c;
  end if;

  -- the referenced key (0123)
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.contacts'::regclass and contype = 'u' and convalidated
                    and conname = 'contacts_org_id_id_key' and pg_get_constraintdef(oid) = 'UNIQUE (org_id, id)') then
    raise exception '0139 aborted: contacts_org_id_id_key UNIQUE (org_id, id) (0123) is missing or changed — nothing was changed';
  end if;

  -- the keys this file replaces must be exactly their originals (0001's;
  -- 0023's and 0043's for share_links and buyer_requirements) — their rules
  -- are what it preserves, and their names are what it keeps — and each the
  -- only key from its table onto contacts on that column
  for k in
    select * from (values
      ('public.leads'::regclass,              'contact_id'::name,           'leads_contact_id_fkey',                'FOREIGN KEY (contact_id) REFERENCES contacts(id)', '0001'),
      ('public.deals'::regclass,              'buyer_contact_id'::name,     'deals_buyer_contact_id_fkey',          'FOREIGN KEY (buyer_contact_id) REFERENCES contacts(id)', '0001'),
      ('public.deals'::regclass,              'seller_contact_id'::name,    'deals_seller_contact_id_fkey',         'FOREIGN KEY (seller_contact_id) REFERENCES contacts(id)', '0001'),
      ('public.offers'::regclass,             'contact_id'::name,           'offers_contact_id_fkey',               'FOREIGN KEY (contact_id) REFERENCES contacts(id)', '0001'),
      ('public.share_links'::regclass,        'contact_id'::name,           'share_links_contact_id_fkey',          'FOREIGN KEY (contact_id) REFERENCES contacts(id)', '0023'),
      ('public.buyer_requirements'::regclass, 'contact_id'::name,           'buyer_requirements_contact_id_fkey',   'FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE', '0043'),
      ('public.mandates'::regclass,           'owner_contact_id'::name,     'mandates_owner_contact_id_fkey',       'FOREIGN KEY (owner_contact_id) REFERENCES contacts(id)', '0001'),
      ('public.properties'::regclass,         'owner_contact_id'::name,     'properties_owner_contact_id_fkey',     'FOREIGN KEY (owner_contact_id) REFERENCES contacts(id)', '0001'),
      ('public.properties'::regclass,         'developer_contact_id'::name, 'properties_developer_contact_id_fkey', 'FOREIGN KEY (developer_contact_id) REFERENCES contacts(id)', '0001'),
      ('public.contacts'::regclass,           'merged_into_id'::name,       'contacts_merged_into_id_fkey',         'FOREIGN KEY (merged_into_id) REFERENCES contacts(id)', '0001')
    ) as t(rel, col, name, def, src)
  loop
    if (select count(*) from pg_constraint f
         where f.conrelid = k.rel and f.confrelid = 'public.contacts'::regclass and f.contype = 'f'
           and (select attnum from pg_attribute where attrelid = k.rel and attname = k.col) = any (f.conkey)) <> 1
       or not exists (select 1 from pg_constraint
                       where conrelid = k.rel and confrelid = 'public.contacts'::regclass and contype = 'f' and conname = k.name
                         and convalidated and not condeferrable and pg_get_constraintdef(oid) = k.def) then
      raise exception '0139 aborted: the foreign key from %.% onto contacts is not %''s % (%, validated, not deferrable, the only one on that column) — nothing was changed. '
                      'This file replaces it under the same name and keeps its rules; compare it with % and decide before applying',
                      k.rel, k.col, k.src, k.name, k.def, k.src;
    end if;
    -- a unique index on the link column would answer 23505 before the key's
    -- 23503 — an oracle the key would not close (0122)
    if exists (select 1 from pg_index i
                where i.indrelid = k.rel and i.indisunique
                  and (select attnum from pg_attribute where attrelid = k.rel and attname = k.col) = any (i.indkey::int2[])) then
      raise exception '0139 aborted: a unique index on %.% would answer before the key — nothing was changed', k.rel, k.col;
    end if;
  end loop;
  -- deals and properties each have exactly two keys onto contacts, every
  -- other table one: nothing beside the ten
  if (select count(*) from pg_constraint where contype = 'f' and confrelid = 'public.contacts'::regclass
        and conrelid in ('public.leads'::regclass, 'public.deals'::regclass, 'public.offers'::regclass, 'public.share_links'::regclass,
                         'public.buyer_requirements'::regclass, 'public.mandates'::regclass, 'public.properties'::regclass,
                         'public.contacts'::regclass)) <> 10 then
    raise exception '0139 aborted: the eight tables do not carry exactly the ten keys onto contacts this file replaces — nothing was changed';
  end if;

  if exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and relname in (
               'leads_org_contact_idx', 'deals_org_buyer_contact_idx', 'deals_org_seller_contact_idx', 'offers_org_contact_idx',
               'share_links_org_contact_idx', 'buyer_requirements_org_contact_idx', 'mandates_org_owner_contact_idx',
               'properties_org_owner_contact_idx', 'properties_org_developer_contact_idx', 'contacts_org_merged_into_idx')) then
    raise exception '0139 aborted: an index name this file creates is taken — nothing was changed';
  end if;
  raise notice '0139: preflight passed — no row names a contact of another organisation; the ten keys are the originals';
end $$;

-- ---------------------------------------------------------------------------
-- A. The ten keys — each replaced in ONE statement, under the same name, so
--    PostgREST never sees two relationships for one column (an unhinted embed
--    would answer PGRST201) and every name hint keeps resolving
-- ---------------------------------------------------------------------------
alter table public.leads
  drop constraint leads_contact_id_fkey,
  add constraint leads_contact_id_fkey
    foreign key (org_id, contact_id) references public.contacts (org_id, id);
comment on constraint leads_contact_id_fkey on public.leads is
  '0139: a lead names only a contact of its own organisation, by construction. '
  'Was 0001''s single-column key on contact_id (NO ACTION, as it still is); the name is kept — embeds hint it. '
  'A lead with no contact is not checked (MATCH SIMPLE).';
create index if not exists leads_org_contact_idx
  on public.leads (org_id, contact_id)
  where contact_id is not null;

alter table public.deals
  drop constraint deals_buyer_contact_id_fkey,
  add constraint deals_buyer_contact_id_fkey
    foreign key (org_id, buyer_contact_id) references public.contacts (org_id, id);
comment on constraint deals_buyer_contact_id_fkey on public.deals is
  '0139: a deal''s buyer is a contact of the deal''s organisation, by construction. '
  'Was 0001''s single-column key on buyer_contact_id (NO ACTION, as it still is); the name is kept — the deals export hints it.';
create index if not exists deals_org_buyer_contact_idx
  on public.deals (org_id, buyer_contact_id)
  where buyer_contact_id is not null;

alter table public.deals
  drop constraint deals_seller_contact_id_fkey,
  add constraint deals_seller_contact_id_fkey
    foreign key (org_id, seller_contact_id) references public.contacts (org_id, id);
comment on constraint deals_seller_contact_id_fkey on public.deals is
  '0139: a deal''s seller is a contact of the deal''s organisation, by construction. '
  'Was 0001''s single-column key on seller_contact_id (NO ACTION, as it still is); the name is kept — the deals export hints it.';
create index if not exists deals_org_seller_contact_idx
  on public.deals (org_id, seller_contact_id)
  where seller_contact_id is not null;

alter table public.offers
  drop constraint offers_contact_id_fkey,
  add constraint offers_contact_id_fkey
    foreign key (org_id, contact_id) references public.contacts (org_id, id);
comment on constraint offers_contact_id_fkey on public.offers is
  '0139: an offer names only a contact of its own organisation, by construction. '
  'Was 0001''s single-column key on contact_id (NO ACTION, as it still is); the name is kept.';
create index if not exists offers_org_contact_idx
  on public.offers (org_id, contact_id)
  where contact_id is not null;

alter table public.share_links
  drop constraint share_links_contact_id_fkey,
  add constraint share_links_contact_id_fkey
    foreign key (org_id, contact_id) references public.contacts (org_id, id);
comment on constraint share_links_contact_id_fkey on public.share_links is
  '0139: a share link''s recipient is a contact of the link''s organisation, by construction. '
  'Was the single-column key on contact_id (NO ACTION, as it still is); the name is kept.';
create index if not exists share_links_org_contact_idx
  on public.share_links (org_id, contact_id)
  where contact_id is not null;

alter table public.buyer_requirements
  drop constraint buyer_requirements_contact_id_fkey,
  add constraint buyer_requirements_contact_id_fkey
    foreign key (org_id, contact_id) references public.contacts (org_id, id) on delete cascade;
comment on constraint buyer_requirements_contact_id_fkey on public.buyer_requirements is
  '0139: a requirement belongs to a contact of its own organisation, by construction. '
  'Was the single-column key on contact_id; ON DELETE CASCADE, as it was; the name is kept.';
create index if not exists buyer_requirements_org_contact_idx
  on public.buyer_requirements (org_id, contact_id);

alter table public.mandates
  drop constraint mandates_owner_contact_id_fkey,
  add constraint mandates_owner_contact_id_fkey
    foreign key (org_id, owner_contact_id) references public.contacts (org_id, id);
comment on constraint mandates_owner_contact_id_fkey on public.mandates is
  '0139: a mandate''s owner is a contact of the mandate''s organisation, by construction. '
  'Was 0001''s single-column key on owner_contact_id (NO ACTION, as it still is); the name is kept.';
create index if not exists mandates_org_owner_contact_idx
  on public.mandates (org_id, owner_contact_id)
  where owner_contact_id is not null;

alter table public.properties
  drop constraint properties_owner_contact_id_fkey,
  add constraint properties_owner_contact_id_fkey
    foreign key (org_id, owner_contact_id) references public.contacts (org_id, id);
comment on constraint properties_owner_contact_id_fkey on public.properties is
  '0139: a listing''s owner is a contact of the listing''s organisation, by construction. '
  'Was 0001''s single-column key on owner_contact_id (NO ACTION, as it still is); the name is kept — the properties export hints it.';
create index if not exists properties_org_owner_contact_idx
  on public.properties (org_id, owner_contact_id)
  where owner_contact_id is not null;

alter table public.properties
  drop constraint properties_developer_contact_id_fkey,
  add constraint properties_developer_contact_id_fkey
    foreign key (org_id, developer_contact_id) references public.contacts (org_id, id);
comment on constraint properties_developer_contact_id_fkey on public.properties is
  '0139: a listing''s developer is a contact of the listing''s organisation, by construction. '
  'Was the single-column key on developer_contact_id (NO ACTION, as it still is); the name is kept — the properties export hints it.';
create index if not exists properties_org_developer_contact_idx
  on public.properties (org_id, developer_contact_id)
  where developer_contact_id is not null;

alter table public.contacts
  drop constraint contacts_merged_into_id_fkey,
  add constraint contacts_merged_into_id_fkey
    foreign key (org_id, merged_into_id) references public.contacts (org_id, id);
comment on constraint contacts_merged_into_id_fkey on public.contacts is
  '0139: a merged contact points only at a primary of its own organisation, by construction. '
  'Was 0001''s single-column key on merged_into_id; NO ACTION, as it was — SET NULL would clear the pointer '
  'unarchiveContact reads, CASCADE would delete the merged duplicates; the name is kept.';
create index if not exists contacts_org_merged_into_idx
  on public.contacts (org_id, merged_into_id)
  where merged_into_id is not null;

-- ---------------------------------------------------------------------------
-- B. Postflight — the catalogue as intended, then the keys exercised
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
  n int;
  v_ok boolean; v_con text; v_step text;
  v_verdicts text[] := '{}';
  v_org_a uuid; v_org_b uuid; v_stage_a uuid; v_stage_b uuid;
  v_deal_a uuid; v_deal_b uuid; v_prop_a uuid; v_prop_b uuid;
  v_contact_a uuid; v_contact_a2 uuid; v_contact_b uuid;
begin
  -- the ten keys: exactly one per (table, column) onto contacts, composite
  -- (org_id, <col>) → contacts (org_id, id), validated, the predecessor's
  -- delete rule, NO ACTION on update, MATCH SIMPLE, the predecessor's NAME
  for c in
    select * from (values
      ('public.leads'::regclass,              'contact_id'::name,           'leads_contact_id_fkey',                'a'),
      ('public.deals'::regclass,              'buyer_contact_id'::name,     'deals_buyer_contact_id_fkey',          'a'),
      ('public.deals'::regclass,              'seller_contact_id'::name,    'deals_seller_contact_id_fkey',         'a'),
      ('public.offers'::regclass,             'contact_id'::name,           'offers_contact_id_fkey',               'a'),
      ('public.share_links'::regclass,        'contact_id'::name,           'share_links_contact_id_fkey',          'a'),
      ('public.buyer_requirements'::regclass, 'contact_id'::name,           'buyer_requirements_contact_id_fkey',   'c'),
      ('public.mandates'::regclass,           'owner_contact_id'::name,     'mandates_owner_contact_id_fkey',       'a'),
      ('public.properties'::regclass,         'owner_contact_id'::name,     'properties_owner_contact_id_fkey',     'a'),
      ('public.properties'::regclass,         'developer_contact_id'::name, 'properties_developer_contact_id_fkey', 'a'),
      ('public.contacts'::regclass,           'merged_into_id'::name,       'contacts_merged_into_id_fkey',         'a')
    ) as t(rel, col, name, del)
  loop
    select count(*) into n from pg_constraint f
     where f.conrelid = c.rel and f.confrelid = 'public.contacts'::regclass and f.contype = 'f'
       and (select attnum from pg_attribute where attrelid = c.rel and attname = c.col) = any (f.conkey);
    if n <> 1 then
      raise exception '0139 aborted: expected exactly one key from %.% onto contacts, found % (two relationships would make PostgREST embeds ambiguous)', c.rel, c.col, n;
    end if;
    if not exists (
      select 1 from pg_constraint k
       where k.conrelid = c.rel and k.confrelid = 'public.contacts'::regclass and k.contype = 'f'
         and k.conname = c.name and k.convalidated and not k.condeferrable
         and k.confdeltype::text = c.del and k.confupdtype = 'a' and k.confmatchtype = 's'
         and (select array_agg(a.attname order by x.ord) from unnest(k.conkey) with ordinality x(attnum, ord)
                join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.attnum) = array['org_id', c.col]::name[]
         and (select array_agg(a.attname order by x.ord) from unnest(k.confkey) with ordinality x(attnum, ord)
                join pg_attribute a on a.attrelid = k.confrelid and a.attnum = x.attnum) = array['org_id','id']::name[]) then
      raise exception '0139 aborted: % is not (org_id, %) -> contacts (org_id, id), validated, delete rule %, NO ACTION on update, MATCH SIMPLE', c.name, c.col, c.del;
    end if;
  end loop;

  -- every key onto contacts is now composite — the BACKLOG VERIFY: 0
  select count(*) into n from pg_constraint
   where contype = 'f' and confrelid = 'public.contacts'::regclass and array_length(conkey, 1) = 1;
  if n <> 0 then
    raise exception '0139 aborted: % single-column key(s) onto contacts remain', n;
  end if;

  if (select count(*) from pg_indexes where schemaname = 'public'
        and ((indexname = 'leads_org_contact_idx'                and indexdef ~ 'ON public\.leads USING btree \(org_id, contact_id\) WHERE \(contact_id IS NOT NULL\)$')
          or (indexname = 'deals_org_buyer_contact_idx'          and indexdef ~ 'ON public\.deals USING btree \(org_id, buyer_contact_id\) WHERE \(buyer_contact_id IS NOT NULL\)$')
          or (indexname = 'deals_org_seller_contact_idx'         and indexdef ~ 'ON public\.deals USING btree \(org_id, seller_contact_id\) WHERE \(seller_contact_id IS NOT NULL\)$')
          or (indexname = 'offers_org_contact_idx'               and indexdef ~ 'ON public\.offers USING btree \(org_id, contact_id\) WHERE \(contact_id IS NOT NULL\)$')
          or (indexname = 'share_links_org_contact_idx'          and indexdef ~ 'ON public\.share_links USING btree \(org_id, contact_id\) WHERE \(contact_id IS NOT NULL\)$')
          or (indexname = 'buyer_requirements_org_contact_idx'   and indexdef ~ 'ON public\.buyer_requirements USING btree \(org_id, contact_id\)$')
          or (indexname = 'mandates_org_owner_contact_idx'       and indexdef ~ 'ON public\.mandates USING btree \(org_id, owner_contact_id\) WHERE \(owner_contact_id IS NOT NULL\)$')
          or (indexname = 'properties_org_owner_contact_idx'     and indexdef ~ 'ON public\.properties USING btree \(org_id, owner_contact_id\) WHERE \(owner_contact_id IS NOT NULL\)$')
          or (indexname = 'properties_org_developer_contact_idx' and indexdef ~ 'ON public\.properties USING btree \(org_id, developer_contact_id\) WHERE \(developer_contact_id IS NOT NULL\)$')
          or (indexname = 'contacts_org_merged_into_idx'         and indexdef ~ 'ON public\.contacts USING btree \(org_id, merged_into_id\) WHERE \(merged_into_id IS NOT NULL\)$'))) <> 10 then
    raise exception '0139 aborted: a referencing index is missing or has the wrong definition';
  end if;

  -- MATCH SIMPLE skips a row with any null key column: the boundary rests on
  -- every org_id involved being NOT NULL
  if exists (select 1 from pg_attribute
              where attname = 'org_id' and not attnotnull
                and attrelid in ('public.leads'::regclass, 'public.deals'::regclass, 'public.offers'::regclass,
                                 'public.share_links'::regclass, 'public.buyer_requirements'::regclass,
                                 'public.mandates'::regclass, 'public.properties'::regclass, 'public.contacts'::regclass)) then
    raise exception '0139 aborted: an org_id column on the eight tables is nullable';
  end if;

  -- the referenced key and the three earlier contact keys, untouched
  select count(*) into n from pg_constraint
   where convalidated
     and ((conname = 'contacts_org_id_id_key'        and conrelid = 'public.contacts'::regclass     and pg_get_constraintdef(oid) = 'UNIQUE (org_id, id)')
       or (conname = 'viewings_org_contact_fkey'     and conrelid = 'public.viewings'::regclass     and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id)')
       or (conname = 'reservations_org_contact_fkey' and conrelid = 'public.reservations'::regclass and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id) ON DELETE SET NULL (contact_id)')
       or (conname = 'tasks_org_contact_fkey'        and conrelid = 'public.tasks'::regclass        and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id)'));
  if n <> 4 then
    raise exception '0139 aborted: contacts_org_id_id_key or one of the 0123 / 0126 contact keys is missing, not validated, or changed';
  end if;

  -- the keys, exercised: two organisations, each with a deal stage, a deal, a
  -- property and contacts; organisation A's ten links to its own contact
  -- (accepted), then each cross-organisation row in its own sub-block,
  -- refused by ITS key at ITS step. None of the ten tables needs a profile,
  -- so every probe runs on an empty database too (CI's migration run).
  for c in
    select * from (values
      ('lead',              'leads_contact_id_fkey'),
      ('deal-buyer',        'deals_buyer_contact_id_fkey'),
      ('deal-seller',       'deals_seller_contact_id_fkey'),
      ('offer',             'offers_contact_id_fkey'),
      ('share-link',        'share_links_contact_id_fkey'),
      ('requirement',       'buyer_requirements_contact_id_fkey'),
      ('mandate',           'mandates_owner_contact_id_fkey'),
      ('property-owner',    'properties_owner_contact_id_fkey'),
      ('property-developer','properties_developer_contact_id_fkey'),
      ('merge-pointer',     'contacts_merged_into_id_fkey')
    ) as t(kind, expect)
  loop
    v_ok := null; v_con := null; v_step := 'setup';
    begin
      insert into organizations (name, slug)
        values ('0139 probe A (rolled back)', '0139-probe-a-' || replace(gen_random_uuid()::text, '-', ''))
        returning id into v_org_a;
      insert into organizations (name, slug)
        values ('0139 probe B (rolled back)', '0139-probe-b-' || replace(gen_random_uuid()::text, '-', ''))
        returning id into v_org_b;
      insert into deal_stages (org_id, deal_type, name, sort_order) values (v_org_a, 'sale', '0139 probe', 1) returning id into v_stage_a;
      insert into deal_stages (org_id, deal_type, name, sort_order) values (v_org_b, 'sale', '0139 probe', 1) returning id into v_stage_b;
      insert into contacts (org_id, first_name) values (v_org_a, '0139 probe A')  returning id into v_contact_a;
      insert into contacts (org_id, first_name) values (v_org_a, '0139 probe A2') returning id into v_contact_a2;
      insert into contacts (org_id, first_name) values (v_org_b, '0139 probe B')  returning id into v_contact_b;
      insert into properties (org_id, reference, property_type) values (v_org_a, 'ZZZ0139-probe-a', 'apartment') returning id into v_prop_a;
      insert into properties (org_id, reference, property_type) values (v_org_b, 'ZZZ0139-probe-b', 'apartment') returning id into v_prop_b;
      insert into deals (org_id, deal_type, stage_id, title) values (v_org_a, 'sale', v_stage_a, '0139 probe A') returning id into v_deal_a;
      insert into deals (org_id, deal_type, stage_id, title) values (v_org_b, 'sale', v_stage_b, '0139 probe B') returning id into v_deal_b;
      -- the same-organisation links: all accepted
      v_step := 'own';
      insert into leads (org_id, contact_id) values (v_org_a, v_contact_a);
      update deals set buyer_contact_id = v_contact_a, seller_contact_id = v_contact_a2 where id = v_deal_a;
      insert into offers (org_id, deal_id, amount, contact_id) values (v_org_a, v_deal_a, 1, v_contact_a);
      insert into share_links (org_id, token_sha256, expires_at, contact_id)
        values (v_org_a, md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), now() + interval '1 day', v_contact_a);
      insert into buyer_requirements (org_id, contact_id) values (v_org_a, v_contact_a);
      insert into mandates (org_id, property_id, type, owner_contact_id) values (v_org_a, v_prop_a, 'exclusive', v_contact_a);
      update properties set owner_contact_id = v_contact_a, developer_contact_id = v_contact_a2 where id = v_prop_a;
      update contacts set merged_into_id = v_contact_a where id = v_contact_a2;
      -- organisation B's row naming organisation A's contact: the
      -- single-column keys accepted each of these
      v_step := 'cross';
      if c.kind = 'lead' then
        insert into leads (org_id, contact_id) values (v_org_b, v_contact_a);
      elsif c.kind = 'deal-buyer' then
        update deals set buyer_contact_id = v_contact_a where id = v_deal_b;
      elsif c.kind = 'deal-seller' then
        update deals set seller_contact_id = v_contact_a where id = v_deal_b;
      elsif c.kind = 'offer' then
        insert into offers (org_id, deal_id, amount, contact_id) values (v_org_b, v_deal_b, 1, v_contact_a);
      elsif c.kind = 'share-link' then
        insert into share_links (org_id, token_sha256, expires_at, contact_id)
          values (v_org_b, md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), now() + interval '1 day', v_contact_a);
      elsif c.kind = 'requirement' then
        insert into buyer_requirements (org_id, contact_id) values (v_org_b, v_contact_a);
      elsif c.kind = 'mandate' then
        insert into mandates (org_id, property_id, type, owner_contact_id) values (v_org_b, v_prop_b, 'exclusive', v_contact_a);
      elsif c.kind = 'property-owner' then
        update properties set owner_contact_id = v_contact_a where id = v_prop_b;
      elsif c.kind = 'property-developer' then
        update properties set developer_contact_id = v_contact_a where id = v_prop_b;
      else
        update contacts set merged_into_id = v_contact_a where id = v_contact_b;
      end if;
      raise exception using errcode = 'P0139', message = '0139 probe: a cross-organisation row was ACCEPTED';
    exception
      when foreign_key_violation then
        -- refused, and the sub-block's rows are gone — but only THIS key's
        -- refusal at the cross step is the verdict
        get stacked diagnostics v_con = constraint_name;
        v_ok := (v_con = c.expect and v_step = 'cross');
      when unique_violation then
        -- the 23505-before-23503 oracle: a verdict, not a crash
        get stacked diagnostics v_con = constraint_name;
        v_ok := false;
      when sqlstate 'P0139' then
        v_ok := false;  -- accepted, and the sub-block's rows are gone too
    end;
    if v_ok is not true then
      raise exception '0139 aborted: the % probe was not refused by % at the cross-organisation step (met % at the % step)',
        c.kind, c.expect, coalesce(v_con, 'no foreign-key violation'), v_step;
    end if;
    v_verdicts := v_verdicts || c.kind;
  end loop;

  perform set_config('gnk.m0139_summary',
    format('keys_replaced=10 single_column_onto_contacts=0 probes_refused=%s (%s)',
           cardinality(v_verdicts), array_to_string(v_verdicts, ', ')), true);
  raise notice '0139: probes refused by their keys: %', v_verdicts;
  raise notice '0139: leads, deals (buyer, seller), offers, share links, requirements, mandates, listings (owner, developer) and merge pointers tenant-bound to their contact''s organisation';
end $$;

-- the file's LAST result: a read-only summary of what the postflight proved
select current_setting('gnk.m0139_summary', true) as summary;
