-- 0079 — the VAT transitional deadline gets its CONDITION (audit Phase-4
-- item "VAT transitional note tightening after the Tax Dept circular" —
-- the circular now exists, so the gate lifted).
--
-- ============================================================================
-- EVERY FIGURE ALREADY IN THE ROW IS CORRECT. NOTHING NUMERIC CHANGES HERE.
-- This tightens PROSE that has become misleading by omission.
-- ============================================================================
--
-- WHAT CHANGED IN THE WORLD. 0058 recorded (correctly, at the time): the
-- transitional 5%-on-200-sqm relief is live until 2026-12-31 for anyone whose
-- planning permit was issued, or applied for, by 2023-10-31. Two later facts
-- made that sentence dangerous:
--
--   * Law 109(I)/2026 (approved 2026-04-17, gazetted 2026-04-24, Official
--     Gazette issue 5089) extended the transitional window to 2026-12-31 —
--     CONDITIONALLY.
--   * The Tax Department's announcement of 2026-05-04 spelled the condition
--     out: the 2026-12-31 filing deadline applies ONLY where the building
--     permit was issued after 2025-01-01 or has not yet been issued. Where
--     the building permit was issued by 2024-12-31, the filing deadline was
--     2026-06-15 — WHICH HAS NOW PASSED.
--
-- So our note — "TRANSITIONAL RULES ARE STILL LIVE until 2026-12-31." — is
-- today true for one subset of buyers and false for another, and the panel
-- cannot tell them apart. A buyer whose permit was issued mid-2024 would be
-- told relief is reachable that lapsed in June. The condition goes into the
-- config, and the app renders it (same change, code half).
--
-- Sources checked 2026-08-31: KPMG TaxNewsFlash on the 2026-05-04 Tax
-- Department announcement; Michael Kyprianou on Law 109(I)/2026 (gazette
-- date, issue number, permit-date split). Both agree on every date.
--
-- NOT A HAZARDOUS DEPLOY. Config data only; the current renderer reads only
-- `deadline` and `old_rule` and ignores unknown keys, so either deploy order
-- is safe (0070 precedent). Standard additive order: hosted first.
--
-- GUARDED on the transitional block NOT yet carrying `condition`, so it is
-- idempotent and can never overwrite a later correction made through
-- Settings → Cyprus config.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

update public.cyprus_config
   set value = value
             || jsonb_build_object(
                  'transitional', (value -> 'transitional')
                    || jsonb_build_object(
                         'condition',
                           'the 2026-12-31 deadline applies ONLY where the '
                        || 'building permit was issued after 2025-01-01 or is '
                        || 'not yet issued; where the building permit was '
                        || 'issued by 2024-12-31, the filing deadline was '
                        || '2026-06-15 and has PASSED',
                         'extension_law', '109(I)/2026, gazetted 2026-04-24',
                         'tax_dept_announcement', '2026-05-04'
                       ),
                  'note', 'Reduced 5% applies to the first 130 sqm / €350,000; '
                       || 'the excess is 19%. If the dwelling exceeds 190 sqm '
                       || 'OR €475,000 in total, the WHOLE purchase is 19%. '
                       || 'For a buyer with a disability the 5% band is the '
                       || 'first 190 sqm regardless of the total area — that '
                       || '190 is NOT the same limit as max_total_area_sqm. '
                       || 'TRANSITIONAL RULES: live until 2026-12-31 ONLY '
                       || 'where the building permit was issued after '
                       || '2025-01-01 or is still unissued (Law 109(I)/2026 + '
                       || 'Tax Dept announcement 2026-05-04); for permits '
                       || 'issued by 2024-12-31 the 2026-06-15 deadline has '
                       || 'passed.'
                ),
       verified_at = date '2026-08-31',
       source_note = 'Verified 2026-08-31. Figures unchanged — this tightens '
                  || 'the transitional prose per Law 109(I)/2026 (gazetted '
                  || '2026-04-24) and the Tax Department announcement of '
                  || '2026-05-04: the 2026-12-31 deadline is conditional on '
                  || 'the building-permit issue date; the 2026-06-15 deadline '
                  || 'for permits issued by 2024-12-31 has passed. Previously: '
                  || 'operator-confirmed 2026-08-27 (0058).'
 where key = 'vat_property'
   and value -> 'transitional' ->> 'condition' is null;

do $$
declare
  v   jsonb;
  r   jsonb;
  t   jsonb;
begin
  select value into v from cyprus_config where key = 'vat_property';
  if v is null then
    raise exception '0079 aborted: vat_property is missing';
  end if;

  -- The figures must be UNCHANGED — a migration that moved a tax rate while
  -- claiming to tighten prose would be the worst outcome here (0058's rule).
  if (v ->> 'standard_rate')::numeric <> 0.19
     or (v ->> 'reduced_rate')::numeric <> 0.05 then
    raise exception '0079 aborted: a rate moved';
  end if;
  r := v -> 'reduced_rules_post_2023';
  if (r ->> 'reduced_area_cap_sqm')::int      <> 130
     or (r ->> 'reduced_value_cap_eur')::int  <> 350000
     or (r ->> 'max_total_area_sqm')::int     <> 190
     or (r ->> 'max_total_value_eur')::int    <> 475000
     or (r ->> 'disability_area_cap_sqm')::int <> 190 then
    raise exception '0079 aborted: a cap changed: %', r;
  end if;

  -- the tightening must actually be there, and the block it extends intact
  t := v -> 'transitional';
  if t ->> 'deadline' <> '2026-12-31'
     or t ->> 'old_rule' is null
     or t ->> 'qualifies' is null then
    raise exception '0079 aborted: the 0058 transitional block was damaged: %', t;
  end if;
  if t ->> 'condition' is null
     or position('2026-06-15' in t ->> 'condition') = 0
     or position('2024-12-31' in t ->> 'condition') = 0 then
    raise exception '0079 aborted: the condition was not recorded: %', t;
  end if;
  if position('ONLY' in v ->> 'note') = 0 then
    raise exception '0079 aborted: the note still states the deadline unconditionally';
  end if;

  raise notice '0079: vat_property transitional tightened — 2026-12-31 conditional on permit date, 2026-06-15 lapse recorded; all figures unchanged';
end $$;
