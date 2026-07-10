-- =============================================================================
-- 03_DATABASE_SCHEMA.sql — GN Real Estate OS — Phase 1 authoritative DDL
-- Target: Supabase Postgres (EU). Copy into supabase/migrations/0001_foundations.sql
-- (split if preferred), run `supabase db reset`, fix forward, keep this doc in sync.
-- RLS policies live in doc 04 / migration 0002. Seed data in doc 07 / migration 0003.
-- =============================================================================

-- ---------- extensions ----------
create extension if not exists postgis;
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;
create extension if not exists pg_cron;

-- ---------- enums ----------
create type user_role        as enum ('admin','agent','listing_manager','owner_portal','developer_portal','partner_portal');
create type property_kind    as enum ('standalone','project','phase','unit');
create type property_type    as enum ('apartment','villa','townhouse','house','land','shop','office','building','hotel','warehouse','mixed_use','other');
create type transaction_type as enum ('sale','rent','sale_or_rent');
create type property_status  as enum ('draft','available','reserved','under_offer','sold','rented','withdrawn');
create type visibility_level as enum ('public','private','vip','partner','off_market','coming_soon','archived');
create type title_deed_status as enum ('separate','pending','shared','none','unknown');
create type permit_status    as enum ('full','pending','partial','none','unknown');
create type vat_status       as enum ('new_vat','resale_no_vat','reduced_rate_eligible','unknown');
create type mandate_type     as enum ('exclusive','open','verbal');
create type mandate_status   as enum ('draft','active','expired','terminated');
create type key_status       as enum ('in_office','checked_out','with_owner','lost');
create type key_action       as enum ('checkout','return','transfer','mark_lost');
create type contact_kind     as enum ('person','company');
create type temperature      as enum ('hot','warm','cold','inactive','vip');
create type psychology_profile as enum ('investor','relocation','luxury','retirement','holiday','local_family','other');
create type lead_source      as enum ('website','referral','facebook','instagram','portal','partner','walk_in','whatsapp','telegram','phone','email','other');
create type lead_status      as enum ('new','contacted','qualified','converted','lost','spam');
create type deal_type        as enum ('sale','rental','antiparoxi','advisory');
create type deal_status      as enum ('open','won','lost');
create type viewing_status   as enum ('scheduled','completed','cancelled','no_show');
create type offer_status     as enum ('submitted','countered','accepted','rejected','withdrawn','expired');
create type document_type    as enum ('title_deed','permit','contract','id_document','proof_of_address','source_of_funds','valuation','plan','mandate_agreement','reservation','proposal','photo_original','other');
create type media_kind       as enum ('photo','video','floor_plan','virtual_tour');
create type comm_channel     as enum ('whatsapp','telegram','phone','email','sms','in_person','other');

-- ---------- core: org & profiles ----------
create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  created_at  timestamptz not null default now()
);

create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  org_id      uuid not null references organizations(id),
  role        user_role not null default 'agent',
  full_name   text not null,
  email       text not null,
  phone_e164  text,
  locale      text not null default 'en',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- helper: current user's org (security definer so RLS on profiles doesn't recurse)
create or replace function current_org_id() returns uuid
language sql stable security definer set search_path = public as
$$ select org_id from profiles where id = auth.uid() $$;

create or replace function current_role_gnk() returns user_role
language sql stable security definer set search_path = public as
$$ select role from profiles where id = auth.uid() $$;

-- helper: updated_at
create or replace function set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

-- ---------- geography reference ----------
create table districts (
  id       uuid primary key default gen_random_uuid(),
  org_id   uuid not null references organizations(id),
  code     text not null,                      -- PAF, LIM, LAR, NIC, FAM
  name     jsonb not null,                     -- {"en":"Paphos","el":"Πάφος","ru":"Пафос"}
  sort_order int not null default 0,
  unique (org_id, code)
);

create table areas (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  district_id uuid not null references districts(id) on delete cascade,
  name        jsonb not null,
  unique (org_id, district_id, name)
);

-- ---------- reference sequence per district ----------
create table reference_counters (
  org_id      uuid not null references organizations(id),
  district_code text not null,
  last_value  int not null default 0,
  primary key (org_id, district_code)
);

create or replace function next_reference(p_org uuid, p_district_code text) returns text
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  insert into reference_counters(org_id, district_code, last_value)
       values (p_org, p_district_code, 1)
  on conflict (org_id, district_code)
       do update set last_value = reference_counters.last_value + 1
  returning last_value into v;
  return format('GNK-%s-%s', p_district_code, lpad(v::text, 4, '0'));
end $$;

-- ---------- contacts ----------
create table contacts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  contact_kind  contact_kind not null default 'person',
  first_name    text,
  last_name     text,
  company_name  text,
  display_name  text generated always as (
                  coalesce(nullif(trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), ''), company_name, 'Unnamed')
                ) stored,
  phone_e164    text,
  phone_raw     text,
  additional_phones text[] not null default '{}',
  email         text,
  telegram_username text,
  has_whatsapp  boolean not null default false,
  languages     text[] not null default '{en}',
  nationality   text,
  contact_types text[] not null default '{}',   -- buyer, seller, owner, developer, investor, partner_agent, lawyer, banker, tenant, landlord
  temperature   temperature not null default 'warm',
  source        lead_source,
  source_detail text,
  assigned_agent_id uuid references profiles(id),
  preferred_channel comm_channel,
  psychology    psychology_profile,
  preferences   jsonb not null default '{}',    -- {areas:[], budget_min, budget_max, bedrooms_min, property_types:[], purpose}
  kyc           jsonb not null default '{}',    -- checklist booleans/notes per spec C3
  banking_readiness jsonb not null default '{}',
  consent_marketing boolean not null default false,
  consent_at    timestamptz,
  gdpr_notes    text,
  notes         text,
  is_archived   boolean not null default false,
  merged_into_id uuid references contacts(id),
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint contact_has_name check (first_name is not null or last_name is not null or company_name is not null)
);
create unique index contacts_phone_unique on contacts(org_id, phone_e164) where phone_e164 is not null and is_archived = false;
create index contacts_name_trgm  on contacts using gin (display_name gin_trgm_ops);
create index contacts_email_idx  on contacts(org_id, email);
create trigger contacts_updated before update on contacts for each row execute function set_updated_at();

-- ---------- properties ----------
create table properties (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  reference     text not null,
  parent_id     uuid references properties(id) on delete restrict,
  kind          property_kind not null default 'standalone',
  property_type property_type not null,
  transaction_type transaction_type not null default 'sale',
  status        property_status not null default 'draft',
  visibility    visibility_level not null default 'private',

  title         jsonb not null default '{}',    -- {en,el,ru}
  public_description jsonb not null default '{}',
  short_description  jsonb not null default '{}',
  internal_notes text,

  district_id   uuid references districts(id),
  area_id       uuid references areas(id),
  address       text,
  postal_code   text,
  location      geography(point, 4326),
  sea_distance_m int,
  amenities_notes text,

  currency      text not null default 'EUR',
  asking_price  numeric(14,2),
  min_acceptable_price numeric(14,2),
  owner_net_price numeric(14,2),
  rent_price_month numeric(12,2),
  vat_status    vat_status not null default 'unknown',

  covered_area_sqm numeric(10,2),
  plot_area_sqm    numeric(12,2),
  veranda_sqm      numeric(10,2),
  roof_garden_sqm  numeric(10,2),
  basement_sqm     numeric(10,2),
  bedrooms      int,
  bathrooms     int,
  wc            int,
  parking_spaces int,
  has_storage   boolean,
  floor_number  int,
  total_floors  int,
  year_built    int,
  energy_class  text,
  features      text[] not null default '{}',   -- keys from lib/constants/features.ts

  title_deed_status title_deed_status not null default 'unknown',
  permit_status permit_status not null default 'unknown',
  share_of_land text,
  encumbrances_notes text,

  -- land-specific
  planning_zone_code   text,                    -- e.g. Κα6, Τ1β
  building_density_pct numeric(6,2),
  coverage_ratio_pct   numeric(6,2),
  max_floors           int,
  max_height_m         numeric(6,2),
  road_frontage_m      numeric(8,2),
  water_available      boolean,
  electricity_available boolean,
  constraints_notes    text,

  -- project-level
  construction_status  text,
  delivery_date        date,
  developer_contact_id uuid references contacts(id),

  -- unit-level
  unit_number   text,
  block         text,

  quality_score int not null default 0 check (quality_score between 0 and 100),
  owner_contact_id uuid references contacts(id),
  assigned_agent_id uuid references profiles(id),
  published_at  timestamptz,
  sold_at       timestamptz,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, reference),
  constraint unit_has_parent check (kind <> 'unit' or parent_id is not null),
  constraint phase_has_parent check (kind <> 'phase' or parent_id is not null)
);
create index properties_parent_idx   on properties(parent_id);
create index properties_district_idx on properties(org_id, district_id, status);
create index properties_ref_trgm     on properties using gin (reference gin_trgm_ops);
create index properties_location_gix on properties using gist (location);
create trigger properties_updated before update on properties for each row execute function set_updated_at();

create table property_media (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  property_id uuid not null references properties(id) on delete cascade,
  kind        media_kind not null default 'photo',
  storage_path_original text,                 -- documents bucket (private)
  path_thumb  text, path_card text, path_full text,   -- media bucket (public)
  external_url text,                          -- video / virtual tour links
  width int, height int,
  sort_order  int not null default 0,
  is_cover    boolean not null default false,
  alt         jsonb not null default '{}',
  watermarked boolean not null default false,
  exif_stripped boolean not null default true,
  created_by  uuid references profiles(id),
  created_at  timestamptz not null default now()
);
create index property_media_prop_idx on property_media(property_id, sort_order);

create table price_history (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  property_id uuid not null references properties(id) on delete cascade,
  old_price   numeric(14,2),
  new_price   numeric(14,2),
  changed_by  uuid,
  changed_at  timestamptz not null default now(),
  note        text
);

create or replace function trg_price_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.asking_price is distinct from old.asking_price then
    insert into price_history(org_id, property_id, old_price, new_price, changed_by)
    values (new.org_id, new.id, old.asking_price, new.asking_price, auth.uid());
  end if;
  return new;
end $$;
create trigger properties_price_history after update on properties
  for each row execute function trg_price_history();

-- project pricing (versioned)
create table price_lists (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  project_id uuid not null references properties(id) on delete cascade,
  version int not null,
  effective_date date not null default current_date,
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  unique (project_id, version)
);
create table price_list_items (
  price_list_id uuid not null references price_lists(id) on delete cascade,
  unit_id       uuid not null references properties(id) on delete cascade,
  list_price    numeric(14,2) not null,
  primary key (price_list_id, unit_id)
);
create table payment_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  project_id uuid not null references properties(id) on delete cascade,
  name text not null,
  installments jsonb not null default '[]',    -- [{label, pct, due}]
  created_at timestamptz not null default now()
);

-- ---------- mandates & keys ----------
create table mandates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  property_id uuid not null references properties(id) on delete cascade,
  owner_contact_id uuid references contacts(id),
  type mandate_type not null,
  status mandate_status not null default 'draft',
  commission_pct numeric(5,2),
  commission_notes text,
  start_date date not null default current_date,
  expiry_date date,
  renewal_reminder_days int not null default 30,
  signed_document_id uuid,
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index mandates_prop_idx on mandates(property_id, status);
create trigger mandates_updated before update on mandates for each row execute function set_updated_at();

create table property_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  property_id uuid not null references properties(id) on delete cascade,
  key_code text not null,
  description text,
  status key_status not null default 'in_office',
  current_holder_profile_id uuid references profiles(id),
  current_holder_name text,
  created_at timestamptz not null default now()
);
create table key_movements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  key_id uuid not null references property_keys(id) on delete cascade,
  action key_action not null,
  holder_profile_id uuid references profiles(id),
  holder_name text,
  occurred_at timestamptz not null default now(),
  note text,
  created_by uuid references profiles(id)
);

-- ---------- leads ----------
create table leads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  contact_id uuid references contacts(id),
  property_id uuid references properties(id),
  criteria jsonb not null default '{}',
  source lead_source not null default 'other',
  channel comm_channel,
  message text,
  status lead_status not null default 'new',
  received_at timestamptz not null default now(),
  first_response_at timestamptz,
  first_call_at timestamptz,
  assigned_agent_id uuid references profiles(id),
  converted_deal_id uuid,
  lost_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index leads_status_idx on leads(org_id, status, received_at desc);
create trigger leads_updated before update on leads for each row execute function set_updated_at();

-- ---------- deals & pipeline ----------
create table deal_stages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  deal_type deal_type not null,
  name text not null,
  sort_order int not null,
  is_won boolean not null default false,
  is_lost boolean not null default false,
  unique (org_id, deal_type, sort_order)
);

create table deals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  deal_type deal_type not null default 'sale',
  stage_id uuid not null references deal_stages(id),
  title text not null,
  property_id uuid references properties(id),
  buyer_contact_id uuid references contacts(id),
  seller_contact_id uuid references contacts(id),
  agent_id uuid references profiles(id),
  expected_value numeric(14,2),
  commission_split_notes text,                -- MANUAL by design (doc 01 guardrail)
  health jsonb not null default '{}',         -- {budget_confirmed:boolean,...}
  health_score int not null default 0,
  status deal_status not null default 'open',
  won_at timestamptz, lost_at timestamptz, lost_reason text,
  last_activity_at timestamptz not null default now(),
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index deals_stage_idx on deals(org_id, deal_type, stage_id) where status = 'open';
create trigger deals_updated before update on deals for each row execute function set_updated_at();
alter table leads add constraint leads_converted_fk foreign key (converted_deal_id) references deals(id);

create table offers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  deal_id uuid not null references deals(id) on delete cascade,
  property_id uuid references properties(id),
  contact_id uuid references contacts(id),
  amount numeric(14,2) not null,
  terms text,
  status offer_status not null default 'submitted',
  valid_until date,
  decided_at timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

-- ---------- viewings & slips ----------
create table viewings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  property_id uuid not null references properties(id),
  deal_id uuid references deals(id),
  contact_id uuid not null references contacts(id),
  agent_id uuid not null references profiles(id),
  scheduled_at timestamptz not null,
  duration_min int not null default 30,
  status viewing_status not null default 'scheduled',
  route_date date,
  route_order int,
  feedback jsonb,                              -- {rating, liked, disliked, comment}
  owner_notified boolean not null default false,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index viewings_cal_idx on viewings(org_id, scheduled_at);
create trigger viewings_updated before update on viewings for each row execute function set_updated_at();

create table viewing_slips (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  viewing_id uuid not null unique references viewings(id) on delete cascade,
  signer_name text not null,
  signed_at timestamptz not null default now(),
  signature_path text not null,               -- signatures bucket
  signature_sha256 text not null,
  geolocation geography(point,4326),
  pdf_path text,
  created_by uuid references profiles(id)
);

-- ---------- documents ----------
create table documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  entity_type text not null check (entity_type in ('property','contact','deal','mandate','viewing','organization')),
  entity_id uuid not null,
  doc_type document_type not null default 'other',
  title text not null,
  storage_path text not null,                 -- documents bucket (private)
  visibility text not null default 'internal' check (visibility in ('internal','admin_only')),
  uploaded_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index documents_entity_idx on documents(org_id, entity_type, entity_id);
alter table mandates add constraint mandates_signed_doc_fk foreign key (signed_document_id) references documents(id);

-- ---------- tasks ----------
create table tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  title text not null,
  due_at timestamptz,
  assignee_id uuid references profiles(id),
  contact_id uuid references contacts(id),
  deal_id uuid references deals(id),
  property_id uuid references properties(id),
  is_done boolean not null default false,
  done_at timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index tasks_assignee_idx on tasks(org_id, assignee_id, is_done, due_at);

-- ---------- cyprus config ----------
create table cyprus_config (
  key text primary key,
  value jsonb not null,
  description text,
  verified_at date,
  source_note text,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

-- ---------- EVENTS: append-only spine ----------
create table events (
  id bigint generated always as identity primary key,
  org_id uuid not null references organizations(id),
  occurred_at timestamptz not null default now(),
  actor_id uuid,                               -- profiles.id or null = system
  entity_type text not null,                   -- 'property','contact','lead','deal','viewing','offer','mandate','key','config','user',...
  entity_id uuid,
  event_type text not null,                    -- 'created','updated','stage_changed','price_changed','viewing_slip_signed','key_checkout',...
  payload jsonb not null default '{}',
  prev_hash text,
  hash text
);
create index events_entity_idx on events(org_id, entity_type, entity_id, occurred_at);
create index events_time_idx   on events(org_id, occurred_at desc);

create or replace function trg_events_hash() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare p text;
begin
  select hash into p from events where org_id = new.org_id order by id desc limit 1;
  new.prev_hash := p;
  new.hash := encode(digest(
    coalesce(p,'') || new.org_id::text || coalesce(new.actor_id::text,'') ||
    new.entity_type || coalesce(new.entity_id::text,'') || new.event_type ||
    new.payload::text || new.occurred_at::text, 'sha256'), 'hex');
  return new;
end $$;
create trigger events_hash before insert on events for each row execute function trg_events_hash();

create or replace function verify_events_chain(p_org uuid) returns boolean
language plpgsql stable security definer set search_path = public, extensions as $$
declare r record; prev text := null;
begin
  for r in select * from events where org_id = p_org order by id loop
    if r.prev_hash is distinct from prev then return false; end if;
    if r.hash <> encode(digest(
      coalesce(prev,'') || r.org_id::text || coalesce(r.actor_id::text,'') ||
      r.entity_type || coalesce(r.entity_id::text,'') || r.event_type ||
      r.payload::text || r.occurred_at::text,'sha256'),'hex') then return false; end if;
    prev := r.hash;
  end loop;
  return true;
end $$;

-- Immutability: no update/delete for anyone (RLS adds insert/select rules in doc 04)
revoke update, delete, truncate on events from anon, authenticated;

-- ---------- mandate auto-expiry (pg_cron, daily 03:00) ----------
create or replace function expire_mandates() returns void
language sql security definer set search_path = public as $$
  update mandates set status = 'expired'
  where status = 'active' and expiry_date is not null and expiry_date < current_date;
$$;
select cron.schedule('expire-mandates','0 3 * * *', $$select expire_mandates()$$);

-- ---------- storage buckets ----------
insert into storage.buckets (id, name, public) values
  ('media','media', true),
  ('documents','documents', false),
  ('signatures','signatures', false)
on conflict (id) do nothing;

-- ---------- enable RLS everywhere (policies in doc 04) ----------
alter table organizations enable row level security;
alter table profiles enable row level security;
alter table districts enable row level security;
alter table areas enable row level security;
alter table reference_counters enable row level security;
alter table contacts enable row level security;
alter table properties enable row level security;
alter table property_media enable row level security;
alter table price_history enable row level security;
alter table price_lists enable row level security;
alter table price_list_items enable row level security;
alter table payment_plans enable row level security;
alter table mandates enable row level security;
alter table property_keys enable row level security;
alter table key_movements enable row level security;
alter table leads enable row level security;
alter table deal_stages enable row level security;
alter table deals enable row level security;
alter table offers enable row level security;
alter table viewings enable row level security;
alter table viewing_slips enable row level security;
alter table documents enable row level security;
alter table tasks enable row level security;
alter table cyprus_config enable row level security;
alter table events enable row level security;

-- ---------- reference immutability (added T1.2, migration 0004) ----------
create or replace function protect_property_reference() returns trigger
language plpgsql as $$
begin
  if new.reference is distinct from old.reference then
    raise exception 'property reference is immutable once assigned';
  end if;
  return new;
end $$;
create trigger properties_reference_immutable before update on properties
  for each row execute function protect_property_reference();
