-- 0083 — DB-12: properties.sold_at, dead since day one, goes.
--
-- The column was created in 0001 and nothing ever wrote OR read it: sale
-- dates live in the EVENT LOG (sales-velocity reads `status_changed`/
-- `updated` events — its header explicitly declined a sold_at column, and
-- the 2026-09-01 artifact verification re-proved zero readers repo-wide).
-- A dead column is not free: it sits in `select *` payloads, in the
-- generated types, and in the feed test's withheld-columns pin as a name
-- somebody must keep explaining.
--
-- DESTRUCTIVE — the 0055/0057 order applies: this file merges WITH the code
-- (types regenerated, the withheld pin trimmed) and is applied to hosted
-- ONLY AFTER that merge has deployed. The deployed bundle holds no runtime
-- reference to the column, so either way nothing can 500 — the order is
-- discipline, not necessity.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

alter table public.properties drop column if exists sold_at;

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'properties'
       and column_name = 'sold_at'
  ) then
    raise exception '0083 aborted: sold_at is still there';
  end if;
  raise notice '0083: properties.sold_at dropped — sale dates live in the event log, as they always did';
end $$;
