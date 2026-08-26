-- 0055 — drop `contacts.preferences`. Operator decision, 2026-08-26.
--
-- 0043 replaced this column with `buyer_requirements`: one unstructured blob per
-- contact became any number of real saved searches, each matched against
-- listings on its own. 0043 deliberately did NOT drop the column, and said so —
-- "it stays until the requirements backfill is reviewed" — because a blob thrown
-- away is data loss nobody notices.
--
-- ============================================================================
-- THE BACKLOG ENTRY SET A PRECONDITION AND IT IS MET, WITH EVIDENCE.
--
-- "It can go once the conversion has been reviewed against real data — but only
-- after someone confirms nothing in it was lost."
--
-- Measured on production 2026-08-26 before writing this: 2 contacts, both
-- holding `preferences`, and BOTH ARE LITERALLY `{}`. Nothing was ever entered,
-- so nothing is converted and nothing is lost. Locally the same: 0 rows with
-- content.
--
-- BUT A MEASUREMENT IS ABOUT ONE DATABASE AT ONE MOMENT, so it is not what this
-- migration relies on. The guard below re-counts at APPLY time and ABORTS if any
-- row holds anything, on whatever database it runs against. A restored backup, a
-- branch database, or production three weeks from now cannot lose a blob to
-- this file — it will refuse and say how many rows stopped it.
-- ============================================================================
--
-- NOTHING IN THE DATABASE DEPENDS ON THE COLUMN, checked rather than assumed: no
-- function references it, no index, no constraint, no view. The dependents are
-- all in app code and go in the same commit — the Preferences form and its save
-- branch, the legacy blob shown on the saved-searches card, GDPR erasure's field
-- list, the merge rule that moved a blob into an empty primary, and the CSV
-- importer, which now writes a `buyer_requirements` row from the same columns
-- rather than packing them into jsonb.
--
-- IRREVERSIBLE. `alter table ... drop column` takes the data with it. That is
-- the point, and it is why the guard is a hard abort rather than a notice.
--
-- ============================================================================
-- THE DEPLOY ORDER INVERTS FOR THIS ONE, AND HANDOFF'S RULE AS WRITTEN WOULD
-- HAVE BROKEN PRODUCTION.
--
-- The standing rule is "apply the hosted migration BEFORE merging to main",
-- because Vercel deploys on push and code must not arrive ahead of the schema
-- it needs. That is the rule for an ADDITIVE change.
--
-- A DROP is the mirror image. Reads survive — every live query on `contacts`
-- uses `select("*")`, which simply returns one column fewer — but the live code
-- WRITES the column in three places, and an UPDATE naming a dropped column is
-- an error, not a no-op:
--
--   * saveContact(section = "preferences")   -> the form 500s
--   * mergeContacts                          -> a merge into an empty primary 500s
--   * ERASURE                                -> `preferences: {}` is in every patch,
--                                               so ARTICLE 17 ITSELF 500s
--
-- So for this migration the order is: MERGE AND DEPLOY THE CODE FIRST, confirm
-- production is serving it, and only then drop the column. Applied in that
-- order on 2026-08-26.
-- ============================================================================
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

do $$
declare
  n_content int;
  n_total   int;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'contacts'
                    and column_name = 'preferences') then
    raise notice '0055: contacts.preferences is already gone — nothing to do';
    return;
  end if;

  select count(*) into n_total from contacts;
  select count(*) into n_content
    from contacts
   where preferences is not null
     and preferences <> '{}'::jsonb;

  -- THE GUARD. Not a warning: a blob here is a buyer's criteria, and the whole
  -- reason 0043 left this column in place was that losing one silently is the
  -- failure worth preventing.
  if n_content <> 0 then
    raise exception
      '0055 aborted: % of % contact(s) still hold preferences. Convert them to buyer_requirements first — this migration destroys the column and nothing can bring it back.',
      n_content, n_total;
  end if;

  raise notice '0055: % contact(s) checked, 0 hold anything — safe to drop', n_total;
end $$;

alter table public.contacts drop column if exists preferences;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'contacts'
                and column_name = 'preferences') then
    raise exception '0055 aborted: the column is still present after the drop';
  end if;
  raise notice '0055: contacts.preferences dropped';
end $$;
