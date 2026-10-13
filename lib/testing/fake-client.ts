/**
 * A Supabase client stand-in for the READ and WRITE paths a service takes:
 * every builder method records itself and returns the chain, and awaiting the
 * chain resolves to the next result scripted for that table. Enough to prove
 * that a service pages (how many times was `from(table)` awaited, and over
 * WHICH ranges), that it predicates a write, and that it throws on a failed
 * page — without a database, which is the whole point of
 * lib/supabase/fetch-all.ts.
 *
 * IT RECORDS ARGUMENTS, and that is not decoration. The first version kept
 * only a per-table counter, so the A08a paging tests asserted "two pages were
 * fetched" while a factory that never called `.range(from, to)` — or never
 * called `.order("id")`, which is what makes a page a page rather than a
 * random sample — passed unchanged. A test that cannot fail for the reason it
 * exists is the failure this project keeps producing; `calls` is what closes
 * it (the properties-list spy builder had this shape all along).
 *
 * Test-only. Anything with `.then` semantics this simple would be wrong in
 * production, which is why it lives under lib/testing/.
 */
export interface FakePage {
  data: unknown[] | Record<string, unknown> | null;
  error: { message: string; code?: string } | null;
  count?: number | null;
  /** the HTTP status; an insert's page that names none answers 201 (see `answer`) */
  status?: number;
  statusText?: string;
}

export interface FakeCall {
  table: string;
  method: string;
  args: unknown[];
}

/**
 * What an awaited chain resolves to. A chain that called `insert` answers as
 * PostgREST does — 201 Created, with no rows unless it selected them (measured
 * on the local stack) — because logEvent refuses an insert answer that is not
 * a 201 (T-log-event-hollow), and a fake that answered every insert with no
 * status would make every event write in a test a failed one. So a page that
 * names no status is a successful insert; a test that wants a hollow answer
 * names it (`{ data: null, error: null, status: 204 }`). A scripted page's own
 * fields win, a failed page is left alone, and reads are untouched. Not
 * `upsert`: it answers 201 or 200 by whether the row existed, which a fake
 * cannot know.
 */
function answer(scripted: FakePage | undefined, verbs: FakeCall[]): FakePage {
  const insert = verbs.some((v) => v.method === "insert");
  const selected = verbs.some((v) => v.method === "select");
  const page = scripted ?? { data: insert && !selected ? null : [], error: null };
  if (!insert || page.error) return page;
  return { status: 201, statusText: "Created", ...page };
}

export function fakeClient(pages: Record<string, FakePage[]>) {
  /** how many times each table's chain has been awaited */
  const served: Record<string, number> = {};
  /** every builder method called, in order, with its arguments */
  const calls: FakeCall[] = [];
  const chain = (table: string, verbs: FakeCall[] = []): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            const n = served[table] ?? 0;
            served[table] = n + 1;
            const page = answer(pages[table]?.[n], verbs);
            return (resolve: (v: FakePage) => void) => resolve(page);
          }
          if (typeof prop !== "string") return undefined;
          return (...args: unknown[]) => {
            const call = { table, method: prop, args };
            calls.push(call);
            return chain(table, [...verbs, call]);
          };
        },
      },
    );
  return {
    client: { from: (table: string) => chain(table) },
    served,
    calls,
    /** the arguments of every `method` call on `table`, in order */
    argsOf: (table: string, method: string) =>
      calls.filter((c) => c.table === table && c.method === method).map((c) => c.args),
  };
}
