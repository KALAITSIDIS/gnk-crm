import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
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
  it('title is { default: "GN Real Estate OS", template: "%s · GN REOS" }', () => {
    const meta = metadataOf(parse("app/layout.tsx"));
    expect(meta, "app/layout.tsx exports metadata").not.toBeNull();
    const title = prop(meta!, "title");
    expect(title && ts.isObjectLiteralExpression(title), "the title is an object, not a plain string").toBe(true);
    const obj = title as ts.ObjectLiteralExpression;
    const text = (name: string) => {
      const v = prop(obj, name);
      return v && ts.isStringLiteral(v) ? v.text : null;
    };
    expect(text("default")).toBe("GN Real Estate OS");
    expect(text("template")).toBe("%s · GN REOS");
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

describe("no page adds the suffix itself", () => {
  const files = (dir: string): string[] =>
    readdirSync(join(root, dir)).flatMap((name) => {
      const rel = `${dir}/${name}`;
      if (statSync(join(root, rel)).isDirectory()) return files(rel);
      return /^(page|layout)\.tsx$/.test(name) ? [rel] : [];
    });

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
