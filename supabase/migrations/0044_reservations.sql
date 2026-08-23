-- 0044 — reservations: a hold on a property, with an expiry that enforces itself.
--
-- The one true gap in the developer-inventory story (2026-08-23 review). Offers
-- have existed since 0001 with a full state machine; what was missing is the
-- step between an accepted offer and a contract — "B302 is held for the Petrovs
-- until Friday" — which today lives in somebody's head or a WhatsApp thread. A
-- unit held in somebody's head is a unit sold twice.
--
-- THE INVARIANT IS THE PARTIAL UNIQUE INDEX, and it is the whole point of this
-- migration. At most one LIVE reservation per property. It lives in the
-- database rather than in an action because an action can be raced: two agents
-- reserving the same unit in the same second both read "no live reservation"
-- and both write one. An index cannot be raced.
--
-- WHY `restrict` ON property_id: a property with reservation history must not
-- be deletable out from under it. contact_id is nullable and `set null`, so
-- erasing a contact (0017, GDPR Art.17) does not destroy the record that the
-- unit was held — the hold is a fact about the PROPERTY.
--
-- EXPIRY IS SELF-HEALING AND IDEMPOTENT, per what 0012 and 0020 learned the
-- hard way: the sweep selects only rows that are still live AND past their
-- expiry, so a second run in the same night is a no-op by construction rather
-- than by a guard someone has to maintain. Nothing is ever deleted — an expired
-- hold becomes `expired` and keeps its row, because "this was held and lapsed"
-- is exactly what a dispute needs later.
--
-- THE PROPERTY'S OWN `status` IS NOT TOUCHED, deliberately. Auto-flipping a
-- listing to `reserved` on hold and back on expiry couples two entities through
-- a cron job, and the revert is where that class of bug lives. The desk sets
-- the listing status; this table records the hold. A BACKLOG line proposes the
-- sync if the desk actually wants it.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

do $$
begin
  if not exists (select 1 from pg_type where typname = 'reservation_status') then
    create type public.reservation_status as enum
      ('held', 'confirmed', 'expired', 'released', 'converted');
  end if;
end $$;

create table if not exists public.reservations (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id),
  -- restrict: a property with a reservation history is not silently removable
  property_id   uuid not null references public.properties(id) on delete restrict,
  -- the hold survives the buyer's erasure; it is a fact about the property
  contact_id    uuid references public.contacts(id) on delete set null,
  deal_id       uuid references public.deals(id) on delete set null,
  offer_id      uuid references public.offers(id) on delete set null,

  status        public.reservation_status not null default 'held',
  amount        numeric(14,2),
  currency      text not null default 'EUR',

  held_from     timestamptz not null default now(),
  expires_at    timestamptz not null,
  released_at   timestamptz,
  release_reason text,

  notes         text,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- a hold that expires before it starts is always a data-entry slip
  constraint reservation_window_ordered check (expires_at > held_from),
  constraint reservation_amount_non_negative check (amount is null or amount >= 0)
);

-- ===========================================================================
-- THE invariant. `held` and `confirmed` are the live states; a second live
-- reservation on the same property is what selling a unit twice looks like in
-- data. Enforced here rather than in the action because an action can be raced.
-- ===========================================================================
create unique index if not exists reservations_one_live_per_property
  on public.reservations(property_id)
  where status in ('held', 'confirmed');

create index if not exists reservations_property_idx on public.reservations(property_id);
create index if not exists reservations_contact_idx on public.reservations(contact_id);
-- the nightly sweep reads live rows past their expiry, org-wide
create index if not exists reservations_expiry_idx
  on public.reservations(expires_at) where status in ('held', 'confirmed');

alter table public.reservations enable row level security;

-- REVOKE BEFORE GRANT — 0040's rule. Supabase's default privileges fire at
-- CREATE TABLE and `grant` is ADDITIVE, so granting alone leaves anon holding
-- privileges nobody asked for.
revoke all privileges on table public.reservations from anon;
revoke all privileges on table public.reservations from authenticated;

grant select, insert, update, delete on table public.reservations to authenticated;

-- Mirrors `offers`/`deals`: everyone in the org reads and writes, because
-- taking a hold is ordinary agent work. DELETE is admin/listing_manager only —
-- `released` is the way to undo a hold, and a hard delete destroys the record
-- that the property was ever held, which is what a dispute needs.
create policy reservations_select on public.reservations for select
  using (org_id = (select public.current_org_id()));

create policy reservations_insert on public.reservations for insert
  with check (org_id = (select public.current_org_id()));

create policy reservations_update on public.reservations for update
  using (org_id = (select public.current_org_id()))
  with check (org_id = (select public.current_org_id()));

create policy reservations_delete on public.reservations for delete
  using (org_id = (select public.current_org_id())
         and (select public.current_role_gnk()) in ('admin','listing_manager'));

-- 0029 put require_aal2 on every RLS table; a table created AFTER it does not
-- inherit that, and rls_aal2_coverage() exists to catch the omission.
create policy require_aal2 on public.reservations
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));

-- ---------------------------------------------------------------------------
-- Nightly expiry. Same shape as expire_mandates (0001) and the nudge sweep
-- (0020): SECURITY DEFINER, pg_cron only, self-healing, and it writes its own
-- actor-null events because a state change nobody can see did not happen.
--
-- IDEMPOTENT BY CONSTRUCTION, not by a guard: the update selects only rows that
-- are still live, so the second run of a night matches nothing. That is 0006's
-- bug avoided rather than re-fixed.
-- ---------------------------------------------------------------------------
create or replace function public.expire_reservations() returns void
language sql security definer set search_path = public as $$
  with expired as (
    update reservations
       set status = 'expired',
           released_at = now(),
           release_reason = coalesce(release_reason, 'expired automatically'),
           updated_at = now()
     where status in ('held', 'confirmed')
       and expires_at < now()
    returning id, org_id, property_id, contact_id, expires_at
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'property', property_id, 'reservation_expired',
         jsonb_build_object('reservation_id', id,
                            'contact_id', contact_id,
                            'expired_at', expires_at)
    from expired;
$$;

-- 03:45, after expire-mandates (03:00), followup-nudges (03:15) and
-- verify-events-chain (03:30), so a night's runs stay readable in order.
select cron.schedule('expire-reservations', '45 3 * * *', $$select expire_reservations()$$);

do $$
declare
  policies  int;
  uncovered int;
  live_idx  int;
begin
  select count(*) into policies from pg_policies
   where schemaname = 'public' and tablename = 'reservations';
  if policies <> 5 then
    raise exception '0044 aborted: expected 5 policies on reservations (4 + require_aal2), found %', policies;
  end if;

  if has_table_privilege('anon', 'public.reservations', 'select')
     or has_table_privilege('anon', 'public.reservations', 'insert')
     or has_table_privilege('anon', 'public.reservations', 'update')
     or has_table_privilege('anon', 'public.reservations', 'delete') then
    raise exception '0044 aborted: anon still holds a grant on reservations';
  end if;

  if not (has_table_privilege('authenticated', 'public.reservations', 'select')
          and has_table_privilege('authenticated', 'public.reservations', 'insert')
          and has_table_privilege('authenticated', 'public.reservations', 'update')
          and has_table_privilege('authenticated', 'public.reservations', 'delete')) then
    raise exception '0044 aborted: authenticated lost a grant it needs on reservations';
  end if;

  -- rls_aal2_coverage() returns TABLE(missing_table text) — a SET, not an
  -- array. 0043's preamble records why that distinction matters here.
  select count(*) into uncovered from public.rls_aal2_coverage();
  if uncovered <> 0 then
    raise exception '0044 aborted: rls_aal2_coverage() lists % table(s)', uncovered;
  end if;

  -- The invariant must EXIST and must be partial. A plain unique index here
  -- would forbid a property from ever being reserved twice in its life, which
  -- is not the rule — the rule is one LIVE hold at a time.
  select count(*) into live_idx from pg_indexes
   where schemaname = 'public'
     and indexname = 'reservations_one_live_per_property'
     and indexdef ilike '%where%status%';
  if live_idx <> 1 then
    raise exception '0044 aborted: reservations_one_live_per_property is missing or not partial';
  end if;

  if not exists (select 1 from cron.job where jobname = 'expire-reservations') then
    raise exception '0044 aborted: expire-reservations cron job was not scheduled';
  end if;
end $$;

comment on table public.reservations is
  '0044. A hold on a property between accepted offer and contract. At most one '
  'LIVE hold per property, enforced by the partial unique index — an action can '
  'be raced, an index cannot. Expiry is nightly, self-healing and idempotent; '
  'nothing is deleted, because "held and lapsed" is what a dispute needs.';
