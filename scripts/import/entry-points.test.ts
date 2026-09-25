import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The importers' ENTRY POINTS, run as the operator runs them (plain Node,
 * type stripping), against a stand-in for Supabase that records every
 * request it is sent (2026-09-23). A malformed file must stop the run before
 * the first write of ANY kind — an owner contact, an area, a property, a
 * mandate, an `imported` event — in the dry run and the live run alike, and
 * a malformed LAST row must stop the rows before it too.
 *
 * The positive controls prove the instrument: the same stand-in, handed a
 * well-formed file on a live run, sees every one of those writes. Without
 * them "no write was recorded" could only mean the recorder was deaf.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const REPORTS = join(HERE, "reports");
const ORG = "00000000-0000-4000-8000-0000000000aa";
const ROW_ID = "00000000-0000-4000-8000-0000000000bb";

type Seen = { method: string; path: string; body: string };
let server: Server;
let url = "";
let seen: Seen[] = [];
/** the row a single-row read of `properties` answers with (media.mts looks its listing up) */
let propertyRow: Record<string, unknown> | null = null;
const writes = () => seen.filter((r) => r.method !== "GET" && r.method !== "HEAD");
const written = (table: string) => writes().some((r) => r.path === `/rest/v1/${table}`);

beforeAll(async () => {
  // Just enough PostgREST for the importers to run a valid file end to end:
  // the one district they look up, empty results for every other read, and an
  // id for every insert.
  server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const entry: Seen = { method: req.method ?? "", path, body: "" };
    seen.push(entry);
    req.setEncoding("latin1");
    req.on("data", (chunk: string) => (entry.body += chunk));
    req.on("end", () => {
      const one = String(req.headers.accept ?? "").includes("vnd.pgrst.object");
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" || req.method === "HEAD") {
        const list =
          path === "/rest/v1/districts"
            ? [{ id: "district-paf", code: "PAF" }]
            : path === "/rest/v1/properties" && propertyRow
              ? [propertyRow] // maybeSingle() asks for a list and picks the row itself
              : [];
        res.end(JSON.stringify(one ? (path === "/rest/v1/properties" ? propertyRow : null) : list));
      } else if (path.startsWith("/rest/v1/rpc/")) {
        res.end(JSON.stringify("PAF9999"));
      } else {
        res.statusCode = 201;
        res.end(JSON.stringify(one ? { id: ROW_ID } : [{ id: ROW_ID }]));
      }
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolveClose) => server.close(resolveClose));
});

let dir: string;
let n = 0;
beforeEach(() => {
  seen = [];
  propertyRow = null;
  dir = mkdtempSync(join(tmpdir(), "import-entry-"));
  return () => rmSync(dir, { recursive: true, force: true });
});

/** A CSV in a temp dir, under a name no other run shares (the report is named after it). */
function csv(text: string): { path: string; base: string } {
  const base = `zz-entry-${process.pid}-${++n}`;
  const path = join(dir, `${base}.csv`);
  writeFileSync(path, text);
  return { path, base };
}

const reportsFor = (base: string) => readdirSync(REPORTS).filter((f) => f.includes(base));

function run(script: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join(HERE, script), ...args], {
      cwd: ROOT,
      env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 45_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
  });
}

const PROPERTY_HEADER =
  "reference,property_type,district_code,area,owner_phone,owner_name,mandate_type,asking_price,covered_area_sqm";
const PROPERTY_ROWS = [
  'ZZCSV1,apartment,PAF,Zz Csv Area,99 12 34 56,Zz Owner,exclusive,"1,250,000",85.5',
  "ZZCSV2,villa,PAF,Zz Csv Area,,,,650000,180",
];
// valid rows, then a LAST row whose unquoted 1,250,000 makes two surplus cells
const PROPERTY_MALFORMED = [PROPERTY_HEADER, ...PROPERTY_ROWS, "ZZCSV3,apartment,PAF,,,,,1,250,000,85.5"].join("\n");

const CONTACT_HEADER = "first_name,last_name,phone,email,budget_min,consent_marketing";
const CONTACT_ROWS = ['Zz,Csvtest,99 12 34 57,zz.csv@example.com,"250,000",true'];
// a valid row, then a LAST row whose quote never closes
const CONTACT_MALFORMED = [CONTACT_HEADER, ...CONTACT_ROWS, 'Zz,"Unclosed,99 12 34 58,zz2@example.com,,false'].join("\n");

describe("a malformed file stops every importer before its first write", () => {
  it.each([
    ["live", []],
    ["dry run", ["--dry-run"]],
    ["--allow-extra", ["--allow-extra"]],
  ])("properties.mts (%s)", async (_mode, extra) => {
    const { path, base } = csv(PROPERTY_MALFORMED);
    const r = await run("properties.mts", ["--file", path, "--org", ORG, "--batch", base, ...extra]);
    expect(r.stderr).toContain("line 4: expected 9 cells (one per header column), found 11");
    expect(r.code).toBe(1);
    expect(writes()).toEqual([]);
    expect(reportsFor(base)).toEqual([]);
  }, 60_000);

  it("properties.mts refuses a repeated header even with --allow-extra", async () => {
    const { path, base } = csv(
      "reference,property_type,district_code,asking_price,asking_price\nZZCSV1,apartment,PAF,250000,150000\n",
    );
    const r = await run("properties.mts", ["--file", path, "--org", ORG, "--batch", base, "--allow-extra"]);
    expect(r.stderr).toContain('column "asking_price" appears more than once');
    expect(r.code).toBe(1);
    expect(writes()).toEqual([]);
  }, 60_000);

  it.each([
    ["live", []],
    ["dry run", ["--dry-run"]],
  ])("contacts.mts (%s)", async (_mode, extra) => {
    const { path, base } = csv(CONTACT_MALFORMED);
    const r = await run("contacts.mts", ["--file", path, "--org", ORG, "--batch", base, ...extra]);
    expect(r.stderr).toContain("line 3, column 2 (last_name): the double quote that opens this value is never closed");
    expect(r.code).toBe(1);
    expect(writes()).toEqual([]);
    expect(reportsFor(base)).toEqual([]);
  }, 60_000);

  it("media.mts reads the same properties file and refuses it the same way", async () => {
    const { path, base } = csv("reference,photo_folder\nZZCSV1,zz-none\nZZCSV2,zz,none\n");
    const r = await run("media.mts", ["--file", path, "--org", ORG]);
    expect(r.stderr).toContain("line 3: expected 2 cells (one per header column), found 3");
    expect(r.code).toBe(1);
    expect(writes()).toEqual([]);
    expect(reportsFor(base)).toEqual([]);
  }, 60_000);
});

describe("positive controls — the recorder sees every write a well-formed file makes", () => {
  it("properties.mts live: area, owner contact, property, mandate and imported events", async () => {
    const { path, base } = csv([PROPERTY_HEADER, ...PROPERTY_ROWS].join("\n"));
    try {
      const r = await run("properties.mts", ["--file", path, "--org", ORG, "--batch", base]);
      expect(r.code, r.stderr).toBe(0);
      for (const table of ["areas", "contacts", "properties", "mandates", "events"]) {
        expect(written(table), `a write to ${table}`).toBe(true);
      }
    } finally {
      for (const f of reportsFor(base)) unlinkSync(join(REPORTS, f));
    }
  }, 60_000);

  it("contacts.mts live: contact, imported + consent events, saved search", async () => {
    const { path, base } = csv([CONTACT_HEADER, ...CONTACT_ROWS].join("\n"));
    try {
      const r = await run("contacts.mts", ["--file", path, "--org", ORG, "--batch", base]);
      expect(r.code, r.stderr).toBe(0);
      for (const table of ["contacts", "events", "buyer_requirements"]) {
        expect(written(table), `a write to ${table}`).toBe(true);
      }
    } finally {
      for (const f of reportsFor(base)) unlinkSync(join(REPORTS, f));
    }
  }, 60_000);
});

/**
 * T-imported-identity-shape: an imported person is named on their ROW and
 * nowhere in the chain. Until this change contacts.mts logged `imported` with
 * `{ name }` (first + last name, else the company) and properties.mts logged
 * the owner contact it creates with `{ name: name ?? phone, as: "owner" }` —
 * identity in an append-only chain that neither erasure nor an Article 16
 * correction can reach (the T-merged-event-ids-only rule).
 *
 * Checked on the exact request bodies the real scripts send. Case-SENSITIVE
 * on distinctive words: the kept values include `as: "owner"`, the
 * `zz-entry-…` batch and the ZZ references, which a case-folded check of
 * "Owner" or "Zz" would trip on.
 */
describe("the importers name a person on the row, never in the chain (T-imported-identity-shape)", () => {
  const eventBodies = () =>
    writes()
      .filter((w) => w.path === "/rest/v1/events")
      .map((w) => JSON.parse(w.body) as Record<string, unknown>);
  const importedEvents = () => eventBodies().filter((e) => e.event_type === "imported");

  it("contacts.mts live: the contact row carries the name; its imported event is { source, batch }", async () => {
    const { path, base } = csv(
      [
        "first_name,last_name,phone,email,budget_min,consent_marketing",
        "Zenobia,Quillfeather,99 44 55 66,zq.import@example.com,,true",
      ].join("\n"),
    );
    try {
      const r = await run("contacts.mts", ["--file", path, "--org", ORG, "--batch", base]);
      expect(r.code, r.stderr).toBe(0);

      // positive control: the name and the number really went to the ROW
      const row = JSON.parse(writes().find((w) => w.path === "/rest/v1/contacts")!.body) as Record<string, unknown>;
      expect(row).toMatchObject({ first_name: "Zenobia", last_name: "Quillfeather", phone_e164: "+35799445566" });

      const imported = importedEvents();
      expect(imported).toHaveLength(1);
      expect(imported[0]).toMatchObject({ actor_id: null, entity_type: "contact", entity_id: ROW_ID, event_type: "imported" });
      expect(imported[0].payload).toEqual({ source: "csv_import", batch: base });

      const chain = JSON.stringify(eventBodies());
      for (const word of ["Zenobia", "Quillfeather", "99445566", "99 44 55 66", "zq.import", "example.com"]) {
        expect(chain, `"${word}" reached the chain`).not.toContain(word);
      }
    } finally {
      for (const f of reportsFor(base)) unlinkSync(join(REPORTS, f));
    }
  }, 60_000);

  it("contacts.mts live: a company-only row is not named in the chain either", async () => {
    const { path, base } = csv(["company_name,phone", "Quillfeather Holdings Test Ltd,99 44 55 67"].join("\n"));
    try {
      const r = await run("contacts.mts", ["--file", path, "--org", ORG, "--batch", base]);
      expect(r.code, r.stderr).toBe(0);
      expect(importedEvents().map((e) => e.payload)).toEqual([{ source: "csv_import", batch: base }]);
      expect(JSON.stringify(eventBodies())).not.toContain("Quillfeather");
    } finally {
      for (const f of reportsFor(base)) unlinkSync(join(REPORTS, f));
    }
  }, 60_000);

  it("properties.mts live: the owner row carries the name; the owner's imported event is { source, as, batch }", async () => {
    const { path, base } = csv(
      [PROPERTY_HEADER, 'ZZCSVID1,apartment,PAF,Zz Csv Area,99 77 88 99,Andreas Oldowner,exclusive,"250,000",85'].join("\n"),
    );
    try {
      const r = await run("properties.mts", ["--file", path, "--org", ORG, "--batch", base]);
      expect(r.code, r.stderr).toBe(0);

      const owner = JSON.parse(writes().find((w) => w.path === "/rest/v1/contacts")!.body) as Record<string, unknown>;
      expect(owner).toMatchObject({ first_name: "Andreas Oldowner", phone_e164: "+35799778899", contact_types: ["owner"] });

      const byEntity = Object.fromEntries(importedEvents().map((e) => [e.entity_type as string, e.payload]));
      expect(Object.keys(byEntity).sort()).toEqual(["contact", "mandate", "property"]);
      expect(byEntity.contact).toEqual({ source: "csv_import", as: "owner", batch: base });
      // the office's own code stays: it is not a person, and the property line prints it
      expect(byEntity.mandate).toEqual({ source: "csv_import", property: "ZZCSVID1", batch: base });
      expect(byEntity.property).toMatchObject({ source: "csv_import", reference: "ZZCSVID1", batch: base });
      expect(Object.keys(byEntity.property as object).sort()).toEqual(["batch", "reference", "score", "source", "visibility"]);

      const chain = JSON.stringify(eventBodies());
      for (const word of ["Andreas", "Oldowner", "99778899", "99 77 88 99"]) {
        expect(chain, `"${word}" reached the chain`).not.toContain(word);
      }
    } finally {
      for (const f of reportsFor(base)) unlinkSync(join(REPORTS, f));
    }
  }, 60_000);
});

describe("media.mts logs a photo by id and digest, never by its file name (T-media-file-name-shape)", () => {
  it("live: the row and the media_uploaded event carry the digest of the file's bytes, and no word of its name", async () => {
    const root = join(dir, "media-root");
    const folder = join(root, "zz-photos");
    mkdirSync(folder, { recursive: true });
    const image = await sharp({ create: { width: 48, height: 32, channels: 3, background: { r: 90, g: 60, b: 30 } } })
      .jpeg()
      .toBuffer();
    // a folder name a person gave it — none of it may reach the chain
    writeFileSync(join(folder, "Andreou Kyriakos villa front 99111222.jpg"), image);
    const digest = createHash("sha256").update(image).digest("hex");
    propertyRow = { id: "prop-media-1", org_id: ORG, visibility: "draft" };
    const { path, base } = csv("reference,photo_folder\nZZMEDIA1,zz-photos\n");
    try {
      const r = await run("media.mts", ["--file", path, "--org", ORG, "--media-root", root]);
      expect(r.code, r.stderr).toBe(0);

      const eventWrites = writes().filter((w) => w.path === "/rest/v1/events");
      expect(eventWrites).toHaveLength(1);
      const event = JSON.parse(eventWrites[0].body) as Record<string, unknown>;
      expect(event).toMatchObject({ entity_type: "property", entity_id: "prop-media-1", event_type: "media_uploaded" });
      expect(event.payload).toEqual({ media_id: ROW_ID, watermarked: false, content_sha256: digest, source: "import_script" });
      for (const word of ["Andreou", "Kyriakos", "villa front", "99111222", ".jpg"]) {
        expect(eventWrites[0].body, `the file name's "${word}" reached the chain`).not.toContain(word);
      }

      // one digest, the same fact on the row
      const rowWrite = writes().find((w) => w.path === "/rest/v1/property_media");
      expect(JSON.parse(rowWrite!.body)).toMatchObject({ content_sha256: digest, kind: "photo" });
    } finally {
      for (const f of reportsFor(base)) unlinkSync(join(REPORTS, f));
    }
  }, 60_000);
});
