-- 0026 — the signed slip PDF had no recorded hash anywhere.
--
-- Found during the 2026-08-05 Storage restore drill (BACKUP_RESTORE §4c).
-- `viewing_slips` stored `signature_sha256` for the signature PNG and event 60's
-- payload carried the same value, so a substituted signature IMAGE was
-- detectable. The slip PDF at `pdf_path` had no hash in the row and none in the
-- event, so nothing could prove a restored slip PDF was byte-identical to the
-- one that was signed.
--
-- That is the asymmetry worth naming: evidence reports already carry
-- `pdf_sha256` in their generation event, and that is precisely what made the
-- drill's end-to-end proof possible — a PDF pulled through the app's own
-- Download button re-hashed to the value in the chain. The slip, which is the
-- single strongest commission-dispute artefact this system produces (doc 01 §4),
-- could not be checked the same way.
--
-- The hash also goes into the `viewing_slip_signed` payload, and that is the
-- half that matters most: `events` is hash-chained, so a value recorded there
-- cannot be edited later without breaking `verify_events_chain`. A column alone
-- would be as forgeable as the file.
--
-- NULLABLE, AND DELIBERATELY NOT BACKFILLED. One slip exists in production and
-- its PDF predates this column. Hashing the bytes sitting in Storage today
-- would write an assertion nobody can make — that those are the bytes that were
-- signed — and it would be indistinguishable from a hash recorded at signing
-- time. A null says "unknown", which is true. Forward-looking only is the honest
-- shape for an integrity claim.
--
-- No CHECK tying pdf_sha256 to pdf_path for the same reason: the existing row
-- has a path and no hash, so any such constraint would either fail on it or
-- have to be carried as NOT VALID forever.

alter table viewing_slips add column if not exists pdf_sha256 text;

comment on column viewing_slips.pdf_sha256 is
  'SHA-256 (hex) of the slip PDF at pdf_path, computed at signing time and also '
  'written to the hash-chained viewing_slip_signed event. NULL means the slip '
  'predates 0026 — deliberately not backfilled, because hashing the stored bytes '
  'later cannot assert they are the bytes that were signed.';
