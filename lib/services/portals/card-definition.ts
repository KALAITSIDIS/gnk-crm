import type { PortalDefinition } from "./registry";

/**
 * THE REGISTRY ENTRY MINUS WHAT CANNOT CROSS THE RSC BOUNDARY.
 *
 * `PortalDefinition.settingsSchema` is a zod object — a class instance with
 * methods — and React refuses to serialise one into a `"use client"` component
 * ("Only plain objects, and a few built-ins, can be passed to Client
 * Components"). Passing the whole definition put the settings page behind its
 * error boundary, which the Task 12 e2e caught. The schema is a server concern
 * anyway: `savePortalSettings` parses with it, the card only draws the fields.
 */
export type PortalCardDefinition = Pick<
  PortalDefinition,
  | "id"
  | "name"
  | "dialect"
  | "audience"
  | "spec"
  | "requirements"
  | "requiredSettings"
  | "settingsFields"
  | "pullCadence"
  | "docsUrl"
>;

export function toPortalCardDefinition(def: PortalDefinition): PortalCardDefinition {
  const {
    id,
    name,
    dialect,
    audience,
    spec,
    requirements,
    requiredSettings,
    settingsFields,
    pullCadence,
    docsUrl,
  } = def;
  return {
    id,
    name,
    dialect,
    audience,
    spec,
    requirements,
    requiredSettings,
    settingsFields,
    pullCadence,
    docsUrl,
  };
}
