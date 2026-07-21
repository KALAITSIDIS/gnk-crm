-- 0017 — GDPR Article 17 erasure state on contacts.
--
-- Erasure is a REDACTION, not a delete: event payloads are hash-chained
-- (trg_events_hash covers payload::text) and viewing slips are immutable
-- commission evidence, so neither can be rewritten. Cyprus AML also requires
-- customer due-diligence records to survive 5 years past the end of the
-- business relationship. See docs/superpowers/specs/2026-07-21-gdpr-contact-
-- erasure-design.md and DECISIONS T-contact-erasure.
--
-- No new table: the append-only `contact.erased` event is the audit record.

alter table contacts
  add column if not exists erased_at     timestamptz,
  add column if not exists erased_by     uuid references profiles(id),
  -- null when nothing was retained (no AML relationship existed); otherwise
  -- the date the retained KYC files may be purged
  add column if not exists retention_until date;

comment on column contacts.erased_at is
  'GDPR Art.17 erasure timestamp. Non-null means the profiling layer has been redacted; identity fields and AML records may still be present by law.';
comment on column contacts.retention_until is
  'Date the retained KYC documents may be purged (erasure date + 5y AML duty). Null when no documents were retained.';

-- Erased contacts must never be reachable from marketing/hot-buyer surfaces.
-- The action also forces temperature='inactive'; this index just keeps the
-- "find contacts whose retention has expired" query cheap when that view ships.
create index if not exists contacts_retention_idx
  on contacts (org_id, retention_until)
  where retention_until is not null;
