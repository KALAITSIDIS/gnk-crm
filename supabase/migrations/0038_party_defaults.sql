-- 0038 — a party's standard terms, so choosing them fills the form.
--
-- The operator's opening request for this whole audit: "when inserting a
-- developer's property or mandate, don't complete all the details each time —
-- just choose him and have it completed automatically."
--
-- Findings 1, 2 and 12 made the party choosable. This is what makes choosing
-- them WORTH something: the terms a developer or owner always works on, stored
-- once against the contact instead of retyped per property and per mandate.
--
-- jsonb rather than columns, matching what `contacts` already does for
-- `preferences`, `kyc` and `banking_readiness`. The shape is validated in the
-- application (one Zod schema, one place), and a set of terms is read and
-- written whole — never queried by an individual key — so columns would buy
-- nothing and cost a migration every time the desk wants another default.
--
-- OFFICE FALLBACK IN `cyprus_config`, not a second jsonb somewhere. That table
-- already exists for exactly this class of value and already carries
-- `verified_at` and `source_note` — the right shape for a number somebody has
-- to stand behind, which "our standard commission is 3%" certainly is. The
-- resolution order is unit ← project ← party ← office, most specific wins.
--
-- EVERY RESOLVED VALUE IS A SUGGESTION, NOT A LOCK. The forms prefill and stay
-- editable. A default that cannot be overridden is a constraint pretending to
-- be a convenience.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

alter table public.contacts
  add column if not exists party_defaults jsonb not null default '{}';

comment on column public.contacts.party_defaults is
  'Standard terms for this owner/developer: commission, mandate type and length, '
  'VAT and legal status, usual district. Prefills the create wizard and the '
  'mandate dialog; every value stays editable. Shape validated in '
  'lib/validators/party-defaults.ts. See 0038.';

-- The office-wide fallback, used when the party has no answer of its own.
-- Deliberately conservative: `open` rather than `exclusive`, because assuming
-- the stronger mandate on a form somebody may not read closely is the wrong way
-- for a default to be wrong.
insert into public.cyprus_config (key, value, description, source_note)
values (
  'default_mandate_terms',
  '{"commission_pct": 3, "mandate_type": "open", "mandate_months": 6, "renewal_reminder_days": 30}'::jsonb,
  'Office-standard mandate terms. Used when the owner or developer has no party_defaults of their own. Every value is a prefill and stays editable.',
  'Operator decision — confirm against the desk''s actual standard terms and set verified_at.'
)
on conflict (key) do nothing;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'contacts'
       and column_name = 'party_defaults'
  ) then
    raise exception '0038 aborted: party_defaults was not added';
  end if;

  if not exists (select 1 from public.cyprus_config where key = 'default_mandate_terms') then
    raise exception '0038 aborted: default_mandate_terms was not seeded';
  end if;

  -- the fallback is only useful if it parses as the shape the app expects
  if (select value->>'commission_pct' from public.cyprus_config
       where key = 'default_mandate_terms') is null then
    raise exception '0038 aborted: default_mandate_terms has no commission_pct';
  end if;

  raise notice '0038 ok: party_defaults added, office fallback seeded';
end $$;
