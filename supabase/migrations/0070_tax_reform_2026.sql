-- 0070 — the 2026 tax reform reaches the two config rows it changed.
-- Stamp duty ABOLISHED for new contracts; CGT lifetime exemptions TRIPLED.
--
-- Both rows shipped with their own instruction ("Verify bands and cap against
-- current Stamp Duty Law" / "Verify exemption figures and conditions") and
-- were never verified. The 2026-08-29 audit checked them against the Official
-- Gazette and both are now WRONG, because the 31.12.2025 reform package
-- (in force 1.1.2026) changed the law under them:
--
--   Law 239(I)/2025 (gazette No. 5070, 31.12.2025, read in full):
--     "Οι περί Χαρτοσήμων Νόμοι του 1963 έως 2024 καταργούνται την
--      1η Ιανουαρίου 2026" — the Stamp Duty Laws are REPEALED for documents
--     signed on or after 2026-01-01, with no immovable-property carve-out.
--     The seeded bands (0 / 0.15% / 0.20%, cap €20,000) remain correct ONLY
--     for contracts signed on or before 2025-12-31, so they are KEPT, and an
--     `abolished` block is added that the calculator renders instead of a
--     figure. Deleting the bands would falsify pre-2026 contracts.
--
--   Law 242(I)/2025 (same gazette, ss.3, 6, 9, read in full):
--     CGT lifetime exemptions raised from €17,086 / €25,629 / €85,430 to
--     €30,000 (general) / €50,000 (agricultural, farmer) / €150,000 (primary
--     residence), with primary-residence tax charged only on the gain
--     EXCEEDING €150,000. The 20% rate is unchanged. s.6 expressly treats
--     antiparoxi (land-for-units exchange) as a CGT exchange with a 5-year
--     completion condition — recorded in the note because this desk runs an
--     antiparoxi pipeline. No code computes from this row (audit-confirmed:
--     zero references outside the seed); it misinformed rather than
--     miscalculated, but it misinformed in euros.
--
-- ============================================================================
-- NOT A HAZARDOUS DEPLOY. Config data only — no schema change. Pre-0070 code
-- reading the stamp row simply ignores the new `abolished` key and keeps the
-- old (wrong) quote until the paired UI change deploys; post-0070 UI without
-- the row falls back to computing, so either order is safe. Standard additive
-- order applies regardless: hosted first, then merge (HANDOFF §0 rule).
--
-- THE GUARD IS NOT 0056/0058's `verified_at IS NULL`, AND THE DIFFERENCE WAS
-- MEASURED, NOT GUESSED. Hosted's `stamp_duty` row carries verified_at
-- 2026-07-23 with a source_note reading "Stamp Duty Law verified 2026-07-23"
-- — a Settings verification of the pre-2026 bands made SEVEN MONTHS AFTER the
-- statute it verified was repealed (checked on hosted 2026-08-29: the bands
-- themselves are byte-equal to the seed, only the stamp differs). A null-only
-- guard would skip that row and the assertion block would abort on every
-- apply. So the guard admits any verification dated BEFORE this migration's
-- own (2026-08-29) — an earlier verification is exactly the state this
-- migration corrects — and each UPDATE is idempotent on its own content
-- (`abolished` absent / exemptions not yet 30000). A verification dated ON OR
-- AFTER 2026-08-29 still skips the UPDATE and ABORTS in the assertions:
-- someone re-verified after the gazette check, and a human must reconcile.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

update public.cyprus_config
   set value = value
             || jsonb_build_object(
                  'abolished', jsonb_build_object(
                    'from', '2026-01-01',
                    'law',  'Law 239(I)/2025',
                    'note', 'The Stamp Duty Laws 1963-2024 are repealed for '
                         || 'documents signed on or after 1 January 2026. The '
                         || 'bands above remain correct only for contracts '
                         || 'signed on or before 31 December 2025.'
                  )
                ),
       verified_at = date '2026-08-29',
       source_note = 'Verified 2026-08-29 against Law 239(I)/2025 (gazette '
                  || 'No. 5070, 31.12.2025, cylaw.org/nomoi/arith/'
                  || '2025_1_239.pdf): stamp duty abolished for documents '
                  || 'signed from 2026-01-01. Bands kept for pre-2026 '
                  || 'contracts; the calculator renders the abolition notice '
                  || 'instead of a figure.'
 where key = 'stamp_duty'
   and not coalesce(value ? 'abolished', false)
   and (verified_at is null or verified_at < date '2026-08-29');

update public.cyprus_config
   set value = jsonb_set(
                 jsonb_set(
                   jsonb_set(value,
                     '{lifetime_exemptions_eur,general}',                to_jsonb(30000)),
                     '{lifetime_exemptions_eur,agricultural_land_farmer}', to_jsonb(50000)),
                     '{lifetime_exemptions_eur,primary_residence}',        to_jsonb(150000))
             || jsonb_build_object(
                  'reform_2026_note',
                  'Law 242(I)/2025 (in force 2026-01-01) raised the lifetime '
               || 'exemptions to EUR 30,000 general / 50,000 agricultural '
               || '(farmer) / 150,000 primary residence; for the primary '
               || 'residence, tax is charged only on the gain EXCEEDING '
               || 'EUR 150,000. The 20% rate is unchanged. Its s.6 treats '
               || 'antiparoxi expressly as a CGT exchange with a 5-year '
               || 'completion condition.'
                ),
       verified_at = date '2026-08-29',
       source_note = 'Verified 2026-08-29 against Law 242(I)/2025 (gazette '
                  || 'No. 5070, 31.12.2025, cylaw.org/nomoi/arith/'
                  || '2025_1_242.pdf ss.3, 6, 9): exemptions 30000/50000/'
                  || '150000 from 2026-01-01, rate 0.20 unchanged. No code '
                  || 'computes from this row; it is reference data for '
                  || 'seller conversations until a CGT calculator ships.'
 where key = 'capital_gains_tax'
   and coalesce((value #>> '{lifetime_exemptions_eur,general}')::numeric, 0) <> 30000
   and (verified_at is null or verified_at < date '2026-08-29');

do $$
declare
  v   jsonb;
  ver date;
begin
  -- ---------------------------------------------------------------- stamp --
  select value, verified_at into v, ver
    from cyprus_config where key = 'stamp_duty';

  if v is null then
    raise exception '0070 aborted: stamp_duty is missing';
  end if;

  -- The bands must be UNCHANGED — they are still the law for pre-2026
  -- contracts, and a migration that moved them while claiming to record an
  -- abolition would corrupt exactly the historical quotes it preserves.
  if v -> 'bands' <> '[{"up_to": 5000, "rate": 0},
                       {"up_to": 170000, "rate": 0.0015},
                       {"up_to": null, "rate": 0.002}]'::jsonb then
    raise exception '0070 aborted: stamp_duty bands moved: %', v -> 'bands';
  end if;
  if (v ->> 'cap')::numeric <> 20000 then
    raise exception '0070 aborted: stamp_duty cap moved to %', v ->> 'cap';
  end if;

  -- and the abolition must actually be there, dated to the statute
  if v -> 'abolished' ->> 'from' is distinct from '2026-01-01'
     or v -> 'abolished' ->> 'law' is distinct from 'Law 239(I)/2025' then
    raise exception '0070 aborted: abolition not recorded: %', v -> 'abolished';
  end if;
  if ver is null then
    raise exception '0070 aborted: stamp_duty verified_at was not set — the '
                    'row was already verified with different content; '
                    'reconcile by hand before re-running';
  end if;

  raise notice '0070: stamp_duty verified % — abolished from 2026-01-01 (Law 239(I)/2025), pre-2026 bands preserved', ver;

  -- ------------------------------------------------------------------ CGT --
  select value, verified_at into v, ver
    from cyprus_config where key = 'capital_gains_tax';

  if v is null then
    raise exception '0070 aborted: capital_gains_tax is missing';
  end if;

  if (v ->> 'rate')::numeric <> 0.20 then
    raise exception '0070 aborted: CGT rate moved to % (242(I)/2025 left it at 20%%)', v ->> 'rate';
  end if;
  if (v -> 'lifetime_exemptions_eur' ->> 'general')::int                  <> 30000
     or (v -> 'lifetime_exemptions_eur' ->> 'agricultural_land_farmer')::int <> 50000
     or (v -> 'lifetime_exemptions_eur' ->> 'primary_residence')::int       <> 150000 then
    raise exception '0070 aborted: CGT exemptions wrong: %', v -> 'lifetime_exemptions_eur';
  end if;
  if ver is null then
    raise exception '0070 aborted: capital_gains_tax verified_at was not set — '
                    'the row was already verified with different content; '
                    'reconcile by hand before re-running';
  end if;

  raise notice '0070: capital_gains_tax verified % — exemptions 30000/50000/150000 (Law 242(I)/2025), rate 20%% unchanged', ver;
end $$;
