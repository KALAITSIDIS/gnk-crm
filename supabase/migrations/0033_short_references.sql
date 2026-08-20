-- 0033 - shorten property references: GNK-PAF-0001 becomes PAF0001.
--
-- Operator decision 2026-08-20. District codes are UNCHANGED (PAF, LIM, LAR,
-- NIC, FAM); only the `GNK-` prefix and the hyphens go. Paphos = PAF0001,
-- Limassol = LIM0001, and so on. The prefix has always been chosen automatically
-- from the property's district by next_reference() and still is - an agent never
-- types it.
--
-- WHY NOW AND NOT LATER: doc 02 §A6 says a reference is IMMUTABLE once assigned,
-- and it goes on proposals, share links and documents. With 2 operator test rows
-- the scheme is still a choice; after the first real import it is permanent.
--
-- Unit references follow for free. lib/actions/units.ts builds them as
-- `${parent.reference}-${block}${unit}`, so GNK-PAF-0007-B203 becomes
-- PAF0007-B203 with no code change.

create or replace function next_reference(p_org uuid, p_district_code text) returns text
language plpgsql security definer set search_path = public as $$
declare v int;
begin
  insert into reference_counters(org_id, district_code, last_value)
       values (p_org, p_district_code, 1)
  on conflict (org_id, district_code)
       do update set last_value = reference_counters.last_value + 1
  returning last_value into v;
  -- was: format('GNK-%s-%s', p_district_code, lpad(v::text, 4, '0'))
  return format('%s%s', p_district_code, lpad(v::text, 4, '0'));
end $$;

-- Existing rows. The anchored group keeps the district code and drops only the
-- org prefix and the two hyphens, so a unit suffix survives untouched:
--   GNK-PAF-0001      -> PAF0001
--   GNK-PAF-0007-B203 -> PAF0007-B203
update public.properties
   set reference = regexp_replace(reference, '^GNK-([A-Z]{3})-', '\1')
 where reference ~ '^GNK-[A-Z]{3}-';

-- ⚠️ public.events IS DELIBERATELY NOT TOUCHED. It is hash-chained (prev_hash /
-- hash) and `verify-events-chain` re-walks it nightly, so rewriting a payload
-- would break the chain and raise a tamper alarm. Two existing events mention
-- GNK-PAF-0001 / GNK-PAF-0002 in their payload and they stay that way - that IS
-- what the reference was when the event was recorded. An audit log that edits
-- itself to stay tidy is not an audit log.

do $$
declare
  still_old int;
  bad_shape int;
  counters  int;
begin
  select count(*) into still_old
  from public.properties where reference like 'GNK-%';
  if still_old <> 0 then
    raise exception '0033 aborted: % property reference(s) still carry the GNK- prefix', still_old;
  end if;

  -- Every base reference must now be exactly 3 letters + 4 digits, optionally
  -- followed by a unit suffix.
  select count(*) into bad_shape
  from public.properties
  where reference !~ '^[A-Z]{3}[0-9]{4}(-.+)?$';
  if bad_shape <> 0 then
    raise exception '0033 aborted: % reference(s) do not match CCC0000[-unit]', bad_shape;
  end if;

  -- The counters are keyed on district_code, which this migration does NOT
  -- change, so they must be exactly as they were.
  select count(*) into counters from public.reference_counters;
  raise notice '0033 ok: references shortened, % counter row(s) untouched', counters;
end $$;
