import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0145 to 0144's catalogue — 0145's documented ROLLBACK:
 * the `reservation_installments_keep_paid` trigger and its function dropped.
 * Every drop is `if exists`, so the text is a no-op on a database still at
 * 0144.
 *
 * DROP TRIGGER takes ACCESS EXCLUSIVE, which waits for readers too, so the
 * text takes the lock NOWAIT, retrying for about 5 s (0132's idiom): it never
 * waits while holding a lock, so it cannot deadlock with a session. ONE
 * transaction (it uses `set local`).
 *
 * Used by schedule-paid-guard.test.ts to replay 0145 over 0144 (its preflight
 * and postflight) — always inside a rolled-back transaction. Not a test file:
 * it registers no tests. Never pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

export const MIGRATION_0145 = "0145_paid_instalment_kept.sql";
export const readMigration0145 = () =>
  readFileSync(join(MIGRATIONS, MIGRATION_0145), "utf-8").replace(/\r\n/g, "\n");

export const REVERT_0145_SQL = [
  "set local lock_timeout = '5s';",
  `do $$
declare
  v_try int := 0;
begin
  loop
    begin
      lock table public.reservation_installments in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      v_try := v_try + 1;
      if v_try >= 100 then
        raise exception '0145 rollback: reservation_installments was never free (~5 s) — nothing was changed, apply it again';
      end if;
      perform pg_sleep(0.05);
    end;
  end loop;
end $$;`,
  "drop trigger if exists reservation_installments_keep_paid on public.reservation_installments;",
  "drop function if exists public.trg_installment_paid_kept();",
].join("\n\n");
