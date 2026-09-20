/**
 * WHAT EACH DEPLOYED CRM SENDS THROUGH THE ENQUIRY DOOR, AND WHAT IT CONCLUDES.
 *
 * One entry per RPC SHAPE that has ever been on `main`, lifted from that
 * commit's `app/api/public/enquiries/route.ts` rather than described from
 * memory — `git show <commit>:app/api/public/enquiries/route.ts` is the check.
 * A release-compatibility question is only as good as the fidelity of these.
 *
 * `accepted()` is deliberately the APP'S predicate, bugs included. `boolean-door`
 * really did read `data !== true`, and that reading is the defect being pinned;
 * correcting it here would delete the only thing this file exists to remember.
 */

export interface DoorAnswer {
  data: unknown;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface DoorContract {
  /** Short, stable, printed in the report. */
  id: string;
  /** Which deployed commits send this shape, in words. */
  appRange: string;
  /** Exact commits, so the report is checkable. */
  commits: string;
  /** The migration range the route was written against. */
  migrations: string;
  /** Is this a stage the project undertakes to keep working? */
  supported: boolean;
  /** Does it mint an idempotency key (i.e. is a retry the same enquiry)? */
  sendsKey: boolean;
  why: string;
  args: (p: { name: string; email: string; message: string; key: string }) => Record<string, unknown>;
  /** What that version told the visitor: true = 202 accepted, false = refused. */
  accepted: (a: DoorAnswer) => boolean;
}

/** PostgREST returns a table-returning function as an array of rows. */
const rows = (a: DoorAnswer): Array<{ replayed?: boolean }> =>
  Array.isArray(a.data) ? (a.data as Array<{ replayed?: boolean }>) : [];

export const DOOR_CONTRACTS: DoorContract[] = [
  {
    id: "boolean-door",
    appRange: "main up to and including 0ee5827 — the route deployed during the 2026-09-15 window",
    commits: "f0e6593..0ee5827",
    migrations: "0084, 0087, 0092",
    supported: false,
    sendsKey: false,
    why:
      "Six named arguments and `if (data !== true) return 400 'Unknown org.'`. Against a " +
      "database at 0096 or later the function answers an ARRAY of one row, which is not " +
      "`true`, so a committed lead was reported to the visitor as a refusal. This is the " +
      "historical incident and it is kept to prove the detector still catches it. It is NOT " +
      "a supported rollback target.",
    args: (p) => ({
      p_org_slug: "test-org-a",
      p_name: p.name,
      p_email: p.email,
      p_phone: "",
      p_message: p.message,
      p_property_ref: "",
    }),
    accepted: (a) => a.errorCode === null && a.data === true,
  },
  {
    id: "row-door",
    appRange: "the 0096-aware route (4509d47 on feat/sprint-a-lead-routing; never on main alone)",
    commits: "4509d47",
    migrations: "0096",
    supported: true,
    sendsKey: true,
    why:
      "Seven named arguments and `const row = (data ?? [])[0]; if (!row) return 400`. It " +
      "sends no p_meta, which 0098 made an EIGHTH parameter with a default precisely so " +
      "this call keeps resolving — the additive transition that the boolean change was not. " +
      "Kept as a supported stage because it is the shape a rollback to the first half of " +
      "PR #11 would send, and because it is the cheapest proof that 0098 stayed additive.",
    args: (p) => ({
      p_org_slug: "test-org-a",
      p_name: p.name,
      p_email: p.email,
      p_phone: "",
      p_message: p.message,
      p_property_ref: "",
      p_idempotency_key: p.key,
    }),
    accepted: (a) => a.errorCode === null && rows(a).length > 0,
  },
  {
    id: "meta-door",
    appRange: "main since 1737b4f — including the commit deployed to production today",
    commits: "1737b4f..83b531d",
    migrations: "0098, 0099, 0100",
    supported: true,
    sendsKey: true,
    why:
      "Eight named arguments including p_meta, and the same row predicate. Unchanged on " +
      "main since 1737b4f (`git log 1737b4f..HEAD -- app/api/public/enquiries/route.ts` is " +
      "empty), so every production deployment since then sends exactly this.",
    args: (p) => ({
      p_org_slug: "test-org-a",
      p_name: p.name,
      p_email: p.email,
      p_phone: "",
      p_message: p.message,
      p_property_ref: "",
      p_idempotency_key: p.key,
      p_meta: { source_page: "/contact", budget: "over_1m" },
    }),
    accepted: (a) => a.errorCode === null && rows(a).length > 0,
  },
];

/**
 * THE ORDER A RELEASE ACTUALLY HAPPENS IN, from HANDOFF.md §3 and the working
 * agreements: the hosted migration is applied BEFORE the merge that deploys the
 * application, and the marketing site deploys after the CRM. Each line names
 * the pairing that is live during that step — which is what has to be
 * compatible, and what nothing checked.
 */
export const ORDER_OF_DEPLOYMENT: Array<{ stage: string; pairing: string; covered: string }> = [
  {
    stage: "1. hosted migration applied, CRM not yet redeployed",
    pairing: "the CURRENTLY DEPLOYED CRM against the NEW database",
    covered: "meta-door (and row-door, one release further back)",
  },
  {
    stage: "2. CRM merged and deployed",
    pairing: "the new CRM against the new database",
    covered: "meta-door",
  },
  {
    stage: "3. gnk-web deployed",
    pairing: "the new site against the new CRM; the old site against the new CRM until it lands",
    covered:
      "gnk-web sends JSON the CRM's zod schema validates and ignores what it does not know; " +
      "an older site simply omits keys (idempotency_key, meta), which is row-door and boolean-door above",
  },
  {
    stage: "rollback of the CRM application",
    pairing: "an OLDER CRM against the NEW database",
    covered: "whichever contract that commit sends — supported only back to 1737b4f",
  },
];

/**
 * WHAT IS NOT SUPPORTED, said plainly so a release does not discover it.
 */
export const ROLLBACK_LIMITS: string[] = [
  "Rolling the CRM application back PAST 1737b4f against a database at 0096 or later re-opens the 2026-09-15 defect exactly: the boolean-door route commits a lead and answers the visitor 400 'Unknown org.'. It is the one application rollback that fails OPEN — a row is written and nobody is told. Roll the application back only to 1737b4f or later.",
  "Rolling the DATABASE back below 0098 while the current application is deployed is not supported either, but it fails CLOSED: PostgREST cannot resolve the eight-argument call, answers PGRST202, and the route returns 503 with nothing written. A visitor is asked to call instead; no lead is orphaned. This file probes that failure mode rather than standing up a second database at an older migration.",
  "A migration that changes this function's RETURN SHAPE is deploy-coupled and must not be applied to hosted ahead of the application. A change that only ADDS a parameter with a default is not (0098 is the worked example), and is the transition to prefer.",
];

export function compatibilityReport(
  outcomes: Array<{
    contract: string;
    appBelievesAccepted: boolean;
    leadsWritten: number;
    compatible: boolean;
  }>,
): string {
  const found = (id: string) => outcomes.find((o) => o.contract === id);
  const lines: string[] = [];
  lines.push("=".repeat(78));
  lines.push("ENQUIRY DOOR — RELEASE COMPATIBILITY REPORT");
  lines.push("=".repeat(78));
  lines.push("");
  lines.push("Database under test: the local Supabase stack, every migration in");
  lines.push("supabase/migrations/ applied by `npx supabase start`. Nothing hosted is");
  lines.push("contacted and no message is sent.");
  lines.push("");
  lines.push("-- APPLICATION CONTRACTS EXERCISED " + "-".repeat(43));
  for (const c of DOOR_CONTRACTS) {
    const o = found(c.id);
    const verdict = o
      ? o.compatible
        ? "COMPATIBLE"
        : "INCOMPATIBLE"
      : "not exercised";
    lines.push("");
    lines.push(`  ${c.id}  [${c.supported ? "supported stage" : "pinned incompatible"}] -> ${verdict}`);
    lines.push(`    commits    : ${c.commits}`);
    lines.push(`    migrations : ${c.migrations}`);
    lines.push(`    deployed as: ${c.appRange}`);
    if (o) {
      lines.push(
        `    observed   : the app would have answered ${o.appBelievesAccepted ? "202 accepted" : "a refusal"}; the database holds ${o.leadsWritten} lead(s)`,
      );
    }
    lines.push(`    why        : ${c.why}`);
  }
  lines.push("");
  lines.push("-- DEPLOYMENT ORDER " + "-".repeat(58));
  for (const s of ORDER_OF_DEPLOYMENT) {
    lines.push("");
    lines.push(`  ${s.stage}`);
    lines.push(`    live pairing: ${s.pairing}`);
    lines.push(`    covered by  : ${s.covered}`);
  }
  lines.push("");
  lines.push("-- ROLLBACK LIMITATIONS " + "-".repeat(54));
  for (const l of ROLLBACK_LIMITS) {
    lines.push("");
    for (const chunk of l.match(/.{1,74}(\s|$)/g) ?? [l]) lines.push(`  ${chunk.trimEnd()}`);
  }
  lines.push("");
  lines.push("=".repeat(78));
  return lines.join("\n");
}
