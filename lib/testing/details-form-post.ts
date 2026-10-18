/**
 * What the Details form posts for a stored row (F07) — every field its layout
 * renders, at the value it renders it with, as a browser submits it: a native
 * `<details>` that is closed still posts the inputs inside it, so a collapsed
 * group is in here exactly like an open one.
 *
 * Mirrors the defaults in components/features/properties/detail-forms.tsx
 * field by field; tests/unit/details-form-layout.test.ts checks this against
 * the rendered markup, so the two cannot drift silently. Test-only.
 */
import { detailsLayout, layoutFields, type DetailsField } from "@/lib/services/property-layout";
import { parseLocationPoint } from "@/lib/utils/geo";
import { AREA_NONE, utilityFormValue } from "@/lib/validators/properties";

/** A field's posted value(s), as the form renders it for `row`. */
export function postedValue(field: DetailsField, row: Readonly<Record<string, unknown>>): Record<string, string> {
  const v = row[field];
  const text = (x: unknown) => (x === null || x === undefined ? "" : String(x));
  switch (field) {
    case "area_id":
      return { area_id: v ? String(v) : AREA_NONE };
    case "energy_class":
      return { energy_class: v ? String(v) : "none" };
    case "water_available":
    case "electricity_available":
      return { [field]: utilityFormValue(v as boolean | null | undefined) };
    case "location": {
      const point = parseLocationPoint(row.location);
      return {
        latitude: point ? String(point.lat) : "",
        longitude: point ? String(point.lng) : "",
        location_approx: point && row.location_approx ? "on" : "",
      };
    }
    case "features":
      return {}; // repeated — see detailsFormPost
    default:
      return { [field]: text(v) };
  }
}

/**
 * The FormData of an untouched Details form for `row`, with `edits` typed over
 * it (by posted name). `features` repeats, one entry per ticked box, unless
 * `features` is given.
 */
export function detailsFormPost(
  row: Readonly<Record<string, unknown>>,
  edits: Record<string, string> = {},
  features?: readonly string[],
): FormData {
  const layout = detailsLayout({
    property_type: row.property_type as string,
    kind: row.kind as string,
    transaction_type: row.transaction_type as string,
  });
  const posted: Record<string, string> = {
    property_id: String(row.id),
    section: "details",
    ...(row.updated_at ? { expected_updated_at: String(row.updated_at) } : {}),
  };
  for (const f of layoutFields(layout)) Object.assign(posted, postedValue(f, row));
  Object.assign(posted, edits);
  const fd = new FormData();
  for (const [k, v] of Object.entries(posted)) fd.set(k, v);
  for (const f of features ?? ((row.features as string[] | null) ?? [])) fd.append("features", f);
  return fd;
}
