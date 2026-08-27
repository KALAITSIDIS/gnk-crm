-- 0058 — `cyprus_config.vat_property` verified, and the live transitional
-- deadline recorded. Operator confirmed 2026-08-27.
--
-- The row shipped with its own instruction: "Verify against current VAT Law
-- amendment before enabling the Phase 3 wizard." This is that verification.
--
-- ============================================================================
-- EVERY FIGURE ALREADY IN THE ROW WAS CORRECT. NOTHING NUMERIC CHANGES HERE.
--
-- Checked 2026-08-27 against two independent published sources (Michael
-- Kyprianou on the 2026 reform, and PwC Cyprus's guidance on the reduced rate):
--
--   standard_rate            0.19    19% standard rate
--   reduced_rate             0.05    5% reduced rate
--   reduced_area_cap_sqm     130     5% applies to the first 130 m²
--   reduced_value_cap_eur    350000  ...and the first €350,000
--   max_total_area_sqm       190     above this the WHOLE purchase is 19%
--   max_total_value_eur      475000  above this the WHOLE purchase is 19%
--   disability_area_cap_sqm  190     5% on the first 190 m² for a buyer with
--                                    a disability
--
-- So this migration is a stamp plus one genuine addition, not a correction.
-- ============================================================================
--
-- WHAT IS ACTUALLY ADDED, AND WHY IT MATTERS MORE THAN THE STAMP.
--
-- The old note said transitional rules "existed" — past tense, which reads as
-- expired. They are LIVE: relief was extended to 31 DECEMBER 2026 (approved
-- 2026-04-17). Four months from today, a buyer whose permit was issued or
-- applied for by 2023-10-31 can still take 5% on the first 200 m² with NO value
-- cap, which is materially better than the current 130 m² / €350,000 rule.
--
-- A desk that does not know the deadline exists will quote the wrong number to
-- exactly the buyers who had the most to gain, and will keep doing so silently
-- after 2026-12-31 in the other direction.
--
-- THE DISABILITY CAP IS NOT THE SAME 190 AS THE ELIGIBILITY CAP, and having two
-- 190s side by side invites that misreading. `max_total_area_sqm` is a ceiling
-- above which nothing qualifies; `disability_area_cap_sqm` is the extent of the
-- 5% band and applies REGARDLESS of the dwelling's total area. Spelled out in
-- the note rather than left to inference.
--
-- ============================================================================
-- NOT A HAZARDOUS DEPLOY. Config data only — no schema change, and the row
-- still has ZERO code references (grepped 2026-08-27: nothing in app/, lib/ or
-- components/ reads `vat_property`). The standard additive order applies:
-- hosted first, then merge.
--
-- GUARDED ON `verified_at IS NULL`, so it is idempotent and can never overwrite
-- a later correction made through Settings → Cyprus config.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

update public.cyprus_config
   set value = value
             || jsonb_build_object(
                  'transitional', jsonb_build_object(
                    'deadline',   '2026-12-31',
                    'qualifies',  'planning permit issued, or application '
                               || 'submitted, by 2023-10-31',
                    'old_rule',   '5% on the first 200 sqm, no value cap',
                    'extended_on','2026-04-17'
                  ),
                  'note', 'Reduced 5% applies to the first 130 sqm / €350,000; '
                       || 'the excess is 19%. If the dwelling exceeds 190 sqm '
                       || 'OR €475,000 in total, the WHOLE purchase is 19%. '
                       || 'For a buyer with a disability the 5% band is the '
                       || 'first 190 sqm regardless of the total area — that '
                       || '190 is NOT the same limit as max_total_area_sqm. '
                       || 'TRANSITIONAL RULES ARE STILL LIVE until 2026-12-31.'
                ),
       verified_at = date '2026-08-27',
       source_note = 'Operator-confirmed 2026-08-27. Figures checked against '
                  || 'the 2026 amendment (transitional relief extended to '
                  || '2026-12-31, approved 2026-04-17) and PwC Cyprus guidance '
                  || 'on the 5% reduced rate. No figure changed — the row was '
                  || 'already correct; the transitional deadline was added.'
 where key = 'vat_property'
   and verified_at is null;

do $$
declare
  v   jsonb;
  r   jsonb;
  ver date;
begin
  select value, verified_at into v, ver
    from cyprus_config where key = 'vat_property';

  if v is null then
    raise exception '0058 aborted: vat_property is missing';
  end if;

  -- The figures must be UNCHANGED. This migration verifies a row; a migration
  -- that quietly moved a tax rate while claiming to verify it would be the
  -- worst possible outcome here, so assert every one of them.
  if (v ->> 'standard_rate')::numeric <> 0.19 then
    raise exception '0058 aborted: standard_rate moved to %', v ->> 'standard_rate';
  end if;
  if (v ->> 'reduced_rate')::numeric <> 0.05 then
    raise exception '0058 aborted: reduced_rate moved to %', v ->> 'reduced_rate';
  end if;

  r := v -> 'reduced_rules_post_2023';
  if r is null then
    raise exception '0058 aborted: reduced_rules_post_2023 lost';
  end if;
  if (r ->> 'reduced_area_cap_sqm')::int    <> 130
     or (r ->> 'reduced_value_cap_eur')::int <> 350000
     or (r ->> 'max_total_area_sqm')::int    <> 190
     or (r ->> 'max_total_value_eur')::int   <> 475000
     or (r ->> 'disability_area_cap_sqm')::int <> 190 then
    raise exception '0058 aborted: a cap changed: %', r;
  end if;

  -- and the addition must actually be there
  if v -> 'transitional' ->> 'deadline' <> '2026-12-31' then
    raise exception '0058 aborted: transitional deadline not recorded: %', v -> 'transitional';
  end if;

  if ver is null then
    raise exception '0058 aborted: verified_at was not set';
  end if;

  raise notice '0058: vat_property verified % — 19%%/5%%, 130sqm/EUR350k, caps 190sqm/EUR475k, transitional to %',
    ver, v -> 'transitional' ->> 'deadline';
end $$;
