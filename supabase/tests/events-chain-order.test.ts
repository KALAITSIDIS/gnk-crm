import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

/**
 * 0109: the events hash chain under two INDEPENDENT database sessions.
 *
 * 0108 made concurrent writers of one organisation queue on a per-organisation
 * advisory lock inside `trg_events_hash`. But `events.id` is an identity
 * column, and the identity value is assigned by the column DEFAULT — before
 * the BEFORE ROW trigger runs, so before the lock is taken. A waiter can
 * therefore hold a LOWER id than a row the lock holder writes after it, and
 * because both the trigger and `verify_events_chain` order by id, the chain
 * the trigger built (lock order) and the chain the verifier walks (id order)
 * disagree: `prev_hash_mismatch` at the waiter's row, every later row
 * unverifiable. Reproduced live on 2026-09-22 with exactly the interleaving
 * below (a SQL replay of insertion order 1, 3, 2 had shown it first).
 *
 * These tests drive two real sessions through the `pg` driver with explicit
 * condition-based barriers (pg_stat_activity's wait state; the waiter's
 * statement returning) — never a sleep, and never a race that a unique
 * constraint happens to serialise.
 *
 * A THROWAWAY ORGANISATION, deleted at the end as postgres, events included.
 * The suite's fixture organisations are never touched: a forked chain in one
 * of them takes twenty-five tests down with it (measured 2026-09-22).
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const RUN = Date.now().toString(36);

let a: Client; // the lock holder
let b: Client; // the waiter
let o: Client; // the observer: barriers, verification, another organisation, cleanup

type Row = { id: string; prev_hash: string | null; hash: string; partition: string };

async function insertEvent(c: Client, org: string, label: string): Promise<Row> {
  const { rows } = await c.query<Row>(
    `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
     values ($1, null, 'config', null, 'chain_order_test', jsonb_build_object('run', $2::text, 'label', $3::text))
     returning id::text, prev_hash, hash, tableoid::regclass::text as partition`,
    [org, RUN, label],
  );
  return rows[0]!;
}

async function verify(org: string) {
  const { rows } = await o.query<{ ok: boolean; failed_id: string | null; reason: string | null }>(
    "select ok, failed_id::text, reason from verify_events_chain($1::uuid, null::bigint)",
    [org],
  );
  return rows[0]!;
}

async function backendPid(c: Client): Promise<number> {
  const { rows } = await c.query<{ pid: number }>("select pg_backend_pid() as pid");
  return rows[0]!.pid;
}

/** Poll a condition; the barrier is the condition, never the clock. */
async function until(label: string, cond: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`barrier timed out: ${label}`);
}

/** Barrier: the session with this pid is blocked on an advisory lock. */
const waitsOnAdvisoryLock = (pid: number) => async () => {
  const { rows } = await o.query<{ t: string | null; e: string | null }>(
    "select wait_event_type as t, wait_event as e from pg_stat_activity where pid = $1",
    [pid],
  );
  return rows[0]?.t === "Lock" && rows[0]?.e === "advisory";
};

/** Barrier: a promise has settled (a blocked statement has returned). */
function settled<T>(p: Promise<T>): { done: () => boolean; value: () => Promise<T> } {
  let done = false;
  const tracked = p.finally(() => {
    done = true;
  });
  return { done: () => done, value: () => tracked };
}

beforeAll(async () => {
  a = new Client({ connectionString: DB_URL });
  b = new Client({ connectionString: DB_URL });
  o = new Client({ connectionString: DB_URL });
  await Promise.all([a.connect(), b.connect(), o.connect()]);
  await o.query("insert into organizations (id, name, slug) values ($1, $2, $3), ($4, $5, $6)", [
    ORG,
    `Chain order ${RUN}`,
    `chain-order-${RUN}`,
    OTHER_ORG,
    `Chain order other ${RUN}`,
    `chain-order-other-${RUN}`,
  ]);
  // a committed genesis row, so every scenario below chains onto something
  await insertEvent(o, ORG, "genesis");
});

afterEach(async () => {
  // a failing scenario must not leave a transaction — and the lock — open on
  // either session, or the next scenario blocks on it instead of failing
  // for its own reason. BOTH AT ONCE: a session blocked on the lock queues
  // its rollback behind the blocked statement, which only returns when the
  // OTHER session rolls back — awaiting them one after the other deadlocks
  // the hook itself (measured: the first run's cleanup never ran).
  await Promise.all([a.query("rollback").catch(() => undefined), b.query("rollback").catch(() => undefined)]);
});

afterAll(async () => {
  for (const org of [ORG, OTHER_ORG]) {
    await o.query("delete from events where org_id = $1", [org]);
    await o.query("delete from events_chain_checkpoint where org_id = $1", [org]);
    await o.query("delete from chain_checks where org_id = $1", [org]);
    await o.query("delete from organizations where id = $1", [org]);
  }
  await Promise.all([a.end(), b.end(), o.end()]);
});

describe("the chain under two concurrent sessions of one organisation", () => {
  it("a waiter whose id was handed out before the lock still chains in id order when the holder appends again and commits first", async () => {
    await a.query("begin");
    const a1 = await insertEvent(a, ORG, "A1"); // holds the organisation's lock until commit

    await b.query("begin");
    const pidB = await backendPid(b);
    const bInsert = settled(insertEvent(b, ORG, "B")); // blocks on the lock
    await until("B waits on the advisory lock", waitsOnAdvisoryLock(pidB));
    expect(bInsert.done(), "B is blocked, not returned").toBe(false);

    const a2 = await insertEvent(a, ORG, "A2");
    await a.query("commit");
    await until("B's insert returns once A commits", async () => bInsert.done());
    const bRow = await bInsert.value();
    await b.query("commit");

    // id order == chain order: the waiter's row is the newest, and links to A2
    expect(BigInt(a1.id) < BigInt(a2.id), "A2 follows A1").toBe(true);
    expect(BigInt(a2.id) < BigInt(bRow.id), "the waiter's id is allocated under the lock, after A2's").toBe(true);
    expect(bRow.prev_hash).toBe(a2.hash);
    expect(a2.prev_hash).toBe(a1.hash);
    expect(await verify(ORG)).toMatchObject({ ok: true });
  });

  it("a later append extends that chain", async () => {
    const before = await o.query<{ hash: string }>("select hash from events where org_id = $1 order by id desc limit 1", [ORG]);
    const next = await insertEvent(o, ORG, "later");
    expect(next.prev_hash).toBe(before.rows[0]!.hash);
    expect(await verify(ORG)).toMatchObject({ ok: true });
  });

  it("the holder's ROLLBACK leaves the waiter chained onto the last committed row", async () => {
    const tail = await o.query<{ id: string; hash: string }>("select id::text, hash from events where org_id = $1 order by id desc limit 1", [ORG]);

    await a.query("begin");
    await insertEvent(a, ORG, "A-rolled-back");
    await b.query("begin");
    const pidB = await backendPid(b);
    const bInsert = settled(insertEvent(b, ORG, "B-after-rollback"));
    await until("B waits on the advisory lock", waitsOnAdvisoryLock(pidB));
    await a.query("rollback");
    await until("B's insert returns once A rolls back", async () => bInsert.done());
    const bRow = await bInsert.value();
    await b.query("commit");

    expect(bRow.prev_hash, "the rolled-back row never existed for the chain").toBe(tail.rows[0]!.hash);
    expect(BigInt(bRow.id) > BigInt(tail.rows[0]!.id)).toBe(true);
    expect(await verify(ORG)).toMatchObject({ ok: true });
  });

  it("a multi-row insert links its own rows in statement order, and the next writer continues from its last", async () => {
    await a.query("begin");
    const { rows } = await a.query<Row>(
      `insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
       select $1::uuid, null, 'config', null, 'chain_order_test', jsonb_build_object('run', $2::text, 'label', 'multi-' || g)
         from generate_series(1, 3) g
       returning id::text, prev_hash, hash, tableoid::regclass::text as partition`,
      [ORG, RUN],
    );
    await b.query("begin");
    const pidB = await backendPid(b);
    const bInsert = settled(insertEvent(b, ORG, "B-after-multi"));
    await until("B waits on the advisory lock", waitsOnAdvisoryLock(pidB));
    await a.query("commit");
    await until("B's insert returns", async () => bInsert.done());
    const bRow = await bInsert.value();
    await b.query("commit");

    expect(rows.map((r) => r.prev_hash).slice(1)).toEqual(rows.map((r) => r.hash).slice(0, 2));
    expect(rows.every((r, i) => i === 0 || BigInt(r.id) > BigInt(rows[i - 1]!.id))).toBe(true);
    expect(bRow.prev_hash).toBe(rows[2]!.hash);
    expect(await verify(ORG)).toMatchObject({ ok: true });
  });

  it("an incremental checkpoint anchored while the waiter was still uncommitted walks the waiter's row on the next pass", async () => {
    await a.query("begin");
    await insertEvent(a, ORG, "A-before-checkpoint");
    await b.query("begin");
    const pidB = await backendPid(b);
    const bInsert = settled(insertEvent(b, ORG, "B-around-checkpoint"));
    await until("B waits on the advisory lock", waitsOnAdvisoryLock(pidB));
    const a2 = await insertEvent(a, ORG, "A2-before-checkpoint");
    await a.query("commit");
    await until("B's insert returns", async () => bInsert.done());
    const bRow = await bInsert.value();

    // B holds its row uncommitted: the nightly incremental pass anchors on
    // what is committed — which must be the chain's tail, A2
    const first = await o.query<{ ok: boolean; reason: string | null }>("select ok, reason from advance_chain_checkpoint($1::uuid, false)", [ORG]);
    expect(first.rows[0]).toMatchObject({ ok: true });
    const cp = await o.query<{ last_id: string }>("select last_id::text from events_chain_checkpoint where org_id = $1", [ORG]);
    expect(cp.rows[0]!.last_id).toBe(a2.id);

    await b.query("commit");
    // the resumed walk starts AT the anchor and must reach B, whose id is newer
    const second = await o.query<{ ok: boolean; reason: string | null; walked: string }>(
      "select ok, reason, walked::text from advance_chain_checkpoint($1::uuid, false)",
      [ORG],
    );
    expect(second.rows[0]).toMatchObject({ ok: true });
    expect(Number(second.rows[0]!.walked), "the anchor row and the waiter's row").toBe(2);
    const after = await o.query<{ last_id: string }>("select last_id::text from events_chain_checkpoint where org_id = $1", [ORG]);
    expect(after.rows[0]!.last_id).toBe(bRow.id);
    // and the full walk agrees with the incremental one
    expect(await verify(ORG)).toMatchObject({ ok: true });
  });

  it("another organisation is neither blocked by the hold nor affected by it", async () => {
    await a.query("begin");
    await insertEvent(a, ORG, "A-holding");
    // a different organisation writes while A holds ORG's lock: must return
    // without waiting for A's commit
    const other = await insertEvent(o, OTHER_ORG, "other-genesis");
    expect(other.prev_hash).toBeNull();
    await a.query("commit");
    const other2 = await insertEvent(o, OTHER_ORG, "other-2");
    expect(other2.prev_hash).toBe(other.hash);
    expect(await verify(OTHER_ORG)).toMatchObject({ ok: true });
    expect(await verify(ORG)).toMatchObject({ ok: true });
  });

  it("every row landed in the month partition of its occurred_at, and the identity value never repeats", async () => {
    const { rows } = await o.query<{ partition: string; month: string; n: string }>(
      `select tableoid::regclass::text as partition, to_char(occurred_at at time zone 'UTC', 'YYYY_MM') as month, count(*)::text as n
         from events where org_id = $1 group by 1, 2`,
      [ORG],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.partition).toBe(`events_parts.events_${r.month}`);
    const dup = await o.query("select id from events where org_id = $1 group by id having count(*) > 1", [ORG]);
    expect(dup.rows).toHaveLength(0);
  });
});
