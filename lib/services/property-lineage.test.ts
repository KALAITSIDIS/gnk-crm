import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessLineage,
  kindLabel,
  matrixParent,
  needsGrandparent,
  type LineageNode,
} from "./property-lineage";

/**
 * A05: the hierarchy told from parent_id and kind — and every way the data can
 * disagree with the model said rather than guessed around.
 */

const node = (over: Partial<LineageNode> & Pick<LineageNode, "id" | "kind">): LineageNode => ({
  reference: over.id.toUpperCase(),
  title: null,
  visibility: "private",
  parent_id: null,
  ...over,
});

const found = (n: LineageNode) => ({ state: "found" as const, node: n });

const PROJECT = node({ id: "proj", kind: "project", reference: "PAF0002" });
const PHASE = node({ id: "ph1", kind: "phase", reference: "PAF0002-P1", parent_id: "proj" });

describe("kindLabel", () => {
  it("says each kind in words, and a kind the enum grows as itself", () => {
    expect(kindLabel("unit")).toBe("Unit");
    expect(kindLabel("phase")).toBe("Phase");
    expect(kindLabel("project")).toBe("Project");
    expect(kindLabel("standalone")).toBe("Standalone");
    expect(kindLabel("land_parcel")).toBe("Land parcel");
  });
});

describe("assessLineage — the model's own shapes", () => {
  it("a standalone or a project with no parent has an empty trail and no issue", () => {
    expect(assessLineage({ id: "s", kind: "standalone", parent_id: null })).toEqual({ chain: [], issue: null });
    expect(assessLineage({ id: "p", kind: "project", parent_id: null })).toEqual({ chain: [], issue: null });
  });

  it("unit → project", () => {
    const l = assessLineage({ id: "u", kind: "unit", parent_id: "proj" }, found(PROJECT));
    expect(l).toEqual({ chain: [PROJECT], issue: null });
  });

  it("unit → phase → project, root first", () => {
    const l = assessLineage({ id: "u", kind: "unit", parent_id: "ph1" }, found(PHASE), found(PROJECT));
    expect(l.chain.map((n) => n.id)).toEqual(["proj", "ph1"]);
    expect(l.issue).toBeNull();
  });

  it("phase → project", () => {
    const l = assessLineage({ id: "ph1", kind: "phase", parent_id: "proj" }, found(PROJECT));
    expect(l).toEqual({ chain: [PROJECT], issue: null });
  });
});

describe("assessLineage — anomalies are said, never guessed", () => {
  it("unit → standalone: unexpected parent kind, the parent still shown as recorded", () => {
    const standalone = node({ id: "s", kind: "standalone", reference: "PAF0100" });
    const l = assessLineage({ id: "u", kind: "unit", parent_id: "s" }, found(standalone));
    expect(l.chain).toEqual([standalone]);
    expect(l.issue?.code).toBe("unexpected_parent_kind");
    expect(l.issue?.text).toBe(
      "A unit belongs to a project or a phase, but this one is recorded under PAF0100, a standalone. Tell an admin.",
    );
  });

  it("unit → unit: unexpected parent kind", () => {
    const other = node({ id: "u2", kind: "unit", parent_id: "proj" });
    const l = assessLineage({ id: "u", kind: "unit", parent_id: "u2" }, found(other));
    expect(l.issue?.code).toBe("unexpected_parent_kind");
  });

  it("phase → phase: unexpected parent kind (one level only, BACKLOG 11)", () => {
    const l = assessLineage({ id: "ph2", kind: "phase", parent_id: "ph1" }, found(PHASE));
    expect(l.issue?.code).toBe("unexpected_parent_kind");
    expect(l.issue?.text).toContain("A phase belongs to a project");
  });

  it("a project or a standalone with a parent: unexpected", () => {
    const projectWithParent = assessLineage({ id: "p2", kind: "project", parent_id: "proj" }, found(PROJECT));
    expect(projectWithParent.issue?.code).toBe("unexpected_parent_kind");
    expect(projectWithParent.issue?.text).toBe(
      "A project has no parent, but this one is recorded under PAF0002, a project. Tell an admin.",
    );
    const standalone = assessLineage({ id: "s", kind: "standalone", parent_id: "proj" }, found(PROJECT));
    expect(standalone.issue?.code).toBe("unexpected_parent_kind");
  });

  it("a record that is its own parent: said, and nothing shown as its parent", () => {
    const self = node({ id: "u", kind: "unit", parent_id: "u" });
    const l = assessLineage({ id: "u", kind: "unit", parent_id: "u" }, found(self));
    expect(l.chain).toEqual([]);
    expect(l.issue).toEqual({
      code: "unexpected_parent_kind",
      text: "This record is recorded as its own parent. Tell an admin.",
    });
  });

  it("a parent no row came back for: not visible — never 'standalone'", () => {
    const l = assessLineage({ id: "u", kind: "unit", parent_id: "gone" }, { state: "absent" });
    expect(l.chain).toEqual([]);
    expect(l.issue?.code).toBe("parent_unreadable");
    expect(l.issue?.text).toBe(
      "Its parent record is not visible to you — it may belong to another organisation. Tell an admin.",
    );
  });

  it("a failed read: could not be loaded — unknown, not absent", () => {
    const l = assessLineage({ id: "u", kind: "unit", parent_id: "x" }, { state: "failed" });
    expect(l.chain).toEqual([]);
    expect(l.issue?.code).toBe("read_failed");
    expect(l.issue?.text).toBe("Its parent record could not be loaded — reload the page; if it stays, tell an admin.");
  });

  it("a parent that was not read at all counts as a failed read, not as none", () => {
    expect(assessLineage({ id: "u", kind: "unit", parent_id: "x" }).issue?.code).toBe("read_failed");
  });

  it("the grandparent unreadable or failed: the phase is kept, the gap is said", () => {
    const hidden = assessLineage({ id: "u", kind: "unit", parent_id: "ph1" }, found(PHASE), { state: "absent" });
    expect(hidden.chain).toEqual([PHASE]);
    expect(hidden.issue?.code).toBe("parent_unreadable");
    expect(hidden.issue?.text).toContain("The project above PAF0002-P1 is not visible to you");
    const failed = assessLineage({ id: "u", kind: "unit", parent_id: "ph1" }, found(PHASE), { state: "failed" });
    expect(failed.issue?.code).toBe("read_failed");
    expect(failed.issue?.text).toContain("The project above PAF0002-P1 could not be loaded");
  });

  it("a phase whose parent is not a project", () => {
    const standalone = node({ id: "s", kind: "standalone", reference: "PAF0100" });
    const l = assessLineage({ id: "u", kind: "unit", parent_id: "ph1" }, found(PHASE), found(standalone));
    expect(l.chain.map((n) => n.id)).toEqual(["s", "ph1"]);
    expect(l.issue?.code).toBe("unexpected_parent_kind");
    expect(l.issue?.text).toBe(
      "Its phase PAF0002-P1 is recorded under PAF0100, a standalone — a phase belongs to a project. Tell an admin.",
    );
  });

  it("a phase recorded as its own parent: said, and the phase shown ONCE (no duplicate crumb keys)", () => {
    const selfPhase = { ...PHASE, parent_id: "ph1" };
    const row = { id: "u", kind: "unit", parent_id: "ph1" };
    // the reader does not ask for it again ...
    expect(needsGrandparent(row, selfPhase)).toBe(false);
    // ... and were it handed the same phase back, the answer is the same
    for (const l of [assessLineage(row, found(selfPhase)), assessLineage(row, found(selfPhase), found(selfPhase))]) {
      expect(l.chain).toEqual([selfPhase]);
      expect(new Set(l.chain.map((n) => n.id)).size).toBe(l.chain.length);
      expect(l.issue).toEqual({
        code: "unexpected_parent_kind",
        text: "Its phase PAF0002-P1 is recorded as its own parent — a phase belongs to a project. Tell an admin.",
      });
    }
  });

  it("a phase recorded under this very unit (a loop): said, the unit never listed as its own ancestor", () => {
    const loopPhase = { ...PHASE, parent_id: "u" };
    const row = { id: "u", kind: "unit", parent_id: "ph1" };
    expect(needsGrandparent(row, loopPhase)).toBe(false);
    const l = assessLineage(row, found(loopPhase));
    expect(l.chain).toEqual([loopPhase]);
    expect(l.issue).toEqual({
      code: "unexpected_parent_kind",
      text: "Its phase PAF0002-P1 is recorded under this unit — a phase belongs to a project. Tell an admin.",
    });
  });

  it("a phase with no project at all (the 0001 CHECK forbids it)", () => {
    const orphan = node({ id: "ph1", kind: "phase", reference: "PAF0002-P1", parent_id: null });
    const l = assessLineage({ id: "u", kind: "unit", parent_id: "ph1" }, found(orphan));
    expect(l.chain).toEqual([orphan]);
    expect(l.issue?.code).toBe("missing_parent");
  });

  it("a unit or a phase with no parent (the 0001 CHECKs forbid it)", () => {
    expect(assessLineage({ id: "u", kind: "unit", parent_id: null }).issue).toEqual({
      code: "missing_parent",
      text: "This unit has no parent recorded — a unit belongs to a project or a phase. Tell an admin.",
    });
    expect(assessLineage({ id: "ph", kind: "phase", parent_id: null }).issue?.text).toBe(
      "This phase has no parent recorded — a phase belongs to a project. Tell an admin.",
    );
  });

  it("a third ancestor: too deep — known from the top node's own parent_id, never read", () => {
    const deepProject = { ...PROJECT, parent_id: "above" };
    const viaPhase = assessLineage({ id: "u", kind: "unit", parent_id: "ph1" }, found(PHASE), found(deepProject));
    expect(viaPhase.chain.map((n) => n.id)).toEqual(["proj", "ph1"]);
    expect(viaPhase.issue).toEqual({
      code: "too_deep",
      text: "PAF0002 itself has a parent — the hierarchy is deeper than project › phase › unit. Tell an admin.",
    });
    expect(assessLineage({ id: "u", kind: "unit", parent_id: "proj" }, found(deepProject)).issue?.code).toBe(
      "too_deep",
    );
    expect(assessLineage({ id: "ph1", kind: "phase", parent_id: "proj" }, found(deepProject)).issue?.code).toBe(
      "too_deep",
    );
  });
});

describe("needsGrandparent", () => {
  it("only for a unit whose parent is a phase with a parent", () => {
    expect(needsGrandparent({ id: "u", kind: "unit", parent_id: "ph1" }, PHASE)).toBe(true);
    expect(needsGrandparent({ id: "u", kind: "unit", parent_id: "proj" }, PROJECT)).toBe(false);
    expect(needsGrandparent({ id: "ph2", kind: "phase", parent_id: "ph1" }, PHASE)).toBe(false);
    expect(needsGrandparent({ id: "u", kind: "unit", parent_id: "ph1" }, { ...PHASE, parent_id: null })).toBe(false);
  });
});

describe("matrixParent", () => {
  it("is the recorded parent when it is a container", () => {
    const row = { id: "u", kind: "unit", parent_id: "ph1", visibility: "private" };
    expect(matrixParent(row, assessLineage(row, found(PHASE), found(PROJECT)))).toEqual(PHASE);
    const direct = { id: "u", kind: "unit", parent_id: "proj", visibility: "public" };
    expect(matrixParent(direct, assessLineage(direct, found(PROJECT)))).toEqual(PROJECT);
  });

  it("is null for a parent of the wrong kind, an unread parent, or a non-unit", () => {
    const standalone = node({ id: "s", kind: "standalone" });
    const row = { id: "u", kind: "unit", parent_id: "s", visibility: "private" };
    expect(matrixParent(row, assessLineage(row, found(standalone)))).toBeNull();
    const hidden = { id: "u", kind: "unit", parent_id: "x", visibility: "private" };
    expect(matrixParent(hidden, assessLineage(hidden, { state: "absent" }))).toBeNull();
    const phase = { id: "ph1", kind: "phase", parent_id: "proj", visibility: "private" };
    expect(matrixParent(phase, assessLineage(phase, found(PROJECT)))).toBeNull();
  });

  it("is null for an ARCHIVED unit: the matrix lists none, so the link would mark no row (A05 review)", () => {
    const row = { id: "u", kind: "unit", parent_id: "ph1", visibility: "archived" };
    const lineage = assessLineage(row, found(PHASE), found(PROJECT));
    expect(lineage.chain.map((n) => n.id)).toEqual(["proj", "ph1"]); // Part of still names it
    expect(matrixParent(row, lineage)).toBeNull();
  });

  it("still opens the matrix when the hierarchy is too deep above the parent", () => {
    const row = { id: "u", kind: "unit", parent_id: "proj", visibility: "private" };
    const lineage = assessLineage(row, found({ ...PROJECT, parent_id: "above" }));
    expect(lineage.issue?.code).toBe("too_deep");
    expect(matrixParent(row, lineage)?.id).toBe("proj");
  });
});

describe("no reference-prefix inference (A05 acceptance 5)", () => {
  it("the lineage code never splits or prefix-matches a reference", () => {
    for (const file of ["lib/services/property-lineage.ts", "lib/queries/property-lineage.ts"]) {
      const src = readFileSync(join(process.cwd(), file), "utf8")
        // comments may NAME the convention; only code is checked
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(src, file).not.toMatch(/reference\s*\.\s*(startsWith|split|slice|substring|indexOf|match)\b/);
      expect(src, file).not.toMatch(/\.startsWith\(|\.split\(/);
    }
  });
});
