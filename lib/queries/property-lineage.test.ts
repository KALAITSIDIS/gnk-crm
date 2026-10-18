import { describe, expect, it } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";
import { fetchLineage } from "./property-lineage";

/**
 * A05: the lineage READER — at most two reads, by primary key, never a loop,
 * and a failure said rather than thrown or read as "no parent".
 */

const row = (id: string, kind: string, parent_id: string | null, reference = id.toUpperCase()) => ({
  id,
  reference,
  kind,
  title: { en: `${kind} ${id}` },
  visibility: "private",
  parent_id,
});

describe("fetchLineage", () => {
  it("asks nothing for a row with no parent", async () => {
    const fake = fakeClient({});
    const l = await fetchLineage(fake.client as never, { id: "s", kind: "standalone", parent_id: null });
    expect(l).toEqual({ chain: [], issue: null });
    expect(fake.calls).toHaveLength(0);
  });

  it("unit → project: ONE read, by the parent's id", async () => {
    const fake = fakeClient({ properties: [{ data: [row("proj", "project", null)], error: null }] });
    const l = await fetchLineage(fake.client as never, { id: "u", kind: "unit", parent_id: "proj" });
    expect(fake.served.properties).toBe(1);
    expect(fake.argsOf("properties", "eq")).toEqual([["id", "proj"]]);
    expect(fake.argsOf("properties", "in"), "never an id list").toEqual([]);
    expect(l.issue).toBeNull();
    expect(l.chain).toEqual([
      { id: "proj", reference: "PROJ", kind: "project", title: "project proj", visibility: "private", parent_id: null },
    ]);
  });

  it("unit → phase → project: the grandparent is read only because the parent is a phase — two reads", async () => {
    const fake = fakeClient({
      properties: [
        { data: [row("ph1", "phase", "proj")], error: null },
        { data: [row("proj", "project", null)], error: null },
      ],
    });
    const l = await fetchLineage(fake.client as never, { id: "u", kind: "unit", parent_id: "ph1" });
    expect(fake.served.properties).toBe(2);
    expect(fake.argsOf("properties", "eq")).toEqual([
      ["id", "ph1"],
      ["id", "proj"],
    ]);
    expect(l.chain.map((n) => n.id)).toEqual(["proj", "ph1"]);
    expect(l.issue).toBeNull();
  });

  it("a phase's lineage is one read: its parent is the top of the model", async () => {
    const fake = fakeClient({ properties: [{ data: [row("proj", "project", null)], error: null }] });
    await fetchLineage(fake.client as never, { id: "ph1", kind: "phase", parent_id: "proj" });
    expect(fake.served.properties).toBe(1);
  });

  it("a self-parent does not loop: one read, then said", async () => {
    const fake = fakeClient({ properties: [{ data: [row("u", "unit", "u")], error: null }] });
    const l = await fetchLineage(fake.client as never, { id: "u", kind: "unit", parent_id: "u" });
    expect(fake.served.properties).toBe(1);
    expect(l.issue?.text).toBe("This record is recorded as its own parent. Tell an admin.");
  });

  it("a cycle through a phase stops at ONE read: the phase's own parent_id already names the unit", async () => {
    // u → ph1 → u: a second read would only return the unit itself
    const fake = fakeClient({
      properties: [
        { data: [row("ph1", "phase", "u")], error: null },
        { data: [row("u", "unit", "ph1")], error: null },
        { data: [row("ph1", "phase", "u")], error: null },
      ],
    });
    const l = await fetchLineage(fake.client as never, { id: "u", kind: "unit", parent_id: "ph1" });
    expect(fake.served.properties).toBe(1);
    expect(l.issue?.code).toBe("unexpected_parent_kind");
    expect(l.chain.map((n) => n.id)).toEqual(["ph1"]);
  });

  it("a phase that is its own parent: one read, the phase shown once (A05 review: no duplicate crumb keys)", async () => {
    const fake = fakeClient({
      properties: [
        { data: [row("ph1", "phase", "ph1")], error: null },
        { data: [row("ph1", "phase", "ph1")], error: null },
      ],
    });
    const l = await fetchLineage(fake.client as never, { id: "u", kind: "unit", parent_id: "ph1" });
    expect(fake.served.properties).toBe(1);
    expect(l.chain.map((n) => n.id)).toEqual(["ph1"]);
    expect(l.issue?.text).toMatch(/is recorded as its own parent — a phase belongs to a project/);
  });

  it("a third ancestor is never read: too deep, from the project's own parent_id", async () => {
    const fake = fakeClient({
      properties: [
        { data: [row("ph1", "phase", "proj")], error: null },
        { data: [row("proj", "project", "above")], error: null },
      ],
    });
    const l = await fetchLineage(fake.client as never, { id: "u", kind: "unit", parent_id: "ph1" });
    expect(fake.served.properties).toBe(2);
    expect(l.issue?.code).toBe("too_deep");
  });

  it("an empty answer is 'not visible', not 'standalone'", async () => {
    const fake = fakeClient({ properties: [{ data: [], error: null }] });
    const l = await fetchLineage(fake.client as never, { id: "u", kind: "unit", parent_id: "other-org" });
    expect(l).toEqual({
      chain: [],
      issue: {
        code: "parent_unreadable",
        text: "Its parent record is not visible to you — it may belong to another organisation. Tell an admin.",
      },
    });
  });

  it("a failed read yields 'could not be loaded' and does not throw", async () => {
    const fake = fakeClient({ properties: [{ data: null, error: { message: "boom" } }] });
    const l = await fetchLineage(fake.client as never, { id: "u", kind: "unit", parent_id: "proj" });
    expect(l.issue?.code).toBe("read_failed");
    expect(l.chain).toEqual([]);
  });

  it("an answer with no rows array is a failed read, not an absent parent (T-null-answer-guard)", async () => {
    const fake = fakeClient({ properties: [{ data: null, error: null, status: 204 }] });
    const l = await fetchLineage(fake.client as never, { id: "u", kind: "unit", parent_id: "proj" });
    expect(l.issue?.code).toBe("read_failed");
  });

  it("a client that throws is a failed read too", async () => {
    const throwing = {
      from: () => {
        throw new Error("network");
      },
    };
    const l = await fetchLineage(throwing as never, { id: "u", kind: "unit", parent_id: "proj" });
    expect(l.issue?.code).toBe("read_failed");
  });

  it("the grandparent's failure keeps the phase in the trail", async () => {
    const fake = fakeClient({
      properties: [
        { data: [row("ph1", "phase", "proj")], error: null },
        { data: null, error: { message: "boom" } },
      ],
    });
    const l = await fetchLineage(fake.client as never, { id: "u", kind: "unit", parent_id: "ph1" });
    expect(l.chain.map((n) => n.id)).toEqual(["ph1"]);
    expect(l.issue?.code).toBe("read_failed");
  });
});
