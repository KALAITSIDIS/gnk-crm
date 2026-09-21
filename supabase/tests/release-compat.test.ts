import { writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ORG_A, SUPABASE_URL, ensureTestOrg, serviceClient } from "./helpers";
import {
  DOOR_CONTRACTS,
  ORDER_OF_DEPLOYMENT,
  ROLLBACK_LIMITS,
  type DoorContract,
  type DoorAnswer,
  compatibilityReport,
} from "./release-compat-contracts";

/**
 * THE RELEASE-COMPATIBILITY CHECK — does the CRM that is DEPLOYED still work
 * against the database we are about to apply?
 *
 * 2026-09-15, ~17:57Z to ~18:38Z (HANDOFF.md). Migration 0096 changed
 * `submit_public_enquiry` from `returns boolean` to `returns table (lead_id,
 * lead_org_id, replayed)` and was applied to hosted BEFORE the CRM that
 * understood it was deployed — which is the documented order, and the right
 * one. For those forty-one minutes the deployed route still read `data !== true`,
 * so PostgREST's array of one row was not `true`, and every valid enquiry was
 * answered `400 "Unknown org."` AFTER the function had COMMITTED the lead. A
 * saved lead, no desk alert, and a duplicate if the visitor tried again. The
 * record identifies exactly ONE lead in that window, this project's own probe;
 * no visitor was lost, and nothing here should be read as saying otherwise.
 *
 * NOTHING IN EITHER REPOSITORY REHEARSED THAT. Both CI workflows build ONE
 * application against ONE database — the current commit against every
 * migration — which is the combination that is never in production during a
 * release. `npx supabase start` applies the whole migration set, so the only
 * skew that is ever exercised is none.
 *
 * WHAT THIS FILE DOES. For each APPLICATION CONTRACT — the exact RPC call a
 * given range of deployed commits makes, and the exact predicate it applies to
 * the answer, both lifted from that commit's route — it:
 *
 *   1. issues the call over real PostgREST against the local stack, which has
 *      every migration applied;
 *   2. applies that version's own predicate to the answer, giving what the app
 *      WOULD have told the visitor;
 *   3. asks the database, independently, whether a lead actually exists;
 *   4. calls the pair INCOMPATIBLE when they disagree.
 *
 * Step 4 is the incident, stated generally: the app said no and the row was
 * there. It catches the mirror image too — the app says yes and nothing was
 * written — which is the failure nobody has had yet.
 *
 * THE DETECTOR MUST REJECT SOMETHING, AND THE TEST OF THAT MUST BE GREEN. The
 * 2026-09-15 pairing is kept as `boolean-door` and asserted to come back
 * INCOMPATIBLE. A test that asserts a rejection passes normally; the pipeline is
 * never left deliberately red.
 *
 * WHAT IT DOES NOT DO. It does not stand up a second database at an older
 * migration, so "the current app against an OLDER database" — a database
 * rollback — is probed for its FAILURE MODE rather than reproduced: see
 * "a database that has not learned p_meta" below. The honest summary of that
 * case is in ROLLBACK_LIMITS and is printed in the report.
 *
 * SAFETY. Local stack only, asserted below; synthetic org and synthetic
 * contacts; every lead it writes is deleted afterwards (its events stay, as
 * every event does; since 0101 the lead's notification_jobs row cascades with
 * it). It sends no mail: the database function writes the desk alert's ROW
 * (0101), and the e-mail is the worker's — reached from the route's after()
 * and the sweep, never from here.
 */
const svc = (): SupabaseClient => serviceClient();
const admin = svc();
const run = randomBytes(4).toString("hex");
const madeLeads: string[] = [];

/** A synthetic submission, marked so the database can be asked about it alone. */
interface Probe {
  marker: string;
  name: string;
  email: string;
  message: string;
  key: string;
}
const probe = (label: string): Probe => {
  const marker = `ZZTEST-relcompat-${run}-${label}`;
  return {
    marker,
    name: `Release Compat ${marker}`,
    email: `${marker}@example.invalid`.toLowerCase(),
    message: `release-compatibility probe ${marker}`,
    key: `relc-${run}-${label}`.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 64),
  };
};

const ORG_SLUG = "test-org-a";

beforeAll(async () => {
  /* NEVER A HOSTED PROJECT. This suite WRITES leads, and the same file would
     write them into production if someone exported a hosted URL before running
     it. A local stack is 127.0.0.1/localhost and nothing else. */
  const host = new URL(SUPABASE_URL).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(
      `release-compat writes leads and must only ever run against a local stack; got ${SUPABASE_URL}`,
    );
  }
  await ensureTestOrg(admin, ORG_A, "Test Org A", ORG_SLUG);
});

afterAll(async () => {
  if (!madeLeads.length) return;
  // tasks first: the lead SLA sweep (0098) can attach one between calls, and a
  // refused delete would leave residue behind a green suite (RLS test 38's lesson)
  const { error: taskErr } = await admin.from("tasks").delete().in("lead_id", madeLeads);
  if (taskErr) throw new Error(`release-compat cleanup (tasks): ${taskErr.message}`);
  const { error } = await admin.from("leads").delete().in("id", madeLeads);
  if (error) throw new Error(`release-compat cleanup (leads): ${error.message}`);
});

/** Everything the database will say about one probe, asked independently of the app. */
async function leadsFor(p: Probe) {
  const { data, error } = await admin
    .from("leads")
    .select("id, org_id, source, status, idempotency_key, criteria")
    .eq("org_id", ORG_A)
    .like("message", `%${p.marker}%`);
  if (error) throw new Error(`reading back ${p.marker}: ${error.message}`);
  for (const l of data ?? []) if (!madeLeads.includes(l.id)) madeLeads.push(l.id);
  return data ?? [];
}

/** Issue one contract's call exactly as that range of commits issues it. */
async function knock(c: DoorContract, p: Probe): Promise<DoorAnswer> {
  const { data, error } = await admin.rpc("submit_public_enquiry", c.args(p));
  return { data, errorCode: error?.code ?? null, errorMessage: error?.message ?? null };
}

const outcomes: Array<{
  contract: string;
  appBelievesAccepted: boolean;
  leadsWritten: number;
  compatible: boolean;
}> = [];

describe("every supported deployment stage accepts an enquiry and makes exactly one lead", () => {
  for (const c of DOOR_CONTRACTS) {
    it(`${c.id} — ${c.appRange}`, async () => {
      const p = probe(c.id);
      const answer = await knock(c, p);
      const appBelievesAccepted = c.accepted(answer);
      const written = await leadsFor(p);

      /* THE DETECTOR. Not "did it work" — "does the application's account of
         what happened match the database's". Those two disagreeing is the
         whole of the 2026-09-15 defect and is the only thing that cannot be
         seen from either side alone. */
      const compatible = appBelievesAccepted === written.length > 0;
      outcomes.push({
        contract: c.id,
        appBelievesAccepted,
        leadsWritten: written.length,
        compatible,
      });

      expect(compatible, c.supported
        ? `${c.id}: the app would have told the visitor ${appBelievesAccepted ? "accepted" : "refused"} while the database holds ${written.length} lead(s)`
        : `${c.id} is pinned as INCOMPATIBLE and must stay that way`,
      ).toBe(c.supported);

      if (c.supported) {
        expect(written, `${c.id}: exactly one lead, not none and not two`).toHaveLength(1);
        expect(written[0]!.source).toBe("website");
        expect(written[0]!.status).toBe("new");
      }
    });
  }

  it("the detector rejects the 2026-09-15 pairing, and would have said so before the apply", () => {
    // The regression case, stated as an assertion about the DETECTOR rather
    // than about the door — which is what lets this test be green.
    const incident = outcomes.find((o) => o.contract === "boolean-door");
    expect(incident, "the historical contract was exercised").toBeDefined();
    expect(incident!.compatible, "it must be reported incompatible").toBe(false);
    expect(
      incident!.appBelievesAccepted,
      "the app concluded the org was unknown — a 400 to the visitor",
    ).toBe(false);
    expect(
      incident!.leadsWritten,
      "while the function had already committed the lead: saved, and the desk never told",
    ).toBe(1);
  });
});

describe("a repeat with the same key is the same enquiry, on every supported stage", () => {
  for (const c of DOOR_CONTRACTS.filter((x) => x.supported && x.sendsKey)) {
    it(`${c.id} writes once and answers twice`, async () => {
      const p = probe(`idem-${c.id}`);
      const first = await knock(c, p);
      const again = await knock(c, p);

      expect(c.accepted(first), "the first post is accepted").toBe(true);
      expect(c.accepted(again), "so is the second — the visitor is not punished for retrying").toBe(
        true,
      );

      const written = await leadsFor(p);
      expect(written, "one lead for one key").toHaveLength(1);
      expect(written[0]!.idempotency_key).toBe(p.key);

      /* AND NO SECOND ALERT ATTEMPT. The route decides that from `replayed`
         (app/api/public/enquiries/route.ts: a replay returns 202 and skips
         after()), so what the database owes it is an honest flag. `created`
         events are the durable proof that the second call wrote nothing at
         all. */
      const rows = (again.data ?? []) as Array<{ replayed?: boolean }>;
      expect(rows[0]?.replayed, "the door tells the route this was a replay").toBe(true);

      const { count } = await admin
        .from("events")
        .select("id", { count: "exact", head: true })
        .eq("entity_id", written[0]!.id)
        .eq("event_type", "created");
      expect(count, "one created event — the replay wrote nothing").toBe(1);
    });
  }
});

describe("refusals keep their meaning across the stages", () => {
  for (const c of DOOR_CONTRACTS.filter((x) => x.supported)) {
    it(`${c.id}: an unknown org refuses and writes nothing`, async () => {
      const p = probe(`badorg-${c.id}`);
      const bad = await admin.rpc("submit_public_enquiry", {
        ...c.args(p),
        p_org_slug: `no-such-org-${run}`,
      });
      expect(bad.error, "a refusal is data, never a database error").toBeNull();
      expect(c.accepted({ data: bad.data, errorCode: null, errorMessage: null })).toBe(false);
      expect(await leadsFor(p), "nothing written").toHaveLength(0);
    });

    it(`${c.id}: no way to reply refuses, and it is a refusal not an error`, async () => {
      const p = probe(`noreply-${c.id}`);
      const res = await admin.rpc("submit_public_enquiry", {
        ...c.args(p),
        p_email: "",
        p_phone: "",
      });
      expect(res.error, "a refusal is data, never a database error").toBeNull();
      expect(c.accepted({ data: res.data, errorCode: null, errorMessage: null })).toBe(false);
      expect(await leadsFor(p), "nothing written").toHaveLength(0);
    });
  }
});

describe("the unsupported direction, named rather than assumed", () => {
  it("a database that has not learned p_meta refuses the current call, before writing anything", async () => {
    /* A DATABASE ROLLBACK, probed for its failure MODE. Standing up a second
       stack at 0096 is not worth a CI job, and creating a second overload of
       submit_public_enquiry here would be actively dangerous — 0098 asserts
       there is exactly one, and an ambiguous overload would break the live
       door. So the question asked is the one that decides whether the failure
       is safe: when PostgREST cannot resolve the argument list the app sends,
       does it refuse BEFORE the function runs?
       `p_not_a_real_parameter` stands in for `p_meta` against a pre-0098
       database — same resolution failure, same code. */
    const p = probe("rollback");
    const res = await admin.rpc("submit_public_enquiry", {
      ...DOOR_CONTRACTS.find((c) => c.id === "meta-door")!.args(p),
      p_not_a_real_parameter: "x",
    });
    expect(res.error, "PostgREST refuses an unresolvable signature").not.toBeNull();
    expect(res.error!.code, "PGRST202: no such function in the schema cache").toBe("PGRST202");
    expect(
      await leadsFor(p),
      "and it fails CLOSED — the route answers 503 and no lead exists to be orphaned",
    ).toHaveLength(0);
  });

  it("only one submit_public_enquiry exists, so no call can silently pick another", async () => {
    // An overload is how an arity check stops meaning anything: two functions
    // with the same name and different signatures make "which one answered"
    // a question nobody asks. 0098 asserts this at apply time; this asserts it
    // on every run, which is when a later migration would break it.
    const { data, error } = await admin.rpc("submit_public_enquiry", {
      p_org_slug: ORG_SLUG,
      p_name: "",
    });
    expect(error?.code ?? "resolved", "a two-argument call resolves or is refused, never ambiguous")
      .not.toBe("PGRST203");
    void data;
  });
});

/**
 * THE REPORT. Exact commits, migration ranges, deployment order and rollback
 * limits, written where CI can print it — the acceptance criterion this whole
 * file is measured against, and the thing that makes it reviewable rather than
 * merely green.
 */
afterAll(() => {
  const report = compatibilityReport(outcomes);
  writeFileSync("release-compat-report.txt", report, "utf-8");
  console.log(`\n${report}`);
});

describe("the report says what was actually exercised", () => {
  it("names every contract, its commits and its migration range", () => {
    const report = compatibilityReport(outcomes);
    for (const c of DOOR_CONTRACTS) {
      expect(report).toContain(c.id);
      expect(report, `${c.id} names the commits it stands for`).toContain(c.commits);
      expect(report, `${c.id} names the migrations it was written against`).toContain(c.migrations);
    }
    for (const stage of ORDER_OF_DEPLOYMENT) expect(report).toContain(stage.stage);
    for (const limit of ROLLBACK_LIMITS) expect(report).toContain(limit.slice(0, 40));
  });
});
