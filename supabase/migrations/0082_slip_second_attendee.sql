-- 0082 — VIEW-2: a second attendee on the viewing slip.
--
-- Viewings routinely have two attendees (a couple, a parent, a translator)
-- and the slip — the commission evidence — could only name one. The second
-- name is captured AT SIGNING TIME or never: slips are immutable by design
-- (no UPDATE grant since 0002), so there is no add-it-later flow, which is
-- the point — evidence does not get edited after the fact.
--
-- Nullable, no default, NO BACKFILL: pre-existing slips honestly did not
-- record a second attendee (0026's pdf_sha256 rationale, verbatim). The
-- value also rides the viewing_slip_signed event payload — a column alone
-- is forgeable; the hash-chained copy is the integrity claim (0026's
-- stated principle).
--
-- Additive on every axis — hosted BEFORE the merge.
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

alter table public.viewing_slips
  add column if not exists second_attendee_name text;

comment on column public.viewing_slips.second_attendee_name is
  'Optional second attendee named on the signed slip (VIEW-2). Captured at '
  'signing time only — slips are immutable. Null on every slip signed '
  'before 0082: those viewings honestly did not record one.';

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'viewing_slips'
       and column_name = 'second_attendee_name'
  ) then
    raise exception '0082 aborted: second_attendee_name did not land';
  end if;
  raise notice '0082: viewing_slips.second_attendee_name live (nullable, no backfill)';
end $$;
