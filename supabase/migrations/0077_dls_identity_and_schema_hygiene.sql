-- 0077 — the plot gets its legal identity, and the 0001-era debt is settled
-- in one deliberate pass (audit 2026-08-29: DB-05, DB-08, DB-09, DB-10).
--
-- 1. DB-05 — Cyprus DLS identifiers on properties: registration_no, plot_no,
--    sheet_plan, registry_municipality. The same plot listed twice under
--    different owners (the classic open-mandate duplicate) was undetectable —
--    the duplicate warning is address-based, and unaddressed land is exactly
--    where duplicates live. Four nullable text columns + a plain (NOT unique
--    — the app warns, never blocks, the address-check doctrine) partial index.
--    The public feed is an allowlist (0066/0073), so these are withheld from
--    it automatically — correct: they identify the owner's parcel.
--
-- 2. DB-08 — covering indexes for the FK columns with PROVEN hot read paths.
--    BACKLOG's recorded stance ("indexing one while three siblings stay bare
--    would be noise … the whole class is what wants a decision") was written
--    to stop piecemeal drive-by indexing; THIS migration is that class
--    decision, taken once, with the audit's read-path evidence per index.
--    The integrity-only tail is deliberately NOT indexed and named below, so
--    the next advisor run reads as a decision, not an oversight:
--    viewings.deal_id/agent_id, tasks.contact_id/property_id/deal_id (beyond
--    the partial kind-indexes), leads.contact_id/property_id/
--    converted_deal_id/assigned_agent_id, properties.area_id/
--    assigned_agent_id, mandates.owner_contact_id/signed_document_id,
--    reservations.deal_id/offer_id/payment_plan_id, payment_plans.project_id,
--    documents.uploaded_by, and every created_by — no hot path reads them
--    bare, and every table currently holds tens of rows.
--
-- 3. DB-09 — value CHECKs on the 0001-era money columns. The app validators
--    guard the UI paths, but the service-role importer accepts any finite
--    number (scripts/import/_shared.mts num()) — and a negative import price
--    flows into the pricing floor unchallenged. A CHECK binds service_role
--    too (0072's lesson). Validated IMMEDIATELY, never NOT VALID (0026
--    refused a constraint "carried as NOT VALID forever"); each is preceded
--    by a count of offenders that aborts NAMING the number, the 0072 shape.
--
-- 4. DB-10 — email dedup parity with phone: a partial unique index on
--    (org_id, lower(email)) for active contacts. The app's check-then-act
--    dedup has a race the phone index closes and the email path did not;
--    lower() because the DB never normalised case (the validator does, but
--    hand-edited and imported rows predate it). Archived rows are excluded,
--    which is what keeps the merge flow safe (merged duplicates are archived).
--
-- All additive — hosted BEFORE the merge. RLS test 52 covers the live
-- refusals unconditionally (the 0050 division of labour: migration probes
-- skip on empty databases; the suite never skips).
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

-- ---------- 1. DLS identity (DB-05) -----------------------------------------

alter table public.properties
  add column if not exists registration_no       text,
  add column if not exists plot_no               text,
  add column if not exists sheet_plan            text,
  add column if not exists registry_municipality text;

comment on column public.properties.registration_no is
  'DLS land-registry registration number. The strongest duplicate signal the '
  'desk can enter — the entry-time warning matches on it (warn, never block). '
  'Internal only: the public_listings allowlist withholds it by construction.';
comment on column public.properties.plot_no is
  'DLS plot number, as printed on the title deed.';
comment on column public.properties.sheet_plan is
  'DLS sheet/plan reference (e.g. 51/29W2).';
comment on column public.properties.registry_municipality is
  'Municipality/community as the land registry records it — often not the '
  'marketing area name.';

create index if not exists properties_registration_idx
  on public.properties (org_id, registration_no)
  where registration_no is not null;

-- ---------- 2. FK covering indexes (DB-08) ----------------------------------

-- each line names the hot path that earns it
create index if not exists offers_deal_idx            on public.offers (deal_id);            -- deal page offer list; markDealWon accepted-offer lookup
create index if not exists offers_contact_idx         on public.offers (contact_id);         -- contact merge repoint
create index if not exists viewings_property_idx      on public.viewings (property_id);      -- property page viewings card; WF-6 property clash pass
create index if not exists viewings_contact_idx       on public.viewings (contact_id);       -- evidence report; merge repoint; WF-6 contact clash pass
create index if not exists price_history_property_idx on public.price_history (property_id); -- property page price history
create index if not exists property_keys_property_idx on public.property_keys (property_id); -- property page keys card
create index if not exists key_movements_key_idx      on public.key_movements (key_id);      -- keys page movement history
create index if not exists deals_property_idx         on public.deals (property_id);         -- evidence report; health-score recompute by property
create index if not exists deals_buyer_contact_idx    on public.deals (buyer_contact_id);    -- contact page deals tab (.or)
create index if not exists deals_seller_contact_idx   on public.deals (seller_contact_id);   -- contact page deals tab (.or)
create index if not exists properties_owner_contact_idx     on public.properties (owner_contact_id);     -- contact page portfolio (.or)
create index if not exists properties_developer_contact_idx on public.properties (developer_contact_id); -- contact page portfolio (.or)
create index if not exists contacts_merged_into_idx   on public.contacts (merged_into_id)
  where merged_into_id is not null;                                                          -- contact page merged-into banner

-- ---------- 3. value CHECKs (DB-09) -----------------------------------------

do $$
declare
  n int;
begin
  select count(*) into n from public.offers where amount < 0;
  if n > 0 then raise exception '0077 aborted: % offer(s) with a negative amount — repair first', n; end if;
  select count(*) into n from public.mandates
   where commission_pct is not null and (commission_pct < 0 or commission_pct > 100);
  if n > 0 then raise exception '0077 aborted: % mandate(s) with commission_pct outside 0-100 — repair first', n; end if;
  select count(*) into n from public.properties
   where coalesce(asking_price, 0) < 0 or coalesce(min_acceptable_price, 0) < 0
      or coalesce(owner_net_price, 0) < 0 or coalesce(rent_price_month, 0) < 0;
  if n > 0 then raise exception '0077 aborted: % propert(ies) with a negative price — repair first', n; end if;
  select count(*) into n from public.deals where expected_value < 0;
  if n > 0 then raise exception '0077 aborted: % deal(s) with a negative expected_value — repair first', n; end if;
  select count(*) into n from public.price_list_items where list_price < 0;
  if n > 0 then raise exception '0077 aborted: % price list item(s) with a negative list_price — repair first', n; end if;
end $$;

-- Re-run guard added 2026-09-01 (post-audit review): drop-if-exists before
-- each add, the 0045/0049/0054 idiom. INERT on first run; makes a replay
-- (restore-path db push against an already-migrated DB) a no-op instead of
-- a 42710 abort. The assertion block below re-proves the constraint exists.
alter table public.offers
  drop constraint if exists offers_amount_non_negative;
alter table public.offers
  add constraint offers_amount_non_negative check (amount >= 0);
alter table public.mandates
  drop constraint if exists mandates_commission_pct_range;
alter table public.mandates
  add constraint mandates_commission_pct_range
  check (commission_pct is null or (commission_pct >= 0 and commission_pct <= 100));
alter table public.properties
  drop constraint if exists properties_asking_price_non_negative,
  drop constraint if exists properties_min_acceptable_price_non_negative,
  drop constraint if exists properties_owner_net_price_non_negative,
  drop constraint if exists properties_rent_price_month_non_negative;
alter table public.properties
  add constraint properties_asking_price_non_negative
  check (asking_price is null or asking_price >= 0),
  add constraint properties_min_acceptable_price_non_negative
  check (min_acceptable_price is null or min_acceptable_price >= 0),
  add constraint properties_owner_net_price_non_negative
  check (owner_net_price is null or owner_net_price >= 0),
  add constraint properties_rent_price_month_non_negative
  check (rent_price_month is null or rent_price_month >= 0);
alter table public.deals
  drop constraint if exists deals_expected_value_non_negative;
alter table public.deals
  add constraint deals_expected_value_non_negative
  check (expected_value is null or expected_value >= 0);
alter table public.price_list_items
  drop constraint if exists price_list_items_list_price_non_negative;
alter table public.price_list_items
  add constraint price_list_items_list_price_non_negative check (list_price >= 0);

-- ---------- 4. email unique (DB-10) -----------------------------------------

do $$
declare
  n int;
begin
  select count(*) into n from (
    select org_id, lower(email)
      from public.contacts
     where email is not null and is_archived = false
     group by org_id, lower(email)
    having count(*) > 1
  ) d;
  if n > 0 then
    raise exception '0077 aborted: % active duplicate email group(s) — merge or repair before the unique index', n;
  end if;
end $$;

create unique index if not exists contacts_email_unique
  on public.contacts (org_id, lower(email))
  where email is not null and is_archived = false;

-- ---------- assertions -------------------------------------------------------

do $$
declare
  n int;
begin
  -- the four identity columns landed
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'properties'
     and column_name in ('registration_no', 'plot_no', 'sheet_plan', 'registry_municipality');
  if n <> 4 then
    raise exception '0077 aborted: expected 4 DLS columns, found %', n;
  end if;

  -- every CHECK is in and VALIDATED — never NOT VALID (the 0026 stance)
  select count(*) into n from pg_constraint
   where conname in (
     'offers_amount_non_negative', 'mandates_commission_pct_range',
     'properties_asking_price_non_negative', 'properties_min_acceptable_price_non_negative',
     'properties_owner_net_price_non_negative', 'properties_rent_price_month_non_negative',
     'deals_expected_value_non_negative', 'price_list_items_list_price_non_negative')
     and convalidated;
  if n <> 8 then
    raise exception '0077 aborted: expected 8 validated CHECKs, found %', n;
  end if;

  -- the 13 FK indexes + the registration index + the email unique
  select count(*) into n from pg_indexes
   where schemaname = 'public' and indexname in (
     'offers_deal_idx', 'offers_contact_idx', 'viewings_property_idx', 'viewings_contact_idx',
     'price_history_property_idx', 'property_keys_property_idx', 'key_movements_key_idx',
     'deals_property_idx', 'deals_buyer_contact_idx', 'deals_seller_contact_idx',
     'properties_owner_contact_idx', 'properties_developer_contact_idx',
     'contacts_merged_into_idx', 'properties_registration_idx', 'contacts_email_unique');
  if n <> 15 then
    raise exception '0077 aborted: expected 15 new indexes, found %', n;
  end if;

  -- the email index is genuinely UNIQUE — a plain index here would be the
  -- silent version of not shipping DB-10 at all
  if not exists (
    select 1 from pg_index i
      join pg_class c on c.oid = i.indexrelid
     where c.relname = 'contacts_email_unique' and i.indisunique
  ) then
    raise exception '0077 aborted: contacts_email_unique is not unique';
  end if;

  raise notice '0077: 4 DLS columns, 13 FK indexes (class decision taken), 8 validated value CHECKs, email unique live';
end $$;
