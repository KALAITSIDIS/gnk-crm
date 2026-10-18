/**
 * Property feature keys (doc 03: properties.features text[]).
 * Keys are stored in the DB; labels are display-only (EN for Phase 1 UI).
 * Extend here — never free-type feature strings elsewhere.
 */
export const PROPERTY_FEATURES = [
  ["sea_view", "Sea view"],
  ["mountain_view", "Mountain view"],
  ["private_pool", "Private pool"],
  ["communal_pool", "Communal pool"],
  ["garden", "Garden"],
  ["veranda", "Veranda"],
  ["roof_garden", "Roof garden"],
  ["bbq_area", "BBQ area"],
  ["furnished", "Furnished"],
  ["partly_furnished", "Partly furnished"],
  ["air_conditioning", "Air conditioning"],
  ["central_heating", "Central heating"],
  ["underfloor_heating", "Underfloor heating"],
  ["solar_water_heater", "Solar water heater"],
  ["photovoltaics", "Photovoltaics"],
  ["double_glazing", "Double glazing"],
  ["fireplace", "Fireplace"],
  ["storage_room", "Storage room"],
  ["covered_parking", "Covered parking"],
  ["elevator", "Elevator"],
  ["gated_community", "Gated community"],
  ["gym", "Gym"],
  ["smart_home", "Smart home"],
  ["pets_allowed", "Pets allowed"],
  ["wheelchair_access", "Wheelchair access"],
] as const;

export type PropertyFeatureKey = (typeof PROPERTY_FEATURES)[number][0];

export const FEATURE_KEYS = PROPERTY_FEATURES.map(([key]) => key);

/**
 * Storage room has ONE value: this key in `properties.features` (F02,
 * migration 0152). `properties.has_storage` is a mirror the database derives
 * from it on every write (trigger properties_storage_from_features) and keeps
 * only for the public feed's shape — never a second control, never written on
 * its own. Matching, unit inheritance and the portal feed read the feature.
 */
export const STORAGE_FEATURE = "storage_room" satisfies PropertyFeatureKey;

/** What `has_storage` holds for a features list — the trigger's rule, in the app. */
export function hasStorageRoom(features: readonly string[]): boolean {
  return features.includes(STORAGE_FEATURE);
}

export function featureLabel(key: string): string {
  return PROPERTY_FEATURES.find(([k]) => k === key)?.[1] ?? key.replace(/_/g, " ");
}
