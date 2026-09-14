import { describe, expect, it } from "vitest";
import { toPortalCardDefinition } from "./card-definition";
import { PORTALS } from "./registry";

/**
 * The projection exists so a `"use client"` component can receive it. React's
 * rule is not "no zod" but "plain data only", so the guard below is structural
 * rather than a check for the one field that broke it: a future registry entry
 * carrying a Date, a Map, a class instance or a method would fail here instead
 * of behind the settings page's error boundary.
 */
function findNonPlain(value: unknown, path: string): string | null {
  if (value === null) return null;
  const type = typeof value;
  if (type === "function") return `${path} is a function`;
  if (type === "symbol") return `${path} is a symbol`;
  if (type !== "object") return null;

  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const bad = findNonPlain(item, `${path}[${i}]`);
      if (bad) return bad;
    }
    return null;
  }

  // `value` is `unknown`, and the typeof/Array.isArray narrowing above does not
  // leave TypeScript with something `Object.entries` accepts. It is an object
  // and not an array by here, so name that once.
  const obj = value as Record<string, unknown>;
  const proto = Object.getPrototypeOf(obj) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    const ctor = obj.constructor as { name?: string } | undefined;
    return `${path} is a ${ctor?.name ?? "non-plain"} instance`;
  }
  for (const [key, v] of Object.entries(obj)) {
    const bad = findNonPlain(v, `${path}.${key}`);
    if (bad) return bad;
  }
  return null;
}

describe("portal card definition", () => {
  it("survives a JSON round trip unchanged, so it can cross the RSC boundary", () => {
    for (const def of PORTALS) {
      const card = toPortalCardDefinition(def);
      expect(JSON.parse(JSON.stringify(card)), def.id).toEqual(card);
    }
  });

  it("drops settingsSchema — a zod object is a class instance React refuses to serialise", () => {
    for (const def of PORTALS) {
      const card = toPortalCardDefinition(def);
      expect(Object.hasOwn(card, "settingsSchema"), def.id).toBe(false);
      expect(def.settingsSchema, `${def.id} still has a schema to parse with`).toBeDefined();
    }
  });

  it("holds no function, symbol or class instance at any depth", () => {
    for (const def of PORTALS) {
      expect(findNonPlain(toPortalCardDefinition(def), def.id)).toBeNull();
    }
  });

  it("carries every field the card draws", () => {
    for (const def of PORTALS) {
      const card = toPortalCardDefinition(def);
      expect(card, def.id).toEqual({
        id: def.id,
        name: def.name,
        dialect: def.dialect,
        audience: def.audience,
        spec: def.spec,
        requirements: def.requirements,
        requiredSettings: def.requiredSettings,
        settingsFields: def.settingsFields,
        pullCadence: def.pullCadence,
        docsUrl: def.docsUrl,
      });
    }
  });
});
