-- =============================================================================
-- 0129 — a deal's offers, holds, viewings and converted lead belong to the
--        deal's organisation, a hold's offer to the hold's, and a viewing's
--        signed slip to the viewing's
--
-- THE GAP (BACKLOG "offers.deal_id carries no tenant tie", "A viewing slip can
-- name another organisation's viewing", "createReservation accepts a form
-- deal_id without an RLS re-read"; reproduced 2026-10-01 on the local stack
-- at 0128, through PostgREST with aal2 sessions of two throwaway
-- organisations, and pinned RED first by
-- supabase/tests/deal-child-org-isolation.test.ts — its 11 tests marked "RED
-- at 0128" failed at 0128, each for the reason it names, every refusal
-- asserted by the constraint's name):
--
--   * offers.deal_id (0001, ON DELETE CASCADE), reservations.deal_id and
--     reservations.offer_id (0044, ON DELETE SET NULL), viewings.deal_id
--     (0001, NO ACTION), leads.converted_deal_id (0001's leads_converted_fk,
--     NO ACTION) and viewing_slips.viewing_id (0001, ON DELETE CASCADE)
--     referenced their parent by id ALONE, and the insert / update policies
--     check only the CALLER's organisation. A member of organisation B who
--     learned an organisation-A deal, offer or viewing id — B can read none of
--     them, but an id travels in links, screenshots and logs — could hang B's
--     offer, hold or viewing on A's deal, name A's offer on B's hold, mark B's
--     lead converted into A's deal, or PATCH / UPSERT B's rows onto them; and
--     a real id (accepted) and a missing one (23503) told B whether the A row
--     exists.
--   * B's ADMIN could sign A's viewing (viewing_slips_insert's admin arm
--     checks only org_id). The slip held viewing_slips_viewing_id_key
--     (UNIQUE (viewing_id)), so A's own signing then failed 23505 — "This
--     viewing already has a signed slip" — a denial of service on A's
--     commission evidence. And B's slip on an A viewing that WAS signed
--     answered 23505 (the unique index), on an unsigned one it was accepted,
--     on a missing id 23503: an oracle on whether A's viewing had been signed.
--   * Where a policy refuses first: offers_insert's and viewing_slips_insert's
--     AGENT arms read the deal / viewing under RLS, and an agent's filtered
--     UPDATE of an offer is also checked against offers_select (whose agent
--     arm reads the deal), so a B agent met 42501 there before any key —
--     before this file and after it, a real id and a missing one alike. The
--     admin arms, and every UPDATE of a hold, a viewing or a lead, reached the
--     key; viewing_slips has no UPDATE policy at all.
--
-- THE FIX — 0119–0126's layer A; no function reads these links across
-- organisations (none of the sweeps copies them), so there is no layer B:
--
--   offers_org_id_id_key UNIQUE (org_id, id) is ADDED, the parent key for a
--   hold's offer (deals_org_id_id_key and viewings_org_id_id_key exist since
--   0119 / 0120). Then six composite keys each REPLACE the single-column key,
--   so PostgREST keeps ONE relationship per pair:
--     offers        (org_id, deal_id)           → deals    (org_id, id)  ON DELETE CASCADE
--     reservations  (org_id, deal_id)           → deals    (org_id, id)  ON DELETE SET NULL (deal_id)
--     reservations  (org_id, offer_id)          → offers   (org_id, id)  ON DELETE SET NULL (offer_id)
--     viewings      (org_id, deal_id)           → deals    (org_id, id)  NO ACTION
--     leads         (org_id, converted_deal_id) → deals    (org_id, id)  NO ACTION
--     viewing_slips (org_id, viewing_id)        → viewings (org_id, id)  ON DELETE CASCADE
--     - each keeps its predecessor's delete rule. SET NULL with the column
--       list (PostgreSQL 15+; local and hosted run 17): a plain SET NULL on a
--       composite key nulls EVERY referencing column, and reservations.org_id
--       is NOT NULL — deleting a deal or an offer would fail 23502 where it
--       used to clear the hold's link. With the list only deal_id / offer_id
--       is cleared and the hold keeps its organisation, exactly as 0044's
--       keys did. CASCADE removes the same rows as before (every child of a
--       valid parent carries its organisation).
--     - ON UPDATE NO ACTION as before, and it now covers the parent's org_id
--       too, so a linked deal, offer or viewing cannot be moved to another
--       organisation (no application path writes any org_id).
--     - MATCH SIMPLE, and every org_id involved is NOT NULL (asserted below),
--       so a row with no deal / offer is exactly as before and nothing else
--       escapes the check.
--   viewing_slips_viewing_id_key UNIQUE (viewing_id) is RE-KEYED to
--   viewing_slips_org_viewing_key UNIQUE (org_id, viewing_id) — 0122's
--   lesson: a unique index answers at insert, a key at the end of the
--   statement, so on the old index B's slip on a signed A viewing answered
--   23505 and on an unsigned one 23503. With the key above every slip of a
--   viewing carries the viewing's organisation, so for valid rows the rule is
--   unchanged (a second slip on the same viewing still answers 23505, which
--   signViewingSlip turns into "This viewing already has a signed slip"),
--   B's row never collides with A's, and every cross-organisation attempt
--   reads the same 23503. It is a CONSTRAINT, not a bare unique index:
--   PostgREST infers a one-to-one embed (viewings → viewing_slips as ONE
--   object, which the viewings CSV reads) only from a unique constraint
--   covering exactly the key's columns. A plain viewing_slips_viewing_id_idx
--   (viewing_id) keeps the lookups by viewing id alone (the signing page and
--   action, the viewing page, the evidence pack) on an index.
--   Each other referencing side gets an (org_id, x) index — partial where the
--   column is nullable (the advisors' unindexed-foreign-key rule reads an
--   index's leading columns); the single-column deal_id indexes on offers
--   (0077) and on viewings and reservations (0092) stay — they serve the
--   lookups by the parent id alone (the deal page); reservations.offer_id and
--   leads.converted_deal_id had none.
--   A cross-organisation id and a missing id now read the same 23503 — no
--   existence oracle through THESE SIX columns. The constraints bind EVERY
--   writer, service_role and definer bodies included.
--
-- NOT CHANGED HERE (BACKLOG): the contact links (leads.contact_id, deals' and
-- offers' contact and property links, mandates' and properties' contact
-- links), reservations.payment_plan_id, the profile links. viewing_slips'
-- signature_path / pdf_path are free text the database does not tie to the
-- row, and the two service-role readers used to fetch whatever path a row
-- named — a B slip naming A's files was served A's signed slip (found by this
-- file's review, reproduced locally). The application change that ships with
-- this file makes both readers derive the object name from the row's
-- (org_id, viewing_id) instead (lib/services/slip-paths.ts); a CHECK tying the
-- two columns to the row is filed in BACKLOG, with documents.storage_path's
-- twin.
--
-- EXISTING DATA. The preflight below counts, for each of the six links, the
-- rows whose organisation differs from their parent's, and ABORTS THE WHOLE
-- FILE before any DDL if there are any: nothing is deleted, reassigned or
-- repaired here, and no constraint is ever added NOT VALID by this file. It
-- also refuses if the six keys it replaces, or the unique key it re-keys, are
-- not the ones 0001 / 0044 left (their rules are what it preserves), or if
-- offers already has a unique key other than its primary key, or if a name
-- it creates is taken.
--
-- LOCKS. Every lock the DDL needs is taken at its strongest, in ONE
-- statement, BEFORE the counts: deals, offers, viewings — the parents — then
-- leads, reservations, viewing_slips. close_deal takes the same order (the
-- deal row, then its offers). What can still collide is a statement that
-- holds a child and then reaches its parent — an insert's key check at the
-- end of its statement, or ANY session read of offers or viewing_slips,
-- whose select policy reads the deal / the viewing — which ends in a 40P01
-- deadlock with one of the two rolled back whole, cleanly: a page load, or
-- this file. lock_timeout bounds
-- EACH table's wait, not the statement's: the LOCK can wait up to 5 s on each
-- of its six tables while holding the ones before it — up to about 30 s
-- during which deals and leads are unreadable. Every job that reads these
-- tables runs as a short statement (raise_lead_escalations every five minutes
-- and raise_lead_sla_tasks every ten read leads, as does the enquiry-alerts
-- route that enquiry_alerts_sweep calls every two minutes and Vercel's cron
-- at 06:00; redact_stale_enquiries at 03:10 writes leads;
-- create_followup_nudges at 03:15 reads deals and viewings;
-- expire_reservations at 03:45 and the reservation sweeps at 03:50 / 03:55
-- read holds): apply outside 02:55–04:05 UTC and away from 06:00, at the
-- middle of an odd minute that is not a multiple of five, when the site is
-- quiet. A collision costs
-- that wait and a clean 55P03 or 40P01 rollback — then apply again, and do NOT
-- write the ledger row. Run twice by mistake, the file aborts in its
-- preflight (the replaced keys are no longer the old ones) and changes
-- nothing.
--
-- DEPLOY ORDER: ADDITIVE — hosted before the merge. Every application writer
-- of the six columns takes org_id and the parent from the same organisation:
-- saveOffer's insert from the deal re-read under RLS (org_id = deal.org_id;
-- its edit path and updateOfferStatus write neither column); signViewingSlip
-- from the viewing re-read under RLS (org_id =
-- v.org_id); convertLead from the deal it has just created in the caller's
-- organisation; createReservation's and createViewing's forms send only ids
-- offered from the caller's own lists (the reservation form sends no deal or
-- offer at all) — a crafted id is refused 23503 by the keys until this
-- branch's re-reads deploy, after which it is refused with a sentence first.
-- No request the deployed application sends is refused. No function
-- signature, return shape or grant changes — no release-compat entry.
-- database.types.ts is regenerated: six Relationships entries are renamed
-- (offers_deal_id_fkey → offers_org_deal_fkey, reservations_deal_id_fkey →
-- reservations_org_deal_fkey, reservations_offer_id_fkey →
-- reservations_org_offer_fkey, viewings_deal_id_fkey →
-- viewings_org_deal_fkey, leads_converted_fk → leads_org_converted_deal_fkey,
-- viewing_slips_viewing_id_fkey → viewing_slips_org_viewing_fkey) over
-- (org_id, x); no query hints any of them by name.
--
-- ROLLBACK (DECISIONS T-deal-child-org-isolation): a FORWARD migration that
-- drops the six keys and their indexes, re-adds `offers_deal_id_fkey
-- (deal_id) → deals(id) ON DELETE CASCADE`, `reservations_deal_id_fkey
-- (deal_id) → deals(id) ON DELETE SET NULL`, `reservations_offer_id_fkey
-- (offer_id) → offers(id) ON DELETE SET NULL`, `viewings_deal_id_fkey
-- (deal_id) → deals(id)`, `leads_converted_fk (converted_deal_id) →
-- deals(id)` and `viewing_slips_viewing_id_fkey (viewing_id) → viewings(id)
-- ON DELETE CASCADE`, swaps viewing_slips_org_viewing_key back to
-- `viewing_slips_viewing_id_key UNIQUE (viewing_id)` (dropping
-- viewing_slips_viewing_id_idx), and drops offers_org_id_id_key (after
-- reservations_org_offer_fkey, which depends on it); regenerate the types,
-- move the verify-restore migrations pin FORWARD (one more ledger row),
-- remove its 0129 rows, remove the new test file (its tests marked RED at
-- 0128 fail on the rolled-back catalogue), revert the docs. Keep the
-- application changes: the re-reads, the CSV fix and the slip readers'
-- derived object names hold at 0128 too (the derived name is always in the
-- row's — the caller's — organisation's folder). No data moves either way:
-- every row valid at 0129 is valid at 0128.
--
-- Pins that move with this file: the migrations count (128 -> 129) and two
-- 0129 invariant rows in scripts/backup/verify-restore.sql (the six mismatch
-- counts, and dangling ids). NO EXPLICIT begin/commit — the CLI wraps the
-- file (HANDOFF §3), as does one execute_sql call.
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
    raise exception '0129 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0. Preflight — abort, whole, over existing mismatches or a changed key
-- ---------------------------------------------------------------------------
do $$
declare
  n_od int; n_rd int; n_ro int; n_vd int; n_ld int; n_sv int;
  k record;
begin
  -- every lock the DDL below needs, at its strongest, BEFORE the counts;
  -- parents first (see LOCKS in the header)
  lock table public.deals, public.offers, public.viewings, public.leads, public.reservations, public.viewing_slips in access exclusive mode;

  select count(*) into n_od from public.offers o        join public.deals d    on d.id = o.deal_id           where o.org_id <> d.org_id;
  select count(*) into n_rd from public.reservations r  join public.deals d    on d.id = r.deal_id           where r.org_id <> d.org_id;
  select count(*) into n_ro from public.reservations r  join public.offers o   on o.id = r.offer_id          where r.org_id <> o.org_id;
  select count(*) into n_vd from public.viewings v      join public.deals d    on d.id = v.deal_id           where v.org_id <> d.org_id;
  select count(*) into n_ld from public.leads l         join public.deals d    on d.id = l.converted_deal_id where l.org_id <> d.org_id;
  select count(*) into n_sv from public.viewing_slips s join public.viewings v on v.id = s.viewing_id        where s.org_id <> v.org_id;
  if n_od + n_rd + n_ro + n_vd + n_ld + n_sv > 0 then
    raise exception '0129 aborted: rows name a parent of another organisation — % offer(s) a deal, % reservation(s) a deal, % reservation(s) an offer, % viewing(s) a deal, % lead(s) a converted deal, % slip(s) a viewing — nothing was changed. '
                    'List them with the six joins in this preflight and decide before constraining',
                    n_od, n_rd, n_ro, n_vd, n_ld, n_sv;
  end if;

  -- the keys this file replaces must be the ones it replaces — their delete
  -- and update rules are what it preserves — and the only ones for the pair
  -- on that column set (reservations names offers once, deals once)
  for k in
    select * from (values
      ('public.offers'::regclass,        'public.deals'::regclass,    'offers_deal_id_fkey',           'FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE',       '0001'),
      ('public.reservations'::regclass,  'public.deals'::regclass,    'reservations_deal_id_fkey',     'FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL',      '0044'),
      ('public.reservations'::regclass,  'public.offers'::regclass,   'reservations_offer_id_fkey',    'FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE SET NULL',    '0044'),
      ('public.viewings'::regclass,      'public.deals'::regclass,    'viewings_deal_id_fkey',         'FOREIGN KEY (deal_id) REFERENCES deals(id)',                         '0001'),
      ('public.leads'::regclass,         'public.deals'::regclass,    'leads_converted_fk',            'FOREIGN KEY (converted_deal_id) REFERENCES deals(id)',               '0001'),
      ('public.viewing_slips'::regclass, 'public.viewings'::regclass, 'viewing_slips_viewing_id_fkey', 'FOREIGN KEY (viewing_id) REFERENCES viewings(id) ON DELETE CASCADE', '0001')
    ) as t(rel, ref, name, def, src)
  loop
    if (select count(*) from pg_constraint where conrelid = k.rel and confrelid = k.ref and contype = 'f') <> 1
       or not exists (select 1 from pg_constraint
                       where conrelid = k.rel and confrelid = k.ref and contype = 'f' and conname = k.name
                         and convalidated and not condeferrable and pg_get_constraintdef(oid) = k.def) then
      raise exception '0129 aborted: the foreign key from % to % is not %''s % (%, validated, not deferrable, the only one) on this database — nothing was changed. '
                      'This file replaces it and keeps its rules; compare it with % and decide before applying',
                      k.rel, k.ref, k.src, k.name, k.def, k.src;
    end if;
  end loop;

  -- the unique key this file re-keys, and the one it adds, must be as 0001
  -- left them: a slip unique on its viewing alone, and offers with no unique
  -- key but its primary key
  if (select count(*) from pg_constraint where conrelid = 'public.viewing_slips'::regclass and contype = 'u') <> 1
     or not exists (select 1 from pg_constraint
                     where conrelid = 'public.viewing_slips'::regclass and contype = 'u'
                       and conname = 'viewing_slips_viewing_id_key' and pg_get_constraintdef(oid) = 'UNIQUE (viewing_id)') then
    raise exception '0129 aborted: viewing_slips'' unique key is not 0001''s viewing_slips_viewing_id_key UNIQUE (viewing_id), the only one — nothing was changed';
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.offers'::regclass and contype = 'u')
     or exists (select 1 from pg_class where relname in ('offers_org_id_id_key', 'viewing_slips_org_viewing_key', 'viewing_slips_viewing_id_idx')
                  and relnamespace = 'public'::regnamespace) then
    raise exception '0129 aborted: offers already has a unique key, or a name this file creates is taken — nothing was changed';
  end if;
  raise notice '0129: preflight passed — no offer, hold, viewing, converted lead or slip names a parent of another organisation; the six keys and the slip''s unique key are the ones replaced';
end $$;

-- ---------------------------------------------------------------------------
-- A. The parent key a hold's offer needs
-- ---------------------------------------------------------------------------
alter table public.offers
  add constraint offers_org_id_id_key unique (org_id, id);
comment on constraint offers_org_id_id_key on public.offers is
  '0129: the (org_id, id) key reservations_org_offer_fkey references, so a hold can name only its own organisation''s offer.';

-- ---------------------------------------------------------------------------
-- B. The relationships
-- ---------------------------------------------------------------------------
alter table public.offers
  drop constraint offers_deal_id_fkey;
alter table public.offers
  add constraint offers_org_deal_fkey
    foreign key (org_id, deal_id) references public.deals (org_id, id) on delete cascade;
comment on constraint offers_org_deal_fkey on public.offers is
  '0129: an offer belongs to the organisation of its deal, by construction. '
  'Replaces the single-column FK on deal_id (ON DELETE CASCADE, as that one was).';
create index if not exists offers_org_deal_idx
  on public.offers (org_id, deal_id);

alter table public.reservations
  drop constraint reservations_deal_id_fkey;
alter table public.reservations
  add constraint reservations_org_deal_fkey
    foreign key (org_id, deal_id) references public.deals (org_id, id) on delete set null (deal_id);
comment on constraint reservations_org_deal_fkey on public.reservations is
  '0129: a reservation belongs to the organisation of the deal it names, by construction. '
  'Replaces the single-column FK on deal_id; ON DELETE SET NULL (deal_id), as that one cleared the link — '
  'the column list keeps org_id (a plain SET NULL would null it too); a reservation with no deal is not checked (MATCH SIMPLE).';
create index if not exists reservations_org_deal_idx
  on public.reservations (org_id, deal_id)
  where deal_id is not null;

alter table public.reservations
  drop constraint reservations_offer_id_fkey;
alter table public.reservations
  add constraint reservations_org_offer_fkey
    foreign key (org_id, offer_id) references public.offers (org_id, id) on delete set null (offer_id);
comment on constraint reservations_org_offer_fkey on public.reservations is
  '0129: a reservation belongs to the organisation of the offer it names, by construction. '
  'Replaces the single-column FK on offer_id; ON DELETE SET NULL (offer_id), as that one cleared the link — '
  'the column list keeps org_id; a reservation with no offer is not checked (MATCH SIMPLE).';
create index if not exists reservations_org_offer_idx
  on public.reservations (org_id, offer_id)
  where offer_id is not null;

alter table public.viewings
  drop constraint viewings_deal_id_fkey;
alter table public.viewings
  add constraint viewings_org_deal_fkey
    foreign key (org_id, deal_id) references public.deals (org_id, id);
comment on constraint viewings_org_deal_fkey on public.viewings is
  '0129: a viewing belongs to the organisation of the deal it names, by construction. '
  'Replaces the single-column FK on deal_id (NO ACTION, as that one was); a viewing with no deal is not checked (MATCH SIMPLE).';
create index if not exists viewings_org_deal_idx
  on public.viewings (org_id, deal_id)
  where deal_id is not null;

alter table public.leads
  drop constraint leads_converted_fk;
alter table public.leads
  add constraint leads_org_converted_deal_fkey
    foreign key (org_id, converted_deal_id) references public.deals (org_id, id);
comment on constraint leads_org_converted_deal_fkey on public.leads is
  '0129: a lead is converted only into a deal of its own organisation, by construction. '
  'Replaces leads_converted_fk on converted_deal_id (NO ACTION, as that one was); an unconverted lead is not checked (MATCH SIMPLE).';
create index if not exists leads_org_converted_deal_idx
  on public.leads (org_id, converted_deal_id)
  where converted_deal_id is not null;

-- the slip: the unique key re-keyed by organisation first (see the header),
-- then the key that makes it equivalent for every valid row
alter table public.viewing_slips
  drop constraint viewing_slips_viewing_id_key;
alter table public.viewing_slips
  add constraint viewing_slips_org_viewing_key unique (org_id, viewing_id);
comment on constraint viewing_slips_org_viewing_key on public.viewing_slips is
  '0001 / 0129: one signed slip per viewing. Keyed (org_id, viewing_id) since 0129 — with viewing_slips_org_viewing_fkey '
  'the same rule for every valid row, and a foreign organisation''s slip can no longer collide with it (which blocked the '
  'viewing''s own signing and answered 23505, an oracle on whether it was signed). A constraint, not a bare index: '
  'PostgREST embeds a viewing''s slip as one object only through a unique constraint on the key''s columns.';
create index if not exists viewing_slips_viewing_id_idx
  on public.viewing_slips (viewing_id);

alter table public.viewing_slips
  drop constraint viewing_slips_viewing_id_fkey;
alter table public.viewing_slips
  add constraint viewing_slips_org_viewing_fkey
    foreign key (org_id, viewing_id) references public.viewings (org_id, id) on delete cascade;
comment on constraint viewing_slips_org_viewing_fkey on public.viewing_slips is
  '0129: a signed slip belongs to the organisation of its viewing, by construction. '
  'Replaces the single-column FK on viewing_id (ON DELETE CASCADE, as that one was).';

-- ---------------------------------------------------------------------------
-- C. Postflight — the catalogue as intended, then the keys exercised
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
  n int;
  v_ok boolean; v_con text; v_step text;
  v_verdicts text[] := '{}';
  v_skipped text[] := '{}';
  v_org_a uuid; v_org_b uuid; v_stage_a uuid; v_stage_b uuid;
  v_deal_a uuid; v_deal_b uuid; v_offer_a uuid; v_prop_a uuid; v_prop_b uuid;
  v_contact_a uuid; v_contact_b uuid; v_viewing_a uuid; v_agent uuid; v_lead_b uuid;
begin
  -- the six keys: exactly one per (table, parent), composite, validated,
  -- the predecessor's delete rule, NO ACTION on update, MATCH SIMPLE
  for c in
    select * from (values
      ('public.offers'::regclass,        'public.deals'::regclass,    'offers_org_deal_fkey',           array['org_id','deal_id']::name[],           'c', 'offers_deal_id_fkey'),
      ('public.reservations'::regclass,  'public.deals'::regclass,    'reservations_org_deal_fkey',     array['org_id','deal_id']::name[],           'n', 'reservations_deal_id_fkey'),
      ('public.reservations'::regclass,  'public.offers'::regclass,   'reservations_org_offer_fkey',    array['org_id','offer_id']::name[],          'n', 'reservations_offer_id_fkey'),
      ('public.viewings'::regclass,      'public.deals'::regclass,    'viewings_org_deal_fkey',         array['org_id','deal_id']::name[],           'a', 'viewings_deal_id_fkey'),
      ('public.leads'::regclass,         'public.deals'::regclass,    'leads_org_converted_deal_fkey',  array['org_id','converted_deal_id']::name[], 'a', 'leads_converted_fk'),
      ('public.viewing_slips'::regclass, 'public.viewings'::regclass, 'viewing_slips_org_viewing_fkey', array['org_id','viewing_id']::name[],        'c', 'viewing_slips_viewing_id_fkey')
    ) as t(rel, ref, name, cols, del, old)
  loop
    select count(*) into n from pg_constraint where conrelid = c.rel and confrelid = c.ref and contype = 'f';
    if n <> 1 then
      raise exception '0129 aborted: expected exactly one foreign key from % to %, found %', c.rel, c.ref, n;
    end if;
    if not exists (
      select 1 from pg_constraint k
       where k.conrelid = c.rel and k.confrelid = c.ref and k.contype = 'f'
         and k.conname = c.name and k.convalidated and not k.condeferrable
         and k.confdeltype::text = c.del and k.confupdtype = 'a' and k.confmatchtype = 's'
         and (select array_agg(a.attname order by x.ord) from unnest(k.conkey) with ordinality x(attnum, ord)
                join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.attnum) = c.cols
         and (select array_agg(a.attname order by x.ord) from unnest(k.confkey) with ordinality x(attnum, ord)
                join pg_attribute a on a.attrelid = k.confrelid and a.attnum = x.attnum) = array['org_id','id']::name[]
         -- SET NULL clears only the link column, never org_id
         and (c.del <> 'n' or (select array_agg(a.attname) from unnest(k.confdelsetcols) x(attnum)
                                  join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.attnum) = array[c.cols[2]])) then
      raise exception '0129 aborted: % is not % -> % (org_id, id), validated, delete rule % (SET NULL on its link column only), NO ACTION on update, MATCH SIMPLE', c.name, c.cols, c.ref, c.del;
    end if;
    if exists (select 1 from pg_constraint where conrelid = c.rel and conname = c.old) then
      raise exception '0129 aborted: the single-column % is still there (two relationships would make PostgREST embeds ambiguous)', c.old;
    end if;
  end loop;

  -- the unique keys: offers' parent key, and the slip's, re-keyed — each a
  -- CONSTRAINT (PostgREST reads constraints), and the slip's the only one
  select count(*) into n from pg_constraint
   where (conrelid = 'public.offers'::regclass and contype = 'u' and conname = 'offers_org_id_id_key' and pg_get_constraintdef(oid) = 'UNIQUE (org_id, id)')
      or (conrelid = 'public.viewing_slips'::regclass and contype = 'u' and conname = 'viewing_slips_org_viewing_key' and pg_get_constraintdef(oid) = 'UNIQUE (org_id, viewing_id)');
  if n <> 2
     or (select count(*) from pg_constraint where conrelid = 'public.viewing_slips'::regclass and contype = 'u') <> 1 then
    raise exception '0129 aborted: offers_org_id_id_key UNIQUE (org_id, id) or viewing_slips_org_viewing_key UNIQUE (org_id, viewing_id) is missing, or the slip has another unique key';
  end if;

  if (select count(*) from pg_indexes where schemaname = 'public'
        and ((indexname = 'offers_org_deal_idx'           and indexdef ~ 'ON public\.offers USING btree \(org_id, deal_id\)$')
          or (indexname = 'reservations_org_deal_idx'     and indexdef ~ 'ON public\.reservations USING btree \(org_id, deal_id\) WHERE \(deal_id IS NOT NULL\)$')
          or (indexname = 'reservations_org_offer_idx'    and indexdef ~ 'ON public\.reservations USING btree \(org_id, offer_id\) WHERE \(offer_id IS NOT NULL\)$')
          or (indexname = 'viewings_org_deal_idx'         and indexdef ~ 'ON public\.viewings USING btree \(org_id, deal_id\) WHERE \(deal_id IS NOT NULL\)$')
          or (indexname = 'leads_org_converted_deal_idx'  and indexdef ~ 'ON public\.leads USING btree \(org_id, converted_deal_id\) WHERE \(converted_deal_id IS NOT NULL\)$')
          or (indexname = 'viewing_slips_viewing_id_idx'  and indexdef ~ 'ON public\.viewing_slips USING btree \(viewing_id\)$'))) <> 6 then
    raise exception '0129 aborted: a referencing index is missing or has the wrong definition';
  end if;

  -- MATCH SIMPLE skips a row with any null key column: the boundary rests on
  -- every org_id involved being NOT NULL
  if exists (select 1 from pg_attribute
              where attname = 'org_id' and not attnotnull
                and attrelid in ('public.offers'::regclass, 'public.reservations'::regclass, 'public.viewings'::regclass,
                                 'public.leads'::regclass, 'public.viewing_slips'::regclass, 'public.deals'::regclass)) then
    raise exception '0129 aborted: an org_id column on offers, reservations, viewings, leads, viewing_slips or deals is nullable';
  end if;

  -- the referenced keys, untouched
  select count(*) into n from pg_constraint
   where convalidated
     and ((conname = 'deals_org_id_id_key'    and conrelid = 'public.deals'::regclass    and pg_get_constraintdef(oid) = 'UNIQUE (org_id, id)')
       or (conname = 'viewings_org_id_id_key' and conrelid = 'public.viewings'::regclass and pg_get_constraintdef(oid) = 'UNIQUE (org_id, id)'));
  if n <> 2 then
    raise exception '0129 aborted: deals_org_id_id_key or viewings_org_id_id_key (0119 / 0120) is missing, not validated, or changed';
  end if;

  -- the keys, exercised: two organisations, each with a deal stage, a deal,
  -- a property and a contact; A's offer, hold, viewing and slip linked to
  -- its own (accepted), then each cross-organisation row in its own
  -- sub-block, refused by ITS key at ITS step. The viewing and slip probes
  -- need a profile to name as the viewing's agent; none exists on an empty
  -- database (CI's and `db reset`'s migration run, before seed.sql), where
  -- they are skipped with a NOTICE (the test file proves those keys there).
  for c in
    select * from (values
      ('offer',          'offers_org_deal_fkey'),
      ('hold-deal',      'reservations_org_deal_fkey'),
      ('hold-offer',     'reservations_org_offer_fkey'),
      ('lead',           'leads_org_converted_deal_fkey'),
      ('viewing',        'viewings_org_deal_fkey'),
      ('slip',           'viewing_slips_org_viewing_fkey'),
      ('slip-on-signed', 'viewing_slips_org_viewing_fkey')  -- B's slip on A's SIGNED viewing: the key, not the unique index
    ) as t(kind, expect)
  loop
    v_ok := null; v_con := null; v_step := 'setup';
    begin
      insert into organizations (name, slug)
        values ('0129 probe A (rolled back)', '0129-probe-a-' || replace(gen_random_uuid()::text, '-', ''))
        returning id into v_org_a;
      insert into organizations (name, slug)
        values ('0129 probe B (rolled back)', '0129-probe-b-' || replace(gen_random_uuid()::text, '-', ''))
        returning id into v_org_b;
      insert into deal_stages (org_id, deal_type, name, sort_order) values (v_org_a, 'sale', '0129 probe', 1) returning id into v_stage_a;
      insert into deal_stages (org_id, deal_type, name, sort_order) values (v_org_b, 'sale', '0129 probe', 1) returning id into v_stage_b;
      insert into deals (org_id, deal_type, stage_id, title) values (v_org_a, 'sale', v_stage_a, '0129 probe A') returning id into v_deal_a;
      insert into deals (org_id, deal_type, stage_id, title) values (v_org_b, 'sale', v_stage_b, '0129 probe B') returning id into v_deal_b;
      insert into properties (org_id, reference, property_type) values (v_org_a, 'ZZZ0129-probe-a', 'apartment') returning id into v_prop_a;
      insert into properties (org_id, reference, property_type) values (v_org_b, 'ZZZ0129-probe-b', 'apartment') returning id into v_prop_b;
      insert into contacts (org_id, first_name) values (v_org_a, '0129 probe A') returning id into v_contact_a;
      insert into contacts (org_id, first_name) values (v_org_b, '0129 probe B') returning id into v_contact_b;
      -- the same-organisation links: all accepted
      v_step := 'own';
      insert into offers (org_id, deal_id, amount) values (v_org_a, v_deal_a, 1) returning id into v_offer_a;
      insert into reservations (org_id, property_id, deal_id, offer_id, expires_at) values (v_org_a, v_prop_a, v_deal_a, v_offer_a, now() + interval '1 day');
      insert into leads (org_id, converted_deal_id) values (v_org_a, v_deal_a);
      insert into leads (org_id) values (v_org_b) returning id into v_lead_b;
      if c.kind in ('viewing', 'slip', 'slip-on-signed') then
        -- any profile id satisfies viewings.agent_id's key (held FOR KEY
        -- SHARE, so it cannot vanish under the probe)
        select id into v_agent from profiles limit 1 for key share;
        if v_agent is null then
          raise exception using errcode = 'P0129', message = 'skip';
        end if;
        insert into viewings (org_id, property_id, contact_id, agent_id, scheduled_at, deal_id)
          values (v_org_a, v_prop_a, v_contact_a, v_agent, now(), v_deal_a)
          returning id into v_viewing_a;
        if c.kind = 'slip-on-signed' then
          insert into viewing_slips (org_id, viewing_id, signer_name, signature_path, signature_sha256)
            values (v_org_a, v_viewing_a, '0129 probe A', 'probe', repeat('0', 64));
        end if;
      end if;
      -- organisation B's row naming organisation A's parent: the
      -- single-column keys accepted each of these
      v_step := 'cross';
      if c.kind = 'offer' then
        insert into offers (org_id, deal_id, amount) values (v_org_b, v_deal_a, 1);
      elsif c.kind = 'hold-deal' then
        insert into reservations (org_id, property_id, deal_id, expires_at) values (v_org_b, v_prop_b, v_deal_a, now() + interval '1 day');
      elsif c.kind = 'hold-offer' then
        insert into reservations (org_id, property_id, offer_id, expires_at) values (v_org_b, v_prop_b, v_offer_a, now() + interval '1 day');
      elsif c.kind = 'lead' then
        update leads set converted_deal_id = v_deal_a where id = v_lead_b;
      elsif c.kind = 'viewing' then
        insert into viewings (org_id, property_id, contact_id, agent_id, scheduled_at, deal_id)
          values (v_org_b, v_prop_b, v_contact_b, v_agent, now(), v_deal_a);
      else
        insert into viewing_slips (org_id, viewing_id, signer_name, signature_path, signature_sha256)
          values (v_org_b, v_viewing_a, '0129 probe B', 'probe', repeat('0', 64));
      end if;
      raise exception using errcode = 'P0130', message = '0129 probe: a cross-organisation row was ACCEPTED';
    exception
      when foreign_key_violation then
        -- refused, and the sub-block's inserts are gone — but only THIS key's
        -- refusal at the cross step is the verdict
        get stacked diagnostics v_con = constraint_name;
        v_ok := (v_con = c.expect and v_step = 'cross');
      when unique_violation then
        -- the 23505-before-23503 oracle this file closes: a verdict, not a crash
        get stacked diagnostics v_con = constraint_name;
        v_ok := false;
      when sqlstate 'P0129' then
        v_ok := null;   -- no profile to name as agent: skipped, nothing written
      when sqlstate 'P0130' then
        v_ok := false;  -- accepted, and the sub-block's inserts are gone too
    end;
    if v_ok is false then
      raise exception '0129 aborted: the % probe was not refused by % at the cross-organisation step (met % at the % step)',
        c.kind, c.expect, coalesce(v_con, 'no foreign-key violation'), v_step;
    end if;
    if v_ok is null then
      v_skipped := v_skipped || c.kind;
    else
      v_verdicts := v_verdicts || c.kind;
    end if;
  end loop;
  raise notice '0129: probes refused by their keys: %', v_verdicts;
  if cardinality(v_skipped) > 0 then
    raise notice '0129: no profile exists — probes skipped: % (the catalogue checks above still ran)', v_skipped;
  end if;

  raise notice '0129: offers, reservations (deal, offer), viewings, converted leads and signed slips tenant-bound to their parent''s organisation';
end $$;
