-- availability-project-teardown.sql — remove the demo project and everything
-- that hangs off it. Build script: scripts/demo/availability-project.sql
--
-- Run this before rebuilding — the build script refuses to make a second one.
--
-- ORDER IS NOT OPTIONAL, and this is the whole reason the teardown is a script
-- rather than a one-liner. Three constraints fight a naive `delete from
-- properties`:
--
--   1. `properties.parent_id` is ON DELETE RESTRICT (0001). Units before
--      phases, phases before the project. Deleting the project first fails.
--   2. `share_link_properties.property_id` has no ON DELETE clause, so it too
--      blocks the delete. The join rows must go first.
--   3. `share_links.price_list_id` is ON DELETE RESTRICT (0041), deliberately:
--      a price list somebody was actually quoted must not vanish from under a
--      live link. So any link pinned to this project's price list has to be
--      removed on purpose, not cascaded past.
--
-- **EVENTS ARE NOT DELETED, AND THAT IS CORRECT.** `events` has no FK to
-- properties and is append-only by design. Production holding events whose row
-- is gone is the same shape as the B3/B7 seed rows in HANDOFF §0 — evidence
-- that something existed and was retired. Nobody should "fix" it.
--
-- THE REFERENCE IS NOT GIVEN BACK. `reference_counters` is not rewound, so the
-- next Paphos listing takes the following number and the gap is permanent. A
-- reference means one thing forever (0033); reusing one would be worse than a
-- gap.
--
-- LIVE LINKS DIE WITH IT. Any share link pointing at this project is deleted,
-- including one that is still live — a link to a deleted project resolves to
-- nothing anyway, and the token is not recoverable. If you want the link to
-- outlive the demo, do not run this.
--
-- Same invocation as the build script; see its header.

begin;

-- Everything under the demo project, at any depth, resolved ONCE so the
-- statements below cannot disagree with each other as rows disappear.
create temporary table doomed on commit drop as
select p.id, p.kind::text as kind, p.reference
  from properties p
  left join properties par on par.id = p.parent_id
  left join properties gp  on gp.id  = par.parent_id
 where coalesce(gp.title ->> 'en', par.title ->> 'en', p.title ->> 'en')
       = 'Kissonerga Bay Residences';

do $$
begin
  if (select count(*) from doomed) = 0 then
    raise exception 'no demo project found — nothing to tear down';
  end if;
end $$;

-- (2) the join rows, and then the links themselves — a link whose only
-- property is gone is a husk that resolves to an empty page.
delete from share_link_properties
 where share_link_id in (
   select share_link_id from share_link_properties where property_id in (select id from doomed));

-- (3) links pinned to this project's price list, plus any the demo minted
delete from share_links
 where price_list_id in (select id from price_lists where project_id in (select id from doomed))
    or title like 'Kissonerga Bay Residences%';

delete from price_list_items
 where price_list_id in (select id from price_lists where project_id in (select id from doomed));

delete from price_lists where project_id in (select id from doomed);

-- (1) children before parents
delete from properties where id in (select id from doomed where kind = 'unit');
delete from properties where id in (select id from doomed where kind = 'phase');
delete from properties where id in (select id from doomed where kind = 'project');

commit;

-- Prove it: nothing left, no dangling join rows, the events kept, chain intact.
select
  (select count(*) from properties
    where title ->> 'en' = 'Kissonerga Bay Residences')                          as project_rows_left,
  (select count(*) from price_lists pl
     left join properties p on p.id = pl.project_id where p.id is null)          as orphaned_price_lists,
  (select count(*) from share_link_properties slp
     left join properties p on p.id = slp.property_id where p.id is null)        as orphaned_join_rows,
  (select count(*) from events where payload ->> 'fixture' = 'availability-demo') as events_kept,
  (select verify_events_chain(id) from organizations where slug = 'gnk')          as chain_ok;
