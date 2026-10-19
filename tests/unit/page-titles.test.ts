import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DEFAULT_TITLE, TITLE_TEMPLATE, templatedTitle } from "@/lib/constants/page-title";
import { parsePropertyFilters, propertiesViewTitle } from "@/lib/queries/properties-list";

/**
 * A08: every screen names itself in the browser tab. The root layout owns the
 * suffix (`title.template: "%s · GN REOS"`) and each module page states only
 * its own word, in a static `metadata` — so a row of tabs, the history and a
 * bookmark say which screen each is, and no page can add the suffix twice.
 *
 * DETAIL PAGES SAY A GENERIC WORD, NEVER A NAME. Tab titles land in the browser
 * history of a shared office machine; "Maria Ioannou" on a contact tab, or a
 * deal titled after its buyer, would sit there for the next person to read.
 * So contacts/[id], deals/[id] and viewings/[id] carry "Contact", "Deal",
 * "Viewing" — and no `generateMetadata`, the one place a name could be read
 * into the title. (properties/[id] names its REFERENCE, never its title or a
 * party: tests/unit/property-metadata.test.ts.)
 *
 * Read from the source with the TypeScript parser, the way the guard tests
 * here read every caller (timeline-viewer-client.test.ts): Next resolves the
 * metadata at request time, and what this pins is what each file declares.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const parse = (rel: string) => ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** The exported `metadata` object literal of a file, or null. */
function metadataOf(sf: ts.SourceFile): ts.ObjectLiteralExpression | null {
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === "metadata" && d.initializer && ts.isObjectLiteralExpression(d.initializer)) {
        return d.initializer;
      }
    }
  }
  return null;
}
function prop(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  const p = obj.properties.find(
    (x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && ts.isIdentifier(x.name) && x.name.text === name,
  );
  return p ? p.initializer : null;
}
/** The static string `title` a page declares, or null when it declares none (or not a plain string). */
function titleOf(rel: string): string | null {
  const meta = metadataOf(parse(rel));
  const t = meta ? prop(meta, "title") : null;
  return t && ts.isStringLiteral(t) ? t.text : null;
}
/** Does the file declare (or export) a `generateMetadata` — as a function or a const? */
function declaresGenerateMetadata(rel: string): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === "generateMetadata") {
      found = true;
    }
    if (ts.isExportSpecifier(n) && (n.name.text === "generateMetadata" || n.propertyName?.getText() === "generateMetadata")) found = true;
    ts.forEachChild(n, visit);
  };
  visit(parse(rel));
  return found;
}

const MODULE_PAGES: [string, string][] = [
  ["app/(app)/dashboard/page.tsx", "Dashboard"],
  ["app/(app)/leads/page.tsx", "Leads"],
  ["app/(app)/pipeline/page.tsx", "Pipeline"],
  ["app/(app)/deals/page.tsx", "Deals"],
  ["app/(app)/contacts/page.tsx", "Contacts"],
  ["app/(app)/viewings/page.tsx", "Viewings"],
  ["app/(app)/tasks/page.tsx", "Tasks"],
  ["app/(app)/keys/page.tsx", "Keys"],
  ["app/(app)/share-links/page.tsx", "Share links"],
  ["app/(app)/reports/page.tsx", "Reports"],
  ["app/(app)/calculators/page.tsx", "Calculators"],
  // every settings section, through its layout
  ["app/(app)/settings/layout.tsx", "Settings"],
];

const DETAIL_PAGES: [string, string][] = [
  ["app/(app)/contacts/[id]/page.tsx", "Contact"],
  ["app/(app)/deals/[id]/page.tsx", "Deal"],
  ["app/(app)/viewings/[id]/page.tsx", "Viewing"],
];

describe("the root layout owns the suffix", () => {
  it('title is { default: "GN Real Estate OS", template: "%s · GN REOS" }, from the constants DocumentTitle shares', () => {
    const meta = metadataOf(parse("app/layout.tsx"));
    expect(meta, "app/layout.tsx exports metadata").not.toBeNull();
    const title = prop(meta!, "title");
    expect(title && ts.isObjectLiteralExpression(title), "the title is an object, not a plain string").toBe(true);
    const obj = title as ts.ObjectLiteralExpression;
    // the layout names the shared constants (a literal here could drift from
    // the copy the client-side DocumentTitle applies)
    const name = (key: string) => {
      const v = prop(obj, key);
      return v && ts.isIdentifier(v) ? v.text : null;
    };
    expect(name("default")).toBe("DEFAULT_TITLE");
    expect(name("template")).toBe("TITLE_TEMPLATE");
    expect(read("app/layout.tsx")).toMatch(
      /import \{ DEFAULT_TITLE, TITLE_TEMPLATE \} from "@\/lib\/constants\/page-title";/,
    );
    expect(DEFAULT_TITLE).toBe("GN Real Estate OS");
    expect(TITLE_TEMPLATE).toBe("%s · GN REOS");
  });

  it("DocumentTitle's template is the layout's: the page's words, then the suffix — and a $ in the words is text", () => {
    expect(templatedTitle("Properties · Land")).toBe("Properties · Land · GN REOS");
    expect(templatedTitle("Properties · $& · $'")).toBe("Properties · $& · $' · GN REOS");
  });
});

describe("every module page names itself", () => {
  it.each(MODULE_PAGES)("%s → %s", (rel, want) => {
    expect(read(rel), `${rel} must be a server component to export metadata`).not.toMatch(/^\s*["']use client["']/);
    expect(titleOf(rel)).toBe(want);
  });
});

describe("a record page says what it is, never whose", () => {
  it.each(DETAIL_PAGES)("%s → %s, with no generateMetadata to read a name into it", (rel, want) => {
    expect(titleOf(rel)).toBe(want);
    expect(declaresGenerateMetadata(rel), `${rel} declares generateMetadata`).toBe(false);
  });

  it("the scanner sees a generateMetadata where there is one (it is not satisfiable by reading nothing)", () => {
    expect(declaresGenerateMetadata("app/(app)/properties/[id]/page.tsx")).toBe(true);
    expect(declaresGenerateMetadata("app/(app)/properties/page.tsx")).toBe(true);
  });
});

// The rest of the signed-in screens, each a generic word (the integration
// review of 2026-10-19 found these eight reading the bare default).
const OTHER_PAGES: [string, string][] = [
  ["app/(app)/contacts/new/page.tsx", "New contact"],
  ["app/(app)/properties/new/page.tsx", "New property"],
  ["app/(app)/properties/worklist/page.tsx", "Listing worklist"],
  ["app/(app)/properties/[id]/units/page.tsx", "Units"],
  ["app/(app)/reports/commission-evidence/page.tsx", "Commission evidence"],
  ["app/(app)/reports/performance/page.tsx", "Performance"],
  ["app/(app)/security/page.tsx", "Security"],
  ["app/(app)/viewings/[id]/sign/page.tsx", "Sign viewing slip"],
];

const files = (dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) return files(rel);
    return /^(page|layout)\.tsx$/.test(name) ? [rel] : [];
  });

describe("every other signed-in screen names itself too", () => {
  it.each(OTHER_PAGES)("%s → %s, with no generateMetadata", (rel, want) => {
    expect(titleOf(rel)).toBe(want);
    expect(declaresGenerateMetadata(rel), `${rel} declares generateMetadata`).toBe(false);
  });

  it("no page under app/(app) is left on the bare default: each has a title of its own or from a layout above it", () => {
    const titled = (rel: string) => titleOf(rel) !== null || declaresGenerateMetadata(rel);
    const untitled: string[] = [];
    for (const rel of files("app/(app)").filter((f) => f.endsWith("/page.tsx"))) {
      let dir = dirname(rel);
      let ok = titled(rel);
      while (!ok && dir.startsWith("app/(app)/")) {
        const layout = `${dir}/layout.tsx`;
        ok = files(dir).includes(layout) && titleOf(layout) !== null;
        dir = dirname(dir);
      }
      if (!ok) untitled.push(rel);
    }
    expect(untitled).toEqual([]);
  });
});

describe("no page adds the suffix itself", () => {

  it("no title literal under app/ but the root layout's carries the product name", () => {
    const offenders: string[] = [];
    for (const rel of files("app")) {
      if (rel === "app/layout.tsx") continue;
      const sf = parse(rel);
      const visit = (n: ts.Node) => {
        if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && ["title", "absolute", "default"].includes(n.name.text)) {
          const v = n.initializer;
          const words = ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v) ? v.text : ts.isTemplateExpression(v) ? v.getText(sf) : "";
          if (/GN REOS|GN Real Estate OS/.test(words)) offenders.push(`${relative(root, join(root, rel))}: ${words}`);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(offenders).toEqual([]);
    expect(files("app").length, "the walk found the pages").toBeGreaterThan(30);
  });

  it("the properties list's and map's generated titles are their own words only", () => {
    const places = { districts: [], areas: [] };
    expect(propertiesViewTitle("Properties", parsePropertyFilters({}), places)).toBe("Properties");
    expect(propertiesViewTitle("Properties map", parsePropertyFilters({ type: "villa" }), places)).toBe("Properties map · Villa");
  });

  it("the buyer-facing share page keeps its neutral title without the internal tool's name", () => {
    const sf = parse("app/p/[token]/page.tsx");
    expect(sf.getText()).toMatch(/title:\s*\{\s*absolute:\s*"Property information"\s*\}/);
  });
});
