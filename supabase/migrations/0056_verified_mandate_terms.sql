-- 0056 — the desk's REAL standard mandate terms, confirmed by the operator.
-- 2026-08-26.
--
-- `cyprus_config.default_mandate_terms` shipped in 0038 as a PLACEHOLDER with
-- its own source_note asking for exactly this: "Operator decision — confirm
-- against the desk's actual standard terms and set verified_at." It sat
-- unverified for five days while `getPartyDefaults` prefilled every new mandate
-- from it.
--
-- ============================================================================
-- WHY THIS ONE ROW MATTERED AND THE OTHER FIVE UNVERIFIED ONES DID NOT.
--
-- An audit on 2026-08-26 found 6 of 8 `cyprus_config` rows had never been
-- verified, which sounded alarming and mostly was not. The calculators read
-- ONLY `transfer_fees` and `stamp_duty` — `calculators/page.tsx` names both in
-- an `.in()` — and those two are the verified, test-pinned pair.
-- `vat_property`, `capital_gains_tax`, `other_property_taxes` and
-- `company_details` have ZERO code references: unverified but inert.
--
-- `default_mandate_terms` was the exception: unverified AND read. Its values
-- land on real contracts through the mandate form's prefill, and since
-- 2026-08-25 its commission also drives the negotiating floor on the pricing
-- panel. A wrong percentage there is a wrong number quoted to an owner.
-- ============================================================================
--
-- WHAT CHANGED: `mandate_type` only, `open` → `exclusive`. The operator
-- confirmed 3% and 6 months, which the placeholder already had.
-- `renewal_reminder_days` was NOT part of what they confirmed, so its 30 is
-- carried over untouched rather than silently re-asserted as verified policy.
--
-- NO BEHAVIOURAL CONSEQUENCE, checked rather than assumed. `exclusive` is not
-- special to the database or the validator: the only uniqueness rule is
-- `mandates_one_active_per_property`, which fires on ANY active mandate
-- whatever its type, and `MANDATE_TYPES` treats all three alike. This changes
-- what a new mandate form is pre-filled with, and nothing else.
--
-- GUARDED ON `verified_at IS NULL`, so it is idempotent and can never clobber a
-- later edit made through Settings → Cyprus config. Once a human has verified
-- this row, this migration stops touching it.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

update public.cyprus_config
   set value = jsonb_build_object(
         'mandate_type',          'exclusive',
         'commission_pct',        3,
         'mandate_months',        6,
         -- not part of what the operator confirmed; preserved as-is
         'renewal_reminder_days', coalesce((value ->> 'renewal_reminder_days')::int, 30)
       ),
       verified_at = date '2026-08-26',
       source_note = 'Confirmed by the operator 2026-08-26: 3% commission, '
                  || 'exclusive, 6 months. Only mandate_type changed from the '
                  || '0038 placeholder (open). renewal_reminder_days was not '
                  || 'part of that confirmation and is carried over unchanged.'
 where key = 'default_mandate_terms'
   and verified_at is null;

do $$
declare
  v jsonb;
  ver date;
begin
  select value, verified_at into v, ver
    from cyprus_config where key = 'default_mandate_terms';

  if v is null then
    raise exception '0056 aborted: default_mandate_terms is missing';
  end if;

  -- The shape `partyDefaultsSchema` parses. A row that fails it makes
  -- getPartyDefaults return null and every mandate form loses its prefill
  -- silently, so assert it rather than trust the jsonb_build_object above.
  if v ->> 'mandate_type' is null
     or v ->> 'commission_pct' is null
     or v ->> 'mandate_months' is null
     or v ->> 'renewal_reminder_days' is null then
    raise exception '0056 aborted: default_mandate_terms lost a key: %', v;
  end if;

  if not (v ->> 'mandate_type' = any (
            select e.enumlabel::text from pg_enum e
              join pg_type t on t.oid = e.enumtypid
             where t.typname = 'mandate_type')) then
    raise exception '0056 aborted: % is not a mandate_type', v ->> 'mandate_type';
  end if;

  if ver is null then
    raise exception '0056 aborted: verified_at was not set';
  end if;

  raise notice '0056: default_mandate_terms verified % — % / %%% / % months',
    ver, v ->> 'mandate_type', v ->> 'commission_pct', v ->> 'mandate_months';
end $$;
