-- =============================================================================
-- 0015 — document_type gains 'evidence_report' (T-audit-reports follow-up)
--
-- DECISIONS T5.2 stored generated commission evidence PDFs as doc_type
-- 'other' and said to extend the enum "if reports multiply" — the /reports
-- generated-reports list needs a queryable type (title-prefix matching is
-- not a key; titles are admin-editable).
--
-- Postgres cannot USE a new enum value inside the transaction that adds it,
-- and the Supabase CLI wraps each migration file in one transaction — so the
-- backfill of existing report rows lives in 0016.
-- =============================================================================

alter type document_type add value if not exists 'evidence_report';
