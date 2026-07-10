-- =============================================================================
-- 0005_price_change_event.sql — price changes write price_history AND an event
-- from the same trigger (doc 02 §C1). Trigger-level so direct DB edits and
-- imports are covered too, not just app saves.
-- =============================================================================

create or replace function trg_price_history() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.asking_price is distinct from old.asking_price then
    insert into price_history(org_id, property_id, old_price, new_price, changed_by)
    values (new.org_id, new.id, old.asking_price, new.asking_price, auth.uid());

    insert into events(org_id, actor_id, entity_type, entity_id, event_type, payload)
    values (
      new.org_id, auth.uid(), 'property', new.id, 'price_changed',
      jsonb_build_object(
        'reference', new.reference,
        'from', old.asking_price,
        'to', new.asking_price
      )
    );
  end if;
  return new;
end $$;
