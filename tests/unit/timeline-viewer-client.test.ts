import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * A timeline's "current title" is read with the VIEWER's client, never the
 * system's (T-event-typed-text-shape). `documents_select` hides an admin_only
 * passport scan from agents and listing managers; read with the admin client,
 * its file name would print on every agent's contact timeline.
 *
 * The services pin that they use the client they are handed
 * (lib/services/event-context.test.ts, entity-timeline.test.ts), and the
 * database suite pins what RLS lets that client read. What neither can see is
 * a CALLER handing over the wrong client: the admin client has the same type,
 * the properties page holds one in scope, and every e2e signs in as an admin,
 * who may read every row anyway. So this walks the source: every
 * `readEntityTimeline({ viewer })` and `attachCurrentTitles(viewer, …)` outside
 * the services must pass a variable bound to `await createClient()` from
 * `@/lib/supabase/server` — the request's own session.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

type Site = { file: string; call: string; arg: string; ok: boolean };

function scan(file: string): Site[] {
  const text = readFileSync(file, "utf8");
  if (!/readEntityTimeline|attachCurrentTitles/.test(text)) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const rel = relative(root, file).replace(/\\/g, "/");

  // `createClient` must be the request-session factory, not some other import
  const importsSession = sf.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text === "@/lib/supabase/server" &&
      !!s.importClause?.namedBindings &&
      ts.isNamedImports(s.importClause.namedBindings) &&
      s.importClause.namedBindings.elements.some((e) => e.name.text === "createClient"),
  );
  const session = new Set<string>();
  const sites: Site[] = [];

  const isSession = (e: ts.Expression) => ts.isIdentifier(e) && session.has(e.text);

  const visit = (n: ts.Node) => {
    if (
      importsSession &&
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      ts.isAwaitExpression(n.initializer) &&
      ts.isCallExpression(n.initializer.expression) &&
      ts.isIdentifier(n.initializer.expression.expression) &&
      n.initializer.expression.expression.text === "createClient"
    ) {
      session.add(n.name.text);
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const name = n.expression.text;
      if (name === "readEntityTimeline" && n.arguments[0] && ts.isObjectLiteralExpression(n.arguments[0])) {
        const prop = n.arguments[0].properties.find(
          (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === "viewer",
        );
        const arg = prop ? prop.initializer : null;
        sites.push({ file: rel, call: name, arg: arg ? arg.getText(sf) : "(missing)", ok: !!arg && isSession(arg) });
      }
      if (name === "attachCurrentTitles" && n.arguments[0]) {
        const arg = n.arguments[0];
        // inside the reader itself the viewer is its own parameter, passed through
        const passThrough = rel === "lib/services/entity-timeline.ts" && arg.getText(sf) === "opts.viewer";
        sites.push({ file: rel, call: name, arg: arg.getText(sf), ok: passThrough || isSession(arg) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return sites;
}

describe("every timeline title lookup is handed the viewer's session client", () => {
  const sites = ["app", "components", "lib"].flatMap((d) => sources(join(root, d))).flatMap(scan);

  it("finds the call sites (a scanner that finds nothing proves nothing)", () => {
    // contacts 1, properties 2, deals 2, the admin feed 1, and the reader's own pass-through
    expect(sites.filter((s) => s.call === "readEntityTimeline").length).toBeGreaterThanOrEqual(5);
    expect(sites.filter((s) => s.call === "attachCurrentTitles").length).toBeGreaterThanOrEqual(2);
  });

  it("passes `await createClient()` from @/lib/supabase/server at each of them", () => {
    expect(sites.filter((s) => !s.ok), "a timeline title lookup handed something other than the session client").toEqual([]);
  });
});
