import { describe, expect, it } from "vitest";
import {
  computeInheritanceDrift,
  DELIBERATELY_NOT_INHERITED,
  fieldsClaimedByEdit,
  INHERITED_UNIT_FIELDS,
  inheritedFieldsWithValues,
  resolveInheritedUnitFields,
  UNIT_PARENT_SELECT,
  UNIT_ROW_SELECT,
} from "./unit-inheritance";

const project = {
  transaction_type: "sale",
  district_id: "d-1",
  area_id: "a-1",
  address: "Coral Bay Ave",
  postal_code: "8575",
  location: "0101000020E6100000",
  sea_distance_m: 300,
  amenities_notes: "Communal pool and gym",
  currency: "EUR",
  vat_status: "new_vat",
  energy_class: "A",
  features: ["pool", "lift"],
  title_deed_status: "pending",
  permit_status: "full",
  construction_status: "under_construction",
  delivery_date: "2027-06-30",
  developer_contact_id: "dev-1",
  owner_contact_id: "own-1",
  assigned_agent_id: "agent-1",
};

describe("resolveInheritedUnitFields", () => {
  it("carries every project-level truth onto the unit", () => {
    const inherited = resolveInheritedUnitFields(project);
    for (const field of INHERITED_UNIT_FIELDS) {
      expect(inherited[field], `${field} should be inherited`).toEqual(
        project[field as keyof typeof project],
      );
    }
  });

  it("inherits the developer — the whole point of finding 5", () => {
    expect(resolveInheritedUnitFields(project).developer_contact_id).toBe("dev-1");
  });

  it("NEVER inherits visibility — that would publish an empty unit", () => {
    // A `public` project would otherwise mint already-published units with no
    // photos, no description and no price, straight past the quality gate.
    const inherited = resolveInheritedUnitFields({
      ...project,
      visibility: "public",
    } as never);
    expect("visibility" in inherited).toBe(false);
    expect(INHERITED_UNIT_FIELDS).not.toContain("visibility");
  });

  it("never inherits the unit's own measurements or price", () => {
    const inherited = resolveInheritedUnitFields({
      ...project,
      asking_price: 999999,
      covered_area_sqm: 500,
      bedrooms: 9,
    } as never);
    expect("asking_price" in inherited).toBe(false);
    expect("covered_area_sqm" in inherited).toBe(false);
    expect("bedrooms" in inherited).toBe(false);
  });

  it("passes a project null straight through rather than skipping the column", () => {
    // inheriting "unknown" is correct; skipping would make the unit's blank
    // look like somebody's decision instead of a gap nobody has filled
    const inherited = resolveInheritedUnitFields({ developer_contact_id: null });
    expect(inherited.developer_contact_id).toBeNull();
    expect(Object.keys(inherited)).toHaveLength(INHERITED_UNIT_FIELDS.length);
  });

  it("keeps the two lists disjoint — a field cannot be both", () => {
    for (const excluded of Object.keys(DELIBERATELY_NOT_INHERITED)) {
      expect(INHERITED_UNIT_FIELDS).not.toContain(excluded);
    }
  });
});

describe("inheritedFieldsWithValues", () => {
  it("reports only the columns that actually carried something", () => {
    const named = inheritedFieldsWithValues({
      developer_contact_id: "dev-1",
      vat_status: "new_vat",
      delivery_date: null,
    });
    // order follows INHERITED_UNIT_FIELDS, not the caller's object
    expect(named).toEqual(["vat_status", "developer_contact_id"]);
  });

  it("is empty for a project with nothing filled in", () => {
    expect(inheritedFieldsWithValues({})).toEqual([]);
  });
});

describe("UNIT_PARENT_SELECT", () => {
  const columns = UNIT_PARENT_SELECT.split(",").map((c) => c.trim());

  it("selects every field the insert will inherit — a literal that cannot drift", () => {
    // The select must be a literal for Supabase to infer the row type, so this
    // test is the only thing stopping it falling behind INHERITED_UNIT_FIELDS.
    for (const field of INHERITED_UNIT_FIELDS) {
      expect(columns, `${field} is inherited but not selected`).toContain(field);
    }
  });

  it("also carries the columns a child creator needs for itself", () => {
    // property_type is here rather than in INHERITED_UNIT_FIELDS: a unit picks
    // its own, a phase takes the project's, neither is drift-tracked
    for (const own of ["id", "org_id", "kind", "reference", "property_type"]) {
      expect(columns).toContain(own);
    }
  });

  it("selects nothing it does not use", () => {
    const allowed = new Set<string>([
      ...INHERITED_UNIT_FIELDS,
      "id",
      "org_id",
      "kind",
      "reference",
      "property_type",
    ]);
    for (const c of columns) expect(allowed.has(c), `${c} is selected but unused`).toBe(true);
  });
});

describe("computeInheritanceDrift", () => {
  const project = { vat_status: "new_vat", delivery_date: "2027-06-30", energy_class: "A" };
  const all = ["vat_status", "delivery_date", "energy_class"];

  it("counts units that still inherit a field and disagree with it", () => {
    const drift = computeInheritanceDrift(project, [
      { inherited_fields: all, vat_status: "resale_no_vat", delivery_date: "2027-06-30", energy_class: "A" },
      { inherited_fields: all, vat_status: "resale_no_vat", delivery_date: "2027-06-30", energy_class: "A" },
    ]);
    expect(drift).toEqual([{ field: "vat_status", count: 2 }]);
  });

  it("ignores a unit that no longer inherits the field — it has an opinion", () => {
    // The whole point: a deliberate per-unit value must not be counted as drift.
    // delivery_date is held equal so vat_status is the only thing under test.
    const drift = computeInheritanceDrift(project, [
      {
        inherited_fields: ["delivery_date", "energy_class"],
        vat_status: "resale_no_vat",
        delivery_date: "2027-06-30",
        energy_class: "A",
      },
    ]);
    expect(drift).toEqual([]);
  });

  it("is empty when everything agrees", () => {
    expect(
      computeInheritanceDrift(project, [
        { inherited_fields: all, vat_status: "new_vat", delivery_date: "2027-06-30", energy_class: "A" },
      ]),
    ).toEqual([]);
  });

  it("treats null and undefined as the same absence", () => {
    expect(
      computeInheritanceDrift({ energy_class: null }, [
        { inherited_fields: ["energy_class"] },
      ]),
    ).toEqual([]);
  });

  it("compares arrays by value, not by reference", () => {
    expect(
      computeInheritanceDrift({ features: ["pool", "lift"] }, [
        { inherited_fields: ["features"], features: ["pool", "lift"] },
      ]),
    ).toEqual([]);
    expect(
      computeInheritanceDrift({ features: ["pool", "lift"] }, [
        { inherited_fields: ["features"], features: ["pool"] },
      ]),
    ).toEqual([{ field: "features", count: 1 }]);
  });

  it("handles a unit with no inherited_fields at all", () => {
    expect(computeInheritanceDrift(project, [{ vat_status: "resale_no_vat" }])).toEqual([]);
  });
});

describe("fieldsClaimedByEdit", () => {
  it("removes only the fields the edit actually changed", () => {
    expect(fieldsClaimedByEdit(["vat_status", "energy_class"], ["vat_status"])).toEqual([
      "energy_class",
    ]);
  });

  it("leaves the list alone when the save changed nothing inheritable", () => {
    // the details form posts twenty-odd columns every save — only CHANGED ones
    // may opt a unit out, or pressing Save once would sever every field
    expect(fieldsClaimedByEdit(["vat_status", "energy_class"], ["bedrooms", "asking_price"]))
      .toEqual(["vat_status", "energy_class"]);
  });

  it("survives a unit that inherits nothing", () => {
    expect(fieldsClaimedByEdit(null, ["vat_status"])).toEqual([]);
    expect(fieldsClaimedByEdit([], ["vat_status"])).toEqual([]);
  });
});

describe("UNIT_ROW_SELECT", () => {
  const columns = UNIT_ROW_SELECT.split(",").map((c) => c.trim());

  it("selects every inheritable field, or the drift check compares undefined", () => {
    // a field missing here reads as `undefined` on every unit and would show up
    // as drift on all of them — a panel crying wolf is worse than no panel
    for (const field of INHERITED_UNIT_FIELDS) {
      expect(columns, `${field} is compared but not selected`).toContain(field);
    }
  });

  it("selects inherited_fields, without which nothing can be compared at all", () => {
    expect(columns).toContain("inherited_fields");
  });

  it("still selects what the units matrix renders", () => {
    for (const c of ["reference", "unit_number", "block", "status", "asking_price"]) {
      expect(columns).toContain(c);
    }
  });
});
