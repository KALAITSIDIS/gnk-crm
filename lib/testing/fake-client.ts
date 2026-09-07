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
}

export interface FakeCall {
  table: string;
  method: string;
  args: unknown[];
}

export function fakeClient(pages: Record<string, FakePage[]>) {
  /** how many times each table's chain has been awaited */
  const served: Record<string, number> = {};
  /** every builder method called, in order, with its arguments */
  const calls: FakeCall[] = [];
  const chain = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            const n = served[table] ?? 0;
            served[table] = n + 1;
            const page = pages[table]?.[n] ?? { data: [], error: null };
            return (resolve: (v: FakePage) => void) => resolve(page);
          }
          if (typeof prop !== "string") return undefined;
          return (...args: unknown[]) => {
            calls.push({ table, method: prop, args });
            return chain(table);
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
