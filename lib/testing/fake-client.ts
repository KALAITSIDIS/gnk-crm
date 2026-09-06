/**
 * A Supabase client stand-in for the READ paths a service takes: every builder
 * method returns the chain, and awaiting the chain resolves to the next page
 * scripted for that table. Enough to prove that a service pages (how many
 * times was `from(table)` awaited?) and that it throws on a failed page,
 * without a database — which is the whole point of lib/supabase/fetch-all.ts.
 *
 * Test-only. Anything with `.then` semantics this simple would be wrong in
 * production, which is why it lives under lib/testing/.
 */
export interface FakePage {
  data: unknown[] | Record<string, unknown> | null;
  error: { message: string } | null;
  count?: number | null;
}

export function fakeClient(pages: Record<string, FakePage[]>) {
  /** how many times each table's chain has been awaited */
  const served: Record<string, number> = {};
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
          return () => chain(table);
        },
      },
    );
  return { client: { from: (table: string) => chain(table) }, served };
}
