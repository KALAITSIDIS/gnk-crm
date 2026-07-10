-- =============================================================================
-- 0004_reference_immutable.sql — reference numbers are immutable once assigned
-- (doc 02 §A6). Enforced at DB level for every role including service_role;
-- UI additionally renders the field read-only.
-- =============================================================================

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
