import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import {
  ANON_KEY,
  SUPABASE_URL,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";
import { parseCsvTable } from "../../scripts/import/_shared.mts";

/**
 * Browsing the Contacts, Leads, Keys, Properties and My tasks lists page by page
 * shows every record of the scope exactly once — through the REAL page server
 * components, against a REAL PostgREST, with the session's RLS and aal2 token
 * (T-list-page-order).
 *
 * At 3c6865d each page ordered by its timestamp alone (`created_at` /
 * `received_at` desc; a task's `due_at` asc, undated last) and then asked for a
 * 25-row offset range. Rows sharing a timestamp have no defined order between
 * them, so the database was free to return them in a different order for each
 * offset: one record on two pages, another on none, while the header count
 * stayed exact. The CSV exports already ended their order on `id`; the pages
 * now do too.
 *
 * Nothing below the page is stubbed except the Next.js request plumbing
 * (`createClient` hands the page a real session client). The test reads what
 * the page RETURNS — the rows it renders, its header total, its page count and
 * its Previous/Next links — and compares it with the database's own answer,
 * computed as postgres: `order by <timestamp> desc, id` (tasks: `due_at asc
 * nulls last, id`).
 *
 * WHAT IT PINS (each walk prints one `[evidence]` line):
 *   1. each list, walked page by page over an unchanged set in which most
 *      records share ONE timestamp and a slice sorts a day either side, shows
 *      exactly the authorised matching set, in the database's order, each
 *      record once; every page holds exactly its 25-row slice; the request
 *      the page sends orders by the timestamp and then `id` (the tie-breaker's
 *      removal fails here whatever plan the database picks);
 *   2. the header total and the page count are exact; a page past the end is
 *      empty and says so; asking for the same page again returns the same ids;
 *      Previous/Next keep every filter;
 *   3. searches (contacts, keys, properties) and filters (contact type,
 *      archived scope, lead status scopes, key status, property type, archived
 *      scope, the mandate filters) keep their meaning past page one, and their
 *      excluded records never appear;
 *   4. an agent walks the same order as an admin (the mandate filter shows an
 *      agent only their own mandates; My tasks shows each their own open tasks,
 *      never a colleague's or a done one); another organisation's records — newer
 *      than everything here, so a leak would land on page one — never appear,
 *      and that organisation's admin walks only its own;
 *   5. the property table and card views list the same records in the same
 *      order;
 *   6. the screen and the CSV export of the same scope list the same records
 *      in the same order.
 *
 * NOT PINNED: a record created, deleted or re-dated BETWEEN two page loads can
 * still shift a page boundary — every page is its own request. A unique order
 * removes the ambiguity among ties; it is not a snapshot.
 *
 * THROWAWAY ORGANISATIONS, deleted at the end as postgres, events included
 * (the CSV comparison writes `exported` audit lines).
 */
const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const ORGS = [ORG, OTHER_ORG];
const RUN = Date.now().toString(36);
const TAG = RUN.slice(-5).toUpperCase();
const SLUG = `list-page-order-${RUN}`;

const PAGE_SIZE = 25;
/** Records per list: eleven pages, the last one full — so the page after it starts exactly at the end. */
const N = 275;
/** Most records of a list share this timestamp, so ties straddle every page boundary. */
const TIED = "2026-01-01 09:00:00+00";
/** The other organisation's records are NEWER than all of ORG's: a leak would surface on page one. */
const OTHER_AT = "2026-06-01 09:00:00+00";
/**
 * …and a slice does NOT tie: one record in 7 sorts a day later, one in 11 a day
 * earlier, so a page that dropped or flipped its primary sort fails too.
 */
const VARIED = (g: string, at: string) =>
  `(${at}::timestamptz + case when ${g} % 7 = 0 then interval '1 day' when ${g} % 11 = 0 then interval '-1 day' else interval '0' end)`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ctx = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { als: new AsyncLocalStorage<unknown>() };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const c = ctx.als.getStore();
    if (!c) throw new Error("test harness: no session bound for this page");
    return c;
  },
}));

import ContactsPage from "@/app/(app)/contacts/page";
import LeadsPage from "@/app/(app)/leads/page";
import KeysPage from "@/app/(app)/keys/page";
import PropertiesPage from "@/app/(app)/properties/page";
import TasksPage from "@/app/(app)/tasks/page";
import { GET as contactsExport } from "@/app/(app)/contacts/export/route";
import { GET as leadsExport } from "@/app/(app)/leads/export/route";
import { GET as keysExport } from "@/app/(app)/keys/export/route";
import { GET as propertiesExport } from "@/app/(app)/properties/export/route";
import { GET as tasksExport } from "@/app/(app)/tasks/export/route";
import { KeysRegister } from "@/components/features/keys/keys-register";
import { PropertiesCards, PropertiesTable } from "@/components/features/properties/list";
import { Pager } from "@/components/features/shared/pager";
import { TaskSection } from "@/components/features/tasks/task-list";

type List = "contacts" | "leads" | "keys" | "properties" | "tasks";
type Params = Record<string, string>;

const PAGES: Record<List, (props: { searchParams: Promise<Params> }) => Promise<ReactNode>> = {
  contacts: ContactsPage,
  leads: LeadsPage,
  keys: KeysPage,
  properties: PropertiesPage,
  tasks: TasksPage,
};
const EXPORTS: Record<List, (req: NextRequest) => Promise<Response>> = {
  contacts: contactsExport,
  leads: leadsExport,
  keys: keysExport,
  properties: propertiesExport,
  tasks: tasksExport,
};
const TABLE: Record<List, string> = {
  contacts: "contacts",
  leads: "leads",
  keys: "property_keys",
  properties: "properties",
  tasks: "tasks",
};
/** What each page must ask PostgREST for: its own sort, then the unique id. */
const WIRE_ORDER: Record<List, string> = {
  contacts: "created_at.desc,id.asc",
  leads: "received_at.desc,id.asc",
  keys: "created_at.desc,id.asc",
  properties: "created_at.desc,id.asc",
  tasks: "due_at.asc.nullslast,id.asc",
};
/** The CSV column that names each record, and the database column behind it. */
const IDENTITY: Record<List, { csv: string; sql: string }> = {
  contacts: { csv: "Name", sql: "display_name" },
  leads: { csv: "Message", sql: "message" },
  keys: { csv: "Key code", sql: "key_code" },
  properties: { csv: "Reference", sql: "reference" },
  tasks: { csv: "Title", sql: "title" },
};

// ---------------------------------------------------------------------------
// A real session per user, made once (each setSession is a GoTrue round trip);
// every REST GET it sends is recorded, and each walk clears the record
// ---------------------------------------------------------------------------
type Session = { client: SupabaseClient; gets: string[] };
const sessions = new Map<TestUser, Session>();

async function session(user: TestUser): Promise<Session> {
  const known = sessions.get(user);
  if (known) return known;
  const s = (await user.client.auth.getSession()).data.session;
  if (!s) throw new Error(`no session for ${user.email}`);
  const gets: string[] = [];
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if ((init?.method ?? "GET").toUpperCase() === "GET" && url.includes("/rest/v1/")) gets.push(url);
        return fetch(input, init);
      },
    },
  });
  const { error } = await client.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (error) throw new Error(`setSession ${user.email}: ${error.message}`);
  sessions.set(user, { client, gets });
  return { client, gets };
}

// ---------------------------------------------------------------------------
// Reading what a page returned — its element tree, no rendering, so no client
// component runs and nothing about the router needs faking
// ---------------------------------------------------------------------------
type Element = ReactElement<Record<string, unknown>>;

function* walk(node: unknown): Generator<Element> {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
    return;
  }
  if (!isValidElement(node)) return;
  const el = node as Element;
  yield el;
  yield* walk(el.props.children);
}

/** Elements matching `hit`, outermost only: a row's own children are not searched for rows. */
function outermost(node: unknown, hit: (el: Element) => boolean): Element[] {
  if (Array.isArray(node)) return node.flatMap((n) => outermost(n, hit));
  if (!isValidElement(node)) return [];
  const el = node as Element;
  return hit(el) ? [el] : outermost(el.props.children, hit);
}

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node as Element).props.children);
  return "";
}

const hrefOf = (el: Element) => (typeof el.props.href === "string" ? el.props.href : null);
const linkTo = (els: Element[], label: string, rel: string) =>
  els.find((e) => hrefOf(e) !== null && (e.props.rel === rel || textOf(e) === label));

interface Screen {
  ids: string[];
  /** The total the page states. */
  total: number;
  /** The page count it states (1 when it shows no pager). */
  pageCount: number;
  next: string | null;
  prev: string | null;
  text: string;
  /** Properties only: what each rendered view holds. */
  views?: { table: string[] | null; cards: string[] | null };
}

/** Leads and keys hand their counts to the shared Pager; its links are what the user follows. */
function fromPager(els: Element[]): Pick<Screen, "total" | "pageCount" | "next" | "prev"> {
  const pager = els.find((e) => e.type === Pager);
  if (!pager) throw new Error("the page rendered no Pager");
  const props = pager.props as Parameters<typeof Pager>[0];
  // a plain function of its props (no hooks): calling it yields the links it renders
  const links = [...walk(Pager(props))];
  const next = linkTo(links, "Next", "next");
  const prev = linkTo(links, "Previous", "prev");
  return {
    total: props.total,
    pageCount: props.pageCount,
    next: next ? hrefOf(next) : null,
    prev: prev ? hrefOf(prev) : null,
  };
}

/** Contacts and properties state their own header count and "Page X of Y". */
function fromHeader(els: Element[], noun: RegExp): Pick<Screen, "total" | "pageCount" | "next" | "prev"> {
  const header = els.find((e) => e.type === "p" && noun.test(textOf(e)));
  if (!header) throw new Error(`the page stated no total matching ${noun}`);
  const pages = els.map((e) => /^Page (\d+) of (\d+)$/.exec(textOf(e))).find(Boolean);
  const next = linkTo(els, "Next", "next");
  const prev = linkTo(els, "Previous", "prev");
  return {
    total: Number(noun.exec(textOf(header))![1]),
    pageCount: pages ? Number(pages[2]) : 1,
    next: next ? hrefOf(next) : null,
    prev: prev ? hrefOf(prev) : null,
  };
}

function read(list: List, root: ReactNode): Screen {
  const els = [...walk(root)];
  const text = textOf(root);
  switch (list) {
    case "contacts": {
      const ids = els
        .map(hrefOf)
        .filter((h): h is string => h !== null && UUID.test(h.slice("/contacts/".length)) && h.startsWith("/contacts/"))
        .map((h) => h.slice("/contacts/".length));
      return { ids, text, ...fromHeader(els, /^(\d+) (?:archived )?contacts?$/) };
    }
    case "leads": {
      if (text.includes("Leads could not be loaded")) throw new Error(`leads page failed: ${text}`);
      const ids = outermost(root, (e) => e.type === "li" && UUID.test(String(e.key))).map((e) => String(e.key));
      return { ids, text, ...fromPager(els) };
    }
    case "keys": {
      const register = els.find((e) => e.type === KeysRegister);
      if (!register) throw new Error("the keys page rendered no register");
      const ids = (register.props.keys as { id: string }[]).map((k) => k.id);
      return { ids, text: `${text} ${String(register.props.emptyText)}`, ...fromPager(els) };
    }
    case "properties": {
      const rowsOf = (type: unknown) => {
        const el = els.find((e) => e.type === type);
        return el ? (el.props.rows as { id: string }[]).map((r) => r.id) : null;
      };
      const views = { table: rowsOf(PropertiesTable), cards: rowsOf(PropertiesCards) };
      return {
        ids: views.table ?? views.cards ?? [],
        views,
        text,
        ...fromHeader(els, /^(\d+) (?:archived )?propert(?:y|ies)$/),
      };
    }
    case "tasks": {
      // the page's open rows, split in its own order: every overdue task sorts
      // before every upcoming one (due date ascending, undated last). "Recently
      // done" is a separate, unpaged read and is not part of the walk.
      const section = (title: string) => {
        const el = els.find((e) => e.type === TaskSection && e.props.title === title);
        if (!el) throw new Error(`the tasks page rendered no "${title}" section`);
        return el;
      };
      const open = [section("Overdue"), section("Upcoming")];
      const ids = open.flatMap((s) => (s.props.items as { id: string }[]).map((t) => t.id));
      const empty = open.map((s) => String(s.props.emptyText)).join(" ");
      return { ids, text: `${text} ${empty}`, ...fromPager(els) };
    }
  }
}

async function show(list: List, client: SupabaseClient, params: Params): Promise<Screen> {
  const root = await ctx.als.run(client, () => PAGES[list]({ searchParams: Promise.resolve({ ...params }) }));
  return read(list, root);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let svc: SupabaseClient;
let pg: Client;
let admin: TestUser;
let agent: TestUser;
let outsider: TestUser;
const userIds: string[] = [];

async function ids(sql: string, params: unknown[]): Promise<string[]> {
  const { rows } = await pg.query<{ v: string }>(sql, params);
  return rows.map((r) => r.v);
}

beforeAll(async () => {
  svc = serviceClient();
  pg = new Client({ connectionString: DB_URL });
  await pg.connect();

  await ensureTestOrg(svc, ORG, `List page order ${RUN}`, SLUG);
  await ensureTestOrg(svc, OTHER_ORG, `List page order other ${RUN}`, `${SLUG}-other`);
  // one at a time: parallel TOTP enrolment draws GoTrue 502/504s; each id is
  // kept as soon as it exists, so a later failure still cleans it up
  admin = await createTestUser(svc, `lpo-admin-${RUN}@test.local`, "admin", ORG);
  userIds.push(admin.id);
  agent = await createTestUser(svc, `lpo-agent-${RUN}@test.local`, "agent", ORG);
  userIds.push(agent.id);
  outsider = await createTestUser(svc, `lpo-other-${RUN}@test.local`, "admin", OTHER_ORG);
  userIds.push(outsider.id);

  // ORG: N of each list, most tied, plus records each filter must leave out.
  // contacts: buyers and (every third) sellers; archived ones
  await pg.query(
    `insert into contacts (org_id, first_name, contact_types, created_at)
     select $1::uuid, format('PC%s-%s', $2::text, lpad(g::text, 5, '0')),
            case when g % 3 = 0 then array['seller'] else array['buyer'] end, ${VARIED("g", "$3")}
       from generate_series(1, $4::int) g`,
    [ORG, TAG, TIED, N],
  );
  await pg.query(
    `insert into contacts (org_id, first_name, is_archived, created_at)
     select $1::uuid, format('PA%s-%s', $2::text, lpad(g::text, 5, '0')), true, $3::timestamptz
       from generate_series(1, 40) g`,
    [ORG, TAG, TIED],
  );
  // leads: six statuses in turn (half open, half closed), never 'website' (crons act on those)
  await pg.query(
    `insert into leads (org_id, source, channel, status, message, received_at)
     select $1::uuid, 'phone', 'phone',
            (array['new','contacted','qualified','converted','lost','spam']::lead_status[])[1 + g % 6],
            format('PL%s-%s', $2::text, lpad(g::text, 5, '0')), ${VARIED("g", "$3")}
       from generate_series(1, $4::int) g`,
    [ORG, TAG, TIED, 2 * N],
  );
  // properties: listings (every fourth a villa), withdrawn ones; ten assigned to the agent
  await pg.query(
    `insert into properties (org_id, reference, property_type, assigned_agent_id, created_at)
     select $1::uuid, format('PP%s-%s', $2::text, lpad(g::text, 5, '0')),
            (case when g % 4 = 0 then 'villa' else 'apartment' end)::property_type,
            case when g between 41 and 50 then $5::uuid end, ${VARIED("g", "$3")}
       from generate_series(1, $4::int) g`,
    [ORG, TAG, TIED, N, agent.id],
  );
  await pg.query(
    `insert into properties (org_id, reference, property_type, status, created_at)
     select $1::uuid, format('PW%s-%s', $2::text, lpad(g::text, 5, '0')), 'apartment', 'withdrawn', $3::timestamptz
       from generate_series(1, 30) g`,
    [ORG, TAG, TIED],
  );
  // mandates: the first 100 listings; 40 written by the agent, 10 more on the agent's own listings
  await pg.query(
    `insert into mandates (org_id, property_id, type, status, created_by)
     select $1::uuid, p.id, 'exclusive', 'active', case when p.reference <= format('PP%s-%s', $2::text, '00040') then $3::uuid end
       from (select id, reference from properties where org_id = $1 and reference like 'PP%' order by reference limit 100) p`,
    [ORG, TAG, agent.id],
  );
  // keys: four statuses in turn, on three of the listings
  const { rows: parents } = await pg.query<{ id: string }>(
    "select id from properties where org_id = $1 and reference like 'PP%' order by reference limit 3",
    [ORG],
  );
  await pg.query(
    `insert into property_keys (org_id, property_id, key_code, status, created_at)
     select $1::uuid, ($3::uuid[])[1 + g % 3], format('PK%s-%s', $2::text, lpad(g::text, 5, '0')),
            (array['in_office','checked_out','with_owner','lost']::key_status[])[1 + g % 4], ${VARIED("g", "$4")}
       from generate_series(1, $5::int) g`,
    [ORG, TAG, parents.map((p) => p.id), TIED, N],
  );
  // tasks: the admin's own — most due on ONE past day (overdue), a slice a day
  // either side, one in 17 due in the future (upcoming), one in 9 undated
  // (sorted last, all tied, more than a page of them) — some already done; and
  // the agent's
  await pg.query(
    `insert into tasks (org_id, title, assignee_id, created_by, due_at)
     select $1::uuid, format('PT%s-%s', $2::text, lpad(g::text, 5, '0')), $3::uuid, $3::uuid,
            case when g % 9 = 0 then null
                 when g % 17 = 0 then '2030-01-01 21:59:00+00'::timestamptz
                 else ${VARIED("g", "$4")} end
       from generate_series(1, $5::int) g`,
    [ORG, TAG, admin.id, TIED, N],
  );
  await pg.query(
    `insert into tasks (org_id, title, assignee_id, created_by, due_at, is_done, done_at)
     select $1::uuid, format('PD%s-%s', $2::text, lpad(g::text, 5, '0')), $3::uuid, $3::uuid, $4::timestamptz, true, now()
       from generate_series(1, 20) g`,
    [ORG, TAG, admin.id, TIED],
  );
  await pg.query(
    `insert into tasks (org_id, title, assignee_id, created_by, due_at)
     select $1::uuid, format('PG%s-%s', $2::text, lpad(g::text, 5, '0')), $3::uuid, $3::uuid, $4::timestamptz
       from generate_series(1, 60) g`,
    [ORG, TAG, agent.id, TIED],
  );

  // OTHER_ORG: thirty of each, all newer than ORG's (leads all 'new')
  const X = `X${TAG}`;
  await pg.query(
    `insert into contacts (org_id, first_name, created_at)
     select $1::uuid, format('PC%s-%s', $2::text, lpad(g::text, 5, '0')), $3::timestamptz from generate_series(1, 30) g`,
    [OTHER_ORG, X, OTHER_AT],
  );
  await pg.query(
    `insert into leads (org_id, source, channel, status, message, received_at)
     select $1::uuid, 'phone', 'phone', 'new', format('PL%s-%s', $2::text, lpad(g::text, 5, '0')), $3::timestamptz
       from generate_series(1, 30) g`,
    [OTHER_ORG, X, OTHER_AT],
  );
  await pg.query(
    `insert into properties (org_id, reference, property_type, created_at)
     select $1::uuid, format('PP%s-%s', $2::text, lpad(g::text, 5, '0')), 'apartment', $3::timestamptz
       from generate_series(1, 30) g`,
    [OTHER_ORG, X, OTHER_AT],
  );
  await pg.query(
    `insert into property_keys (org_id, property_id, key_code, created_at)
     select $1::uuid, (select id from properties where org_id = $1 order by reference limit 1),
            format('PK%s-%s', $2::text, lpad(g::text, 5, '0')), $3::timestamptz
       from generate_series(1, 30) g`,
    [OTHER_ORG, X, OTHER_AT],
  );
  await pg.query(
    `insert into tasks (org_id, title, assignee_id, created_by, due_at)
     select $1::uuid, format('PT%s-%s', $2::text, lpad(g::text, 5, '0')), $3::uuid, $3::uuid, $4::timestamptz
       from generate_series(1, 30) g`,
    [OTHER_ORG, X, outsider.id, OTHER_AT],
  );
}, 300_000);

afterAll(async () => {
  for (const t of ["tasks", "property_keys", "mandates", "leads"]) {
    await pg.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]);
  }
  await pg.query("delete from properties where org_id = any($1::uuid[])", [ORGS]);
  await pg.query("delete from contacts where org_id = any($1::uuid[])", [ORGS]);
  for (const id of userIds) await svc.auth.admin.deleteUser(id);
  for (const t of ["profiles", "events", "events_chain_checkpoint", "chain_checks", "deal_stages", "districts"]) {
    await pg.query(`delete from ${t} where org_id = any($1::uuid[])`, [ORGS]);
  }
  await pg.query("delete from organizations where id = any($1::uuid[])", [ORGS]);
  await pg.end();
}, 300_000);

// ---------------------------------------------------------------------------
// The authorised matching set, as postgres, in the order the page must show
// ---------------------------------------------------------------------------
const EXPECTED = {
  /** `q` as the seeded records can match it: the name (no phone or email is seeded). */
  contacts: (org: string, archived: boolean, type?: string, q?: string) =>
    ids(
      `select id::text as v from contacts where org_id = $1 and is_archived = $2
         and ($3::text is null or contact_types @> array[$3])
         and ($4::text is null or display_name ilike '%' || $4 || '%')
       order by created_at desc, id`,
      [org, archived, type ?? null, q ?? null],
    ),
  leads: (org: string, statuses: string[] | null) =>
    ids(
      `select id::text as v from leads where org_id = $1 and ($2::text[] is null or status::text = any($2))
       order by received_at desc, id`,
      [org, statuses],
    ),
  /** `q` as the seeded keys can match it: the key code (no description, holder or matching reference). */
  keys: (org: string, status: string | null, q?: string) =>
    ids(
      `select id::text as v from property_keys where org_id = $1 and ($2::text is null or status::text = $2)
         and ($3::text is null or key_code ilike '%' || $3 || '%')
       order by created_at desc, id`,
      [org, status, q ?? null],
    ),
  /**
   * `mandate` as the page means it; `agentId` applies mandates_safe's agent arm
   * (own or assigned); `q` as the seeded listings can match it: the reference.
   */
  properties: (
    org: string,
    o: { archived?: boolean; type?: string; mandate?: "active" | "none"; agentId?: string; q?: string } = {},
  ) =>
    ids(
      `select p.id::text as v from properties p where p.org_id = $1 and p.kind <> 'unit'
         and case when $2 then (p.status = 'withdrawn' or p.visibility = 'archived')
                  else p.status <> 'withdrawn' and p.visibility <> 'archived' end
         and ($3::text is null or p.property_type::text = $3)
         and ($4::text is distinct from 'active' or exists (
               select 1 from mandates m where m.property_id = p.id and m.status = 'active'
                  and ($5::uuid is null or m.created_by = $5 or p.assigned_agent_id = $5)))
         and ($4::text is distinct from 'none' or not exists (
               select 1 from mandates m where m.property_id = p.id and m.status in ('active', 'expired')
                  and ($5::uuid is null or m.created_by = $5 or p.assigned_agent_id = $5)))
         and ($6::text is null or p.reference ilike '%' || $6 || '%')
       order by p.created_at desc, p.id`,
      [org, o.archived ?? false, o.type ?? null, o.mandate ?? null, o.agentId ?? null, o.q ?? null],
    ),
  /** My tasks: the signed-in user's OPEN tasks, soonest due first, undated last. */
  tasks: (org: string, assignee: string) =>
    ids(
      `select id::text as v from tasks where org_id = $1 and assignee_id = $2 and not is_done
       order by due_at asc nulls last, id`,
      [org, assignee],
    ),
};

// ---------------------------------------------------------------------------
// Walking a list the way a person does: page 1, then Next until the last page
// ---------------------------------------------------------------------------
interface Walk {
  pages: Screen[];
  ids: string[];
  beyond: Screen;
  again: Screen;
  /** The `order` and `offset` of each list request, in the order sent. */
  requests: { order: string | null; offset: number; limit: number }[];
}

async function browse(list: List, user: TestUser, filters: Params): Promise<Walk> {
  const { client, gets } = await session(user);
  gets.length = 0;
  const pages = [await show(list, client, filters)];
  for (let p = 2; p <= pages[0]!.pageCount; p++) pages.push(await show(list, client, { ...filters, page: String(p) }));
  const beyond = await show(list, client, { ...filters, page: String(pages[0]!.pageCount + 1) });
  // the same page asked for again: the middle one when there is one
  const mid = Math.max(1, Math.ceil(pages[0]!.pageCount / 2));
  const again = await show(list, client, mid === 1 ? filters : { ...filters, page: String(mid) });
  const requests = gets
    .map((u) => new URL(u))
    .filter((u) => u.pathname === `/rest/v1/${TABLE[list]}` && u.searchParams.get("limit") === String(PAGE_SIZE))
    .map((u) => ({
      order: u.searchParams.get("order"),
      offset: Number(u.searchParams.get("offset") ?? 0),
      limit: Number(u.searchParams.get("limit")),
    }));
  return { pages, ids: pages.flatMap((s) => s.ids), beyond, again, requests };
}

/** What a page link asks for: its page number and every other parameter. */
function linkParams(href: string | null): Params | null {
  if (href === null) return null;
  return Object.fromEntries(new URLSearchParams(href.replace(/^\?/, "")).entries());
}

const BEYOND_TEXT: Record<List, RegExp> = {
  contacts: /No (archived )?contacts match/,
  leads: /Nothing on this page\./,
  keys: /Nothing on this page\./,
  properties: /Nothing on this page\./,
  tasks: /None on this page\./,
};

/**
 * The walk against the authorised set: same records, same order, each once,
 * every page its exact slice, the counts and links right. Soft assertions, so a
 * failing walk still lets every later walk in the test print its evidence.
 */
async function expectWalk(
  label: string,
  list: List,
  user: TestUser,
  filters: Params,
  expected: string[],
  foreign: string[] = [],
): Promise<Walk> {
  const w = await browse(list, user, filters);
  const seen = new Set(w.ids);
  const want = new Set(expected);
  const repeated = w.ids.length - seen.size;
  const missing = expected.filter((id) => !seen.has(id));
  const extra = [...seen].filter((id) => !want.has(id));
  const leaked = w.ids.filter((id) => foreign.includes(id));
  const inOrder = JSON.stringify(w.ids) === JSON.stringify(expected);
  const orders = [...new Set(w.requests.map((r) => r.order))];
  console.log(
    `[evidence] ${list} ${label}: stated ${w.pages[0]!.total} (database ${expected.length}), pages ${w.pages.length},` +
      ` shown ${w.ids.length}, distinct ${seen.size}, repeated ${repeated}, missing ${missing.length},` +
      ` not in scope ${extra.length}, other org ${leaked.length}, database order ${inOrder ? "yes" : "NO"},` +
      ` order=${orders.join("|")}`,
  );

  const pageCount = Math.max(1, Math.ceil(expected.length / PAGE_SIZE));
  expect.soft(w.pages[0]!.total, `${label}: the header total`).toBe(expected.length);
  expect.soft(w.pages[0]!.pageCount, `${label}: the page count`).toBe(pageCount);
  expect.soft(repeated, `${label}: records shown on more than one page`).toBe(0);
  expect.soft(missing, `${label}: records on no page`).toEqual([]);
  expect.soft(extra, `${label}: records outside the scope`).toEqual([]);
  expect.soft(leaked, `${label}: another organisation's records`).toEqual([]);
  w.pages.forEach((s, i) => {
    expect.soft(s.ids, `${label}: page ${i + 1} is exactly its slice`).toEqual(
      expected.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE),
    );
    expect.soft(s.total, `${label}: page ${i + 1} states the same total`).toBe(expected.length);
  });
  expect.soft(w.ids, `${label}: the walk is the database's order`).toEqual(expected);
  // the request itself: the list's sort, then id — whatever plan the database picks
  expect.soft(orders, `${label}: the page orders by its timestamp, then id`).toEqual([WIRE_ORDER[list]]);
  expect.soft(
    w.requests.slice(0, w.pages.length).map((r) => r.offset),
    `${label}: offsets step by the page size`,
  ).toEqual(w.pages.map((_, i) => i * PAGE_SIZE));

  // past the end: nothing, said plainly; the same page again: the same ids
  expect.soft(w.beyond.ids, `${label}: the page past the end`).toEqual([]);
  expect.soft(w.beyond.text).toMatch(BEYOND_TEXT[list]);
  const mid = Math.max(1, Math.ceil(pageCount / 2));
  expect.soft(w.again.ids, `${label}: page ${mid} asked for again`).toEqual(w.pages[mid - 1]!.ids);

  // Previous / Next: the neighbouring page, every filter kept
  w.pages.forEach((s, i) => {
    const p = i + 1;
    const next = linkParams(s.next);
    const prev = linkParams(s.prev);
    if (p < w.pages.length) {
      expect.soft(next, `${label}: page ${p} Next`).toEqual({ ...filters, page: String(p + 1) });
    } else {
      expect.soft(next, `${label}: no Next on the last page`).toBeNull();
    }
    if (p === 1) {
      expect.soft(prev, `${label}: no Previous on page 1`).toBeNull();
    } else {
      // the shared Pager keeps page=1 out of the URL; contacts and properties spell it
      const { page: prevPage, ...rest } = prev ?? {};
      expect.soft(rest, `${label}: page ${p} Previous keeps the filters`).toEqual(filters);
      expect.soft(prevPage ?? "1", `${label}: page ${p} Previous`).toBe(String(p - 1));
    }
  });
  return w;
}

// ---------------------------------------------------------------------------
// The CSV of the same scope, read through the real export route
// ---------------------------------------------------------------------------
async function exportedIdentities(
  list: List,
  user: TestUser,
  filters: Params,
  keep: (row: Record<string, string>) => boolean,
): Promise<string[]> {
  const url = new URL(`http://localhost/${list}/export`);
  for (const [k, v] of Object.entries(filters)) url.searchParams.set(k, v);
  const { client } = await session(user);
  const res = await ctx.als.run(client, () => EXPORTS[list](new NextRequest(url)));
  const body = await res.text();
  expect(res.status, `${list} export: ${body.slice(0, 200)}`).toBe(200);
  return parseCsvTable(body).rows.filter(keep).map((r) => r[IDENTITY[list].csv] ?? "");
}

async function identitiesOf(list: List, idList: string[]): Promise<string[]> {
  const { rows } = await pg.query<{ id: string; v: string }>(
    `select id::text as id, ${IDENTITY[list].sql} as v from ${TABLE[list]} where id = any($1::uuid[])`,
    [idList],
  );
  const name = new Map(rows.map((r) => [r.id, r.v]));
  return idList.map((id) => name.get(id) ?? `?${id}`);
}

/**
 * `keep` narrows the CSV to the screen's scope where the two differ by design:
 * the tasks CSV holds every task of mine, the page only the open ones.
 */
async function expectScreenMatchesCsv(
  list: List,
  user: TestUser,
  filters: Params,
  walk: Walk,
  keep: (row: Record<string, string>) => boolean = () => true,
): Promise<void> {
  const screen = await identitiesOf(list, walk.ids);
  const csv = await exportedIdentities(list, user, filters, keep);
  const same = JSON.stringify(screen) === JSON.stringify(csv);
  console.log(`[evidence] ${list} screen vs CSV: screen ${screen.length}, csv ${csv.length}, same order ${same ? "yes" : "NO"}`);
  expect.soft(csv, `${list}: the CSV lists the screen's records in the screen's order`).toEqual(screen);
}

// ---------------------------------------------------------------------------
describe("browsing a list page by page shows each record exactly once", () => {
  it("the fixture ties most records across page boundaries and spreads the rest (measured)", async () => {
    const { rows } = await pg.query<{ t: string; at: string; c: string }>(
      `select 'contacts' as t, created_at::text as at, count(*) as c from contacts where org_id = $1 and not is_archived group by created_at
       union all select 'leads', received_at::text, count(*) from leads where org_id = $1 group by received_at
       union all select 'keys', created_at::text, count(*) from property_keys where org_id = $1 group by created_at
       union all select 'properties', created_at::text, count(*) from properties where org_id = $1 and status <> 'withdrawn' group by created_at
       order by 1, 2`,
      [ORG],
    );
    for (const t of ["contacts", "leads", "keys", "properties"]) {
      const groups = rows.filter((r) => r.t === t).map((r) => `${r.at.slice(0, 10)}×${r.c}`);
      console.log(`[evidence] ${t} timestamps: ${groups.join(", ")}`);
      expect(groups, `${t}: three timestamps — a day before, the tie, a day after`).toHaveLength(3);
      const tied = Number(rows.find((r) => r.t === t && r.at.startsWith("2026-01-01"))!.c);
      expect(tied, `${t}: the tie spans several pages`).toBeGreaterThan(4 * PAGE_SIZE);
    }
    // my open tasks: overdue (a day before, the tie, a day after), upcoming, undated
    const { rows: due } = await pg.query<{ at: string; c: string }>(
      `select coalesce(due_at::text, 'undated') as at, count(*) as c from tasks
        where org_id = $1 and assignee_id = $2 and not is_done group by due_at order by due_at nulls last`,
      [ORG, admin.id],
    );
    console.log(`[evidence] tasks due dates: ${due.map((r) => `${r.at.slice(0, 10)}×${r.c}`).join(", ")}`);
    expect(due, "tasks: five due-date groups").toHaveLength(5);
    expect(Number(due.find((r) => r.at.startsWith("2026-01-01"))!.c), "tasks: the tie spans several pages").toBeGreaterThan(4 * PAGE_SIZE);
    expect(Number(due.find((r) => r.at === "undated")!.c), "tasks: more undated (tied) than one page holds").toBeGreaterThan(PAGE_SIZE);
  });

  it("contacts: active, a type filter, a search, the archived scope; as an admin and as an agent", async () => {
    const expected = await EXPECTED.contacts(ORG, false);
    const foreign = await EXPECTED.contacts(OTHER_ORG, false);
    const w = await expectWalk("active/admin", "contacts", admin, {}, expected, foreign);
    await expectWalk("active/agent", "contacts", agent, {}, expected, foreign);
    await expectWalk("type=seller", "contacts", admin, { type: "seller" }, await EXPECTED.contacts(ORG, false, "seller"));
    await expectWalk("archived", "contacts", admin, { archived: "1" }, await EXPECTED.contacts(ORG, true));
    const found = await EXPECTED.contacts(ORG, false, undefined, `PC${TAG}-001`);
    expect(found, "the search matches 100 records: four pages").toHaveLength(100);
    await expectWalk("q (search)", "contacts", admin, { q: `PC${TAG}-001` }, found);
    await expectScreenMatchesCsv("contacts", admin, {}, w);
  }, 180_000);

  it("leads: the open inbox, every status, the closed scope; as an admin and as an agent", async () => {
    const open = ["new", "contacted", "qualified"];
    const foreign = await EXPECTED.leads(OTHER_ORG, null);
    const w = await expectWalk("open/admin", "leads", admin, {}, await EXPECTED.leads(ORG, open), foreign);
    await expectWalk("open/agent", "leads", agent, {}, await EXPECTED.leads(ORG, open), foreign);
    await expectWalk("all", "leads", admin, { status: "all" }, await EXPECTED.leads(ORG, null), foreign);
    await expectWalk("closed", "leads", admin, { status: "closed" }, await EXPECTED.leads(ORG, ["converted", "lost", "spam"]));
    await expectScreenMatchesCsv("leads", admin, {}, w);
  }, 180_000);

  it("keys: every status, one status, a search; as an admin and as an agent", async () => {
    const expected = await EXPECTED.keys(ORG, null);
    const foreign = await EXPECTED.keys(OTHER_ORG, null);
    const w = await expectWalk("all/admin", "keys", admin, {}, expected, foreign);
    await expectWalk("all/agent", "keys", agent, {}, expected, foreign);
    await expectWalk("checked_out", "keys", admin, { status: "checked_out" }, await EXPECTED.keys(ORG, "checked_out"));
    const found = await EXPECTED.keys(ORG, null, `PK${TAG}-001`);
    expect(found, "the search matches 100 keys: four pages").toHaveLength(100);
    await expectWalk("q (search)", "keys", admin, { q: `PK${TAG}-001` }, found);
    await expectScreenMatchesCsv("keys", admin, {}, w);
  }, 180_000);

  it("properties: the table and card views list the same records in the same order", async () => {
    const expected = await EXPECTED.properties(ORG);
    const foreign = await EXPECTED.properties(OTHER_ORG);
    const table = await expectWalk("view=table", "properties", admin, { view: "table" }, expected, foreign);
    const cards = await expectWalk("view=cards", "properties", admin, { view: "cards" }, expected, foreign);
    for (const s of table.pages) expect(s.views?.cards, "view=table renders no cards").toBeNull();
    for (const s of cards.pages) expect(s.views?.table, "view=cards renders no table").toBeNull();
    // auto renders both from the one query: they must agree on every page
    const auto = await expectWalk("view=auto", "properties", admin, {}, expected, foreign);
    for (const [i, s] of auto.pages.entries()) {
      expect(s.views?.cards, `auto page ${i + 1}: cards = table`).toEqual(s.views?.table);
    }
    await expectWalk("default/agent", "properties", agent, { view: "table" }, expected, foreign);
    await expectScreenMatchesCsv("properties", admin, { view: "table" }, table);
  }, 240_000);

  it("properties: search, type, archived scope and the mandate filters keep their meaning past page one", async () => {
    const found = await EXPECTED.properties(ORG, { q: `PP${TAG}-001` });
    expect(found, "the search matches 100 listings: four pages").toHaveLength(100);
    await expectWalk("q (search)", "properties", admin, { view: "table", q: `PP${TAG}-001` }, found);
    await expectWalk("type=villa", "properties", admin, { view: "table", type: "villa" }, await EXPECTED.properties(ORG, { type: "villa" }));
    await expectWalk("archived", "properties", admin, { view: "table", scope: "archived" }, await EXPECTED.properties(ORG, { archived: true }));
    await expectWalk("mandate=active/admin", "properties", admin, { view: "table", mandate: "active" }, await EXPECTED.properties(ORG, { mandate: "active" }));
    const own = await EXPECTED.properties(ORG, { mandate: "active", agentId: agent.id });
    expect(own, "the agent's own mandates: 40 written + 10 on assigned listings").toHaveLength(50);
    await expectWalk("mandate=active/agent", "properties", agent, { view: "table", mandate: "active" }, own);
    await expectWalk("mandate=none/admin", "properties", admin, { view: "table", mandate: "none" }, await EXPECTED.properties(ORG, { mandate: "none" }));
  }, 240_000);

  it("my tasks: my open tasks — overdue, upcoming, undated last — never a colleague's or a done one", async () => {
    const mine = await EXPECTED.tasks(ORG, admin.id);
    const theirs = await EXPECTED.tasks(ORG, agent.id);
    const { rows: done } = await pg.query<{ v: string }>(
      "select id::text as v from tasks where org_id = $1 and assignee_id = $2 and is_done",
      [ORG, admin.id],
    );
    const elsewhere = await EXPECTED.tasks(OTHER_ORG, outsider.id);
    const w = await expectWalk("mine/admin", "tasks", admin, {}, mine, [...theirs, ...done.map((r) => r.v), ...elsewhere]);
    await expectWalk("mine/agent", "tasks", agent, {}, theirs, [...mine, ...elsewhere]);
    // the CSV holds every task of mine, open and done; its open ones are the screen, in the screen's order
    await expectScreenMatchesCsv("tasks", admin, {}, w, (row) => row.Status === "open");
  }, 180_000);

  it("another organisation's admin walks only its own records", async () => {
    await expectWalk("other org", "contacts", outsider, {}, await EXPECTED.contacts(OTHER_ORG, false), await EXPECTED.contacts(ORG, false));
    await expectWalk("other org", "leads", outsider, {}, await EXPECTED.leads(OTHER_ORG, ["new", "contacted", "qualified"]), await EXPECTED.leads(ORG, null));
    await expectWalk("other org", "keys", outsider, {}, await EXPECTED.keys(OTHER_ORG, null), await EXPECTED.keys(ORG, null));
    await expectWalk("other org", "properties", outsider, { view: "table" }, await EXPECTED.properties(OTHER_ORG), await EXPECTED.properties(ORG));
    await expectWalk("other org", "tasks", outsider, {}, await EXPECTED.tasks(OTHER_ORG, outsider.id), await EXPECTED.tasks(ORG, admin.id));
  }, 120_000);

  it("an empty scope is one empty page with no pager", async () => {
    const cases: [List, TestUser, Params, RegExp][] = [
      ["contacts", admin, { type: "developer" }, /No contacts match — add the first one\./],
      ["leads", outsider, { status: "lost" }, /No lost leads\./],
      ["keys", admin, { q: `NONE${TAG}` }, /No keys match\./],
      ["properties", admin, { type: "land" }, /No properties match — add the first one or clear filters\./],
    ];
    for (const [list, user, filters, says] of cases) {
      const { client } = await session(user);
      const s = await show(list, client, filters);
      console.log(`[evidence] ${list} empty ${JSON.stringify(filters)}: total ${s.total}, rows ${s.ids.length}`);
      expect(s.ids).toEqual([]);
      expect(s.total).toBe(0);
      expect(s.pageCount).toBe(1);
      expect(s.next).toBeNull();
      expect(s.text).toMatch(says);
    }
  }, 60_000);
});
