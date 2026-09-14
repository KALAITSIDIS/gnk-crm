# Portal Syndication — Milestone 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin enables a portal and gets a feed URL; an agent ticks a listing for that portal; the portal pulls a Kyero-format XML feed of exactly the ticked, public, available listings with JPEG photos.

**Architecture:** One migration (0095) adds `portal_connections`, `portal_listings`, a `path_jpeg` rendition and three anon-callable functions. A code registry is the one definition of each portal. The feed route reads the existing `public_listings` function and keeps the selected references, so a portal can never show what the site does not; a pure Kyero renderer turns those rows into XML. The settings page and the property page's Marketing tab are the two UI surfaces.

**Tech Stack:** Next.js 16.3 (App Router, `after()`), Supabase (Postgres 17, PostGIS, RLS, SECURITY DEFINER functions), zod 4, sharp, vitest 4 (unit + RLS suites), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-14-portal-syndication-design.md`. This plan covers **milestone 1 only**: JamesEdition, A Place in the Sun, Properstar and the UK feed provider, all on the Kyero dialect. RERA and Thribee dialects are milestone 2; the JamesEdition leads pull and the `leads` columns are milestone 3, in their own migration, so 0095 ships nothing untested.

**Branch:** work on `feat/portal-syndication-m1` off `main` (the spec branch `docs/portal-syndication-spec` merges first or alongside).

**Repo rules that bind every task** (from `docs/HANDOFF.md`, `CLAUDE.md`, memory):
- A write that RLS may have filtered to zero rows must never report success: check the affected row count.
- Every settings edit and every selection writes an event through `logEvent`.
- `hosted migration BEFORE merging to main` for an additive migration; push the branch for a CI rehearsal first.
- Commit after every task; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Bash heredocs containing `${` break in this environment — write scripts to files instead.

---

## File map

| file | responsibility |
|---|---|
| `lib/services/portals/registry.ts` | the one definition of each portal: id, dialect, requirements, settings fields, spec status |
| `lib/services/portals/dialects/xml.ts` | escaping and a tiny tag builder; no dialect concatenates strings itself |
| `lib/services/portals/feed-listing.ts` | the shape renderers consume: a `public_listings` row joined to its supplement (coords, JPEG images) |
| `lib/services/portals/eligibility.ts` | why a listing may or may not go to a portal — used by the feed and by the property toggles |
| `lib/services/portals/dialects/kyero.ts` | Kyero v3.9 renderer |
| `lib/services/portals/dialects/index.ts` | `DialectRenderer` interface, the renderer table, the per-dialect type and currency maps |
| `lib/services/portals/feed.ts` | page through the site feed, keep selected + eligible, render |
| `app/api/portals/[portal]/[token]/route.ts` | the public feed route |
| `lib/actions/portals.ts` | enable/disable, settings, token, select/deselect |
| `app/(app)/settings/portals/page.tsx` + `components/features/settings/portal-card.tsx` | admin page |
| `components/features/properties/portals-card.tsx` | the toggles on the Marketing tab |
| `supabase/migrations/0095_portal_syndication.sql` | schema |
| `supabase/tests/portals.test.ts` | RLS suite |
| `lib/services/media.ts`, `lib/actions/media.ts`, `scripts/import/media.mts` | the JPEG rendition |
| `scripts/media/backfill-jpeg.mts` | one-off JPEG backfill |
| `tests/e2e/portals.spec.ts` | enable → select → fetch → deselect |

---

### Task 1: Portal registry

**Files:**
- Create: `lib/services/portals/registry.ts`
- Test: `lib/services/portals/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/services/portals/registry.test.ts
import { describe, expect, it } from "vitest";
import { PORTALS, PORTAL_IDS, portalById } from "./registry";

describe("portal registry", () => {
  it("has one definition per id and no id twice", () => {
    expect(PORTALS.map((p) => p.id).sort()).toEqual([...PORTAL_IDS].sort());
    expect(new Set(PORTALS.map((p) => p.id)).size).toBe(PORTALS.length);
  });

  it("ids are lowercase snake case, which the 0095 check constraint enforces", () => {
    for (const p of PORTALS) expect(p.id).toMatch(/^[a-z_]{2,40}$/);
  });

  it("a pending portal has no required settings the desk could fill in for nothing", () => {
    for (const p of PORTALS.filter((p) => p.spec === "pending")) {
      expect(p.requiredSettings, p.id).toEqual([]);
    }
  });

  it("every requiredSettings key is a declared settings field", () => {
    for (const p of PORTALS) {
      const keys = p.settingsFields.map((f) => f.key);
      for (const k of p.requiredSettings) expect(keys, `${p.id}.${k}`).toContain(k);
    }
  });

  it("portalById answers null for an unknown id", () => {
    expect(portalById("nope")).toBeNull();
    expect(portalById("jamesedition")?.dialect).toBe("kyero");
  });

  it("settingsSchema accepts an empty form and strips unknown keys", () => {
    const je = portalById("jamesedition")!;
    const parsed = je.settingsSchema.safeParse({ contact_number: " +357 26 000000 ", stray: "x" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.contact_number).toBe("+357 26 000000");
      expect("stray" in parsed.data).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/services/portals/registry.test.ts`
Expected: FAIL — `Cannot find module './registry'`

- [ ] **Step 3: Write the registry**

```ts
// lib/services/portals/registry.ts
import { z } from "zod";

/**
 * THE ONE DEFINITION of each external portal (spec 2026-09-14 §Registry).
 *
 * Not a table: the set of portals the code can serialise for is a fact about
 * the code, and a row that named a dialect no renderer exists for would be a
 * lie the desk could enable. `portal_connections.portal` stores these ids as
 * text; the 0095 check constraint pins the shape and registry.test.ts pins
 * the list, so a typo cannot silently create a portal.
 */
export const DIALECTS = ["kyero", "rera", "trovit", "bazaraki", "prian"] as const;
export type Dialect = (typeof DIALECTS)[number];

export const PORTAL_IDS = [
  "jamesedition",
  "aplaceinthesun",
  "properstar",
  "uk_provider",
  "rera",
  "thribee",
  "bazaraki",
  "prian",
] as const;
export type PortalId = (typeof PORTAL_IDS)[number];

export interface PortalSettingField {
  key: string;
  label: string;
  placeholder?: string;
}

export interface PortalDefinition {
  id: PortalId;
  name: string;
  dialect: Dialect;
  /** one line for the settings page */
  audience: string;
  /** `pending`: the portal's format is not public; no renderer, cannot be enabled */
  spec: "public" | "pending";
  requirements: {
    minPhotos: number;
    needsCoords: boolean;
    /** which of the CRM's three languages the dialect can carry */
    languages: readonly ("en" | "el" | "ru")[];
  };
  /** setting keys without which the enable switch refuses */
  requiredSettings: readonly string[];
  settingsFields: readonly PortalSettingField[];
  settingsSchema: z.ZodType<Record<string, string>>;
  /** words for the desk, not a schedule the CRM runs */
  pullCadence: string;
  docsUrl: string;
}

const optionalText = (max: number) => z.string().trim().max(max).optional().default("");

/** Kyero v3.7–3.9 contact nodes, emitted per property. */
const KYERO_CONTACT_FIELDS: readonly PortalSettingField[] = [
  { key: "contact_number", label: "Contact phone", placeholder: "+357 26 000000" },
  { key: "whatsapp_number", label: "WhatsApp number", placeholder: "+357 99 000000" },
  { key: "email", label: "Enquiry e-mail", placeholder: "sales@example.com" },
];
const kyeroSettingsSchema = z.object({
  contact_number: optionalText(40),
  whatsapp_number: optionalText(40),
  email: optionalText(200),
});

const kyeroPortal = (
  id: PortalId,
  name: string,
  audience: string,
  pullCadence: string,
  docsUrl: string,
  minPhotos = 1,
): PortalDefinition => ({
  id,
  name,
  dialect: "kyero",
  audience,
  spec: "public",
  requirements: { minPhotos, needsCoords: false, languages: ["en", "ru"] },
  requiredSettings: [],
  settingsFields: KYERO_CONTACT_FIELDS,
  settingsSchema: kyeroSettingsSchema,
  pullCadence,
  docsUrl,
});

const pendingPortal = (
  id: PortalId,
  name: string,
  dialect: Dialect,
  audience: string,
  docsUrl: string,
): PortalDefinition => ({
  id,
  name,
  dialect,
  audience,
  spec: "pending",
  requirements: { minPhotos: 1, needsCoords: false, languages: ["en"] },
  requiredSettings: [],
  settingsFields: [],
  settingsSchema: z.object({}),
  pullCadence: "unknown until the portal's specification arrives",
  docsUrl,
});

export const PORTALS: readonly PortalDefinition[] = [
  kyeroPortal(
    "jamesedition",
    "JamesEdition",
    "Luxury buyers worldwide. Quality review on price and imagery; at least two photos.",
    "three times a day (00:11, 08:11, 16:11 UTC)",
    "https://docs.jamesedition.com/docs/",
    2,
  ),
  kyeroPortal(
    "aplaceinthesun",
    "A Place in the Sun",
    "British buyers of holiday and retirement homes.",
    "daily",
    "https://www.aplaceinthesun.com/advertise/website/list-your-properties",
  ),
  kyeroPortal(
    "properstar",
    "Properstar (ListGlobally)",
    "Syndicated to 100+ portals in 60+ countries.",
    "daily",
    "https://help.properstar.com/knowledge/our-crms-compatibility",
  ),
  kyeroPortal(
    "uk_provider",
    "Rightmove, Zoopla & OnTheMarket (via feed provider)",
    "British buyers. One feed to a registered provider, which pushes to whichever UK memberships you hold — the CRM cannot pick one of them per listing.",
    "the provider's own schedule",
    "https://www.rightmove.co.uk/overseas-property/advertise/estate-agent.html",
  ),
  // Milestone 2 turns these two into `spec: "public"` with their renderers.
  pendingPortal("rera", "RERA.cy", "rera", "Cyprus domestic (a private marketplace).", "https://xml.rera.cy/import-specification.html"),
  pendingPortal("thribee", "Thribee (Trovit, Mitula, Nestoria, Nuroa)", "trovit", "Property search engines; free.", "https://help.thribee.com/"),
  pendingPortal("bazaraki", "Bazaraki Pro", "bazaraki", "Cyprus domestic. XML spec is given to Pro accounts only.", "https://pro.bazaraki.com/"),
  pendingPortal("prian", "Prian.ru", "prian", "Russian-speaking buyers. Format on request from adv@prian.ru.", "https://prian.ru/about/"),
];

export function portalById(id: string): PortalDefinition | null {
  return PORTALS.find((p) => p.id === id) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/services/portals/registry.test.ts`
Expected: PASS (6 tests)

Then `npm run typecheck`. If tsc rejects assigning a `z.object({...})` to `settingsSchema: z.ZodType<Record<string, string>>` (zod 4 variance), change the field's type to `z.ZodObject<z.ZodRawShape>` and cast the parsed output to `Record<string, string>` in `lib/validators/portals.ts` (Task 11) — one cast at the one call site, not one per portal.

- [ ] **Step 5: Commit**

```bash
git add lib/services/portals/registry.ts lib/services/portals/registry.test.ts
git commit -m "portals: the registry — one definition per portal, pinned by test" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

**Post-review amendments (applied in a second commit on 2026-09-14; the committed files are the authority, not the block above):**
- `PortalDefinition` fields are `readonly`; `settingsSchema` is typed `z.ZodObject<Record<string, z.ZodType<string>>>` so `.shape` stays visible and a test pins `settingsFields` keys ⇔ schema shape keys both ways.
- `email` is blank-or-valid (`refine` with `z.email()`), not free text.
- `PORTAL_ID_PATTERN` is exported; 0095 pins the same regex and the RLS suite (Task 7) cross-checks them.
- The helpers take options objects; pending portals declare their `requirements` explicitly (RERA `needsCoords: true`; Bazaraki and Prian carry the CRM's floor with a comment saying so).
- `spec: "pending"` is documented as "no renderer in this build, so it cannot be enabled" — covering both "format not public" (Bazaraki, Prian) and "renderer scheduled for milestone 2" (RERA, Thribee). Task 12's badge wording follows.
- JamesEdition's `audience` no longer repeats the two-photo rule; the settings page renders it from `requirements`.

---

### Task 2: XML builder

**Files:**
- Create: `lib/services/portals/dialects/xml.ts`
- Test: `lib/services/portals/dialects/xml.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/services/portals/dialects/xml.test.ts
import { describe, expect, it } from "vitest";
import { XML_HEADER, escapeXml, tag } from "./xml";

describe("xml builder", () => {
  it("escapes the five specials and nothing else", () => {
    expect(escapeXml(`a<b>&"c'd é`)).toBe("a&lt;b&gt;&amp;&quot;c&apos;d é");
  });

  it("drops control characters XML 1.0 forbids", () => {
    expect(escapeXml("ok bad")).toBe("okbad");
  });

  it("renders a tag with escaped text and attributes", () => {
    expect(tag("desc", "1 < 2", { lang: 'en"x' })).toBe('<desc lang="en&quot;x">1 &lt; 2</desc>');
  });

  it("renders raw children when given an array", () => {
    expect(tag("images", [tag("url", "https://a/b.jpg")])).toBe(
      "<images><url>https://a/b.jpg</url></images>",
    );
  });

  it("omits a tag whose value is null or undefined", () => {
    expect(tag("beds", null)).toBe("");
    expect(tag("beds", undefined)).toBe("");
    expect(tag("beds", 0)).toBe("<beds>0</beds>");
  });

  it("header declares UTF-8", () => {
    expect(XML_HEADER).toBe('<?xml version="1.0" encoding="UTF-8"?>\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/services/portals/dialects/xml.test.ts`
Expected: FAIL — `Cannot find module './xml'`

- [ ] **Step 3: Write the builder**

```ts
// lib/services/portals/dialects/xml.ts
/**
 * The only place a portal feed touches angle brackets. Every dialect builds
 * its document through `tag()`, so escaping cannot be forgotten in one of
 * fifty fields, and a listing whose title contains "<" cannot break a feed
 * that a portal then silently drops.
 */
export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';

// XML 1.0 forbids C0 controls except tab, LF, CR.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[ --]/g;

export function escapeXml(value: string): string {
  return value
    .replace(FORBIDDEN, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

type Scalar = string | number | boolean;

/**
 * `tag("beds", 3)` → `<beds>3</beds>`; an array is already-rendered children
 * and is NOT escaped; `null`/`undefined` renders nothing so an optional field
 * is one line at the call site, not an `if`.
 */
export function tag(
  name: string,
  value: Scalar | readonly string[] | null | undefined,
  attrs: Record<string, Scalar | null | undefined> = {},
): string {
  if (value === null || value === undefined) return "";
  const attrText = Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join("");
  const inner = Array.isArray(value) ? value.join("") : escapeXml(String(value));
  return `<${name}${attrText}>${inner}</${name}>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/services/portals/dialects/xml.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/portals/dialects/xml.ts lib/services/portals/dialects/xml.test.ts
git commit -m "portals: xml builder — escaping lives in one place" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

**Post-review amendments (two follow-up commits on 2026-09-14; the committed files are the authority, not the block above):**
- `tag()`'s contract, now stated in its docstring: a blank scalar (empty or whitespace-only) renders nothing while `0` renders; a non-finite number throws a `TypeError` on both the element and the attribute path, so NaN can never reach a public feed as text; booleans are not accepted — each dialect spells yes/no itself as a string; array children may contain `null`/`undefined`/`""`, which are dropped, and an empty container still renders `<name></name>` because a container is structural.
- `escapeXml` also strips U+FFFE, U+FFFF and lone surrogate halves; tab, LF and CR survive, and a test pins that.
- Element names and attribute keys are code literals and are not escaped; the docstring says so.
- The unused `eslint-disable` directive is gone (the rule is not enabled here).
- Consequence for Task 4: the `x || null` idioms in the Kyero renderer are harmless but unnecessary, and `cond ? tag(...) : ""` may be written `cond ? tag(...) : null`. The spec's "one `xml()` builder" is `tag()`.
- 15 tests.

---

### Task 3: The feed listing shape

**Files:**
- Create: `lib/services/portals/feed-listing.ts`
- Test: `lib/services/portals/feed-listing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/services/portals/feed-listing.test.ts
import { describe, expect, it } from "vitest";
import { buildFeedListings, textIn, type PublicListingRow, type SupplementRow } from "./feed-listing";

const row = (reference: string): PublicListingRow =>
  ({
    reference,
    kind: "standalone",
    property_type: "villa",
    transaction_type: "sale",
    title: { en: "Villa" },
    short_description: {},
    adviser_view: {},
    public_description: { en: "Sea views" },
    district: { en: "Paphos" },
    area: { en: "Peyia" },
    sea_distance_m: 800,
    currency: "EUR",
    asking_price: 450000,
    rent_price_month: null,
    vat_status: "resale_no_vat",
    covered_area_sqm: 180,
    plot_area_sqm: 600,
    veranda_sqm: null,
    roof_garden_sqm: null,
    basement_sqm: null,
    bedrooms: 3,
    bathrooms: 2,
    wc: null,
    parking_spaces: 2,
    has_storage: null,
    floor_number: null,
    total_floors: null,
    year_built: 2015,
    energy_class: "B",
    features: ["pool"],
    title_deed_status: "separate",
    construction_status: null,
    delivery_date: null,
    published_at: "2026-09-01T10:00:00+00:00",
    updated_at: "2026-09-10T08:30:00+00:00",
    images: [],
  }) as unknown as PublicListingRow;

const sup = (reference: string, extra: Partial<SupplementRow> = {}): SupplementRow => ({
  reference,
  lat: 34.88,
  lng: 32.38,
  location_approx: false,
  images: [{ jpeg: "properties/x/1_jpeg.jpg", alt: { en: "Front" } }],
  ...extra,
});

describe("textIn", () => {
  it("reads a language from the CRM's {en, el, ru} JSON and trims", () => {
    expect(textIn({ en: "  Hi ", ru: "Привет" }, "en")).toBe("Hi");
    expect(textIn({ en: "Hi" }, "ru")).toBe("");
    expect(textIn(null, "en")).toBe("");
    expect(textIn("not an object", "en")).toBe("");
  });
});

describe("buildFeedListings", () => {
  it("joins rows to supplements by reference, absolutises JPEG paths, keeps row order", () => {
    const out = buildFeedListings([row("B"), row("A")], [sup("A"), sup("B")], "https://p.supabase.co/");
    expect(out.map((l) => l.row.reference)).toEqual(["B", "A"]);
    expect(out[0].images[0]).toEqual({
      url: "https://p.supabase.co/storage/v1/object/public/media/properties/x/1_jpeg.jpg",
      alt: "Front",
    });
  });

  it("drops a row with no supplement — it was not selected", () => {
    expect(buildFeedListings([row("A")], [], "https://p")).toEqual([]);
  });

  it("an approximate location yields coords with approx=true; a missing one yields null", () => {
    const [approx] = buildFeedListings([row("A")], [sup("A", { location_approx: true })], "https://p");
    expect(approx.coords).toEqual({ lat: 34.88, lng: 32.38, approx: true });
    const [none] = buildFeedListings([row("A")], [sup("A", { lat: null, lng: null })], "https://p");
    expect(none.coords).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/services/portals/feed-listing.test.ts`
Expected: FAIL — `Cannot find module './feed-listing'`

- [ ] **Step 3: Write the module**

```ts
// lib/services/portals/feed-listing.ts
import type { Database } from "@/lib/supabase/database.types";
import { publicMediaUrl } from "@/lib/services/public-listings";

/** One row of `public_listings()` as `npm run db:types` last wrote it — the site feed's shape. */
export type PublicListingRow = Database["public"]["Functions"]["public_listings"]["Returns"][number];

/** One row of `portal_supplement()` (0095): what a portal may see beyond the public feed. */
export interface SupplementRow {
  reference: string;
  lat: number | null;
  lng: number | null;
  location_approx: boolean;
  images: { jpeg: string | null; alt: unknown }[];
}

export interface FeedCoords {
  lat: number;
  lng: number;
  /** true → a dialect must not emit these as an exact point (spec §Coordinates) */
  approx: boolean;
}

export interface FeedImage {
  url: string;
  alt: string | null;
}

/** What every dialect renders from. Nothing here is not already public or selected. */
export interface FeedListing {
  row: PublicListingRow;
  coords: FeedCoords | null;
  images: FeedImage[];
}

export type Lang = "en" | "el" | "ru";

/** The CRM stores `title`, `public_description` etc. as `{en, el, ru}` JSON. */
export function textIn(json: unknown, lang: Lang): string {
  if (!json || typeof json !== "object" || Array.isArray(json)) return "";
  const v = (json as Record<string, unknown>)[lang];
  return typeof v === "string" ? v.trim() : "";
}

export function buildFeedListings(
  rows: readonly PublicListingRow[],
  supplements: readonly SupplementRow[],
  supabaseUrl: string,
): FeedListing[] {
  const byRef = new Map(supplements.map((s) => [s.reference, s]));
  const out: FeedListing[] = [];
  for (const row of rows) {
    const s = byRef.get(row.reference);
    if (!s) continue;
    const coords =
      typeof s.lat === "number" && typeof s.lng === "number"
        ? { lat: s.lat, lng: s.lng, approx: s.location_approx }
        : null;
    const images: FeedImage[] = [];
    for (const img of s.images ?? []) {
      const url = publicMediaUrl(supabaseUrl, img.jpeg);
      if (url) images.push({ url, alt: textIn(img.alt, "en") || null });
    }
    out.push({ row, coords, images });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/services/portals/feed-listing.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/portals/feed-listing.ts lib/services/portals/feed-listing.test.ts
git commit -m "portals: the feed listing shape — public row + selected-only supplement" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

**Post-review amendments (follow-up commit on 2026-09-14; the committed files are the authority, not the block above):**
- The image type is `PortalFeedImage`, not `FeedImage`, which already names the SITE feed's image shape in `public-listings.ts`.
- `FeedRow` is the renderers' input: `PublicListingRow` with honest nullability, because the codegen cannot see NOT NULL through a set-returning function and marks every column non-null while 0066 declares most of them nullable. `FeedListing.row` and `buildFeedListings` take `FeedRow`; a `PublicListingRow[]` from the route assigns to it without a cast. Fixtures are typed `FeedRow` and typecheck structurally — no `as unknown as` cast.
- `SupplementRow` stays hand-declared even after 0095 regenerates the types (the generated type would say `lat: number` and `images: Json`, both worse); Task 6 adds a key-parity type assertion against the generated `portal_supplement` return so a renamed column breaks the build.
- Alt text falls back en → ru → null. Tests pin `approx: false`, half a coordinate, image order, JPEG-less images dropped, and the alt fallback (7 tests).
- File header states why the raw row is kept rather than mapped into a DTO.

---

### Task 4: Kyero dialect with a golden file

**Files:**
- Create: `lib/services/portals/dialects/index.ts`
- Create: `lib/services/portals/dialects/kyero.ts`
- Create: `lib/services/portals/dialects/__fixtures__/listings.ts`
- Create: `lib/services/portals/dialects/__fixtures__/kyero.golden.xml` (generated in step 5)
- Test: `lib/services/portals/dialects/kyero.test.ts`

- [ ] **Step 1: Install the XML validator used by the tests**

Run: `npm install --save-dev fast-xml-parser@5`
Expected: `package.json` devDependencies gains `"fast-xml-parser": "^5..."`.

- [ ] **Step 2: Write the fixtures**

```ts
// lib/services/portals/dialects/__fixtures__/listings.ts
import type { FeedListing, PublicListingRow } from "@/lib/services/portals/feed-listing";

/**
 * Fixtures of the shape production writes (memory: "an assertion that can
 * only fail rarely is not coverage"). Dates are fixed: no clock in a golden.
 */
const base = (over: Partial<PublicListingRow>): PublicListingRow =>
  ({
    reference: "PAF0001",
    kind: "standalone",
    property_type: "villa",
    transaction_type: "sale",
    title: { en: "Sea-view villa in Peyia", el: "Βίλα με θέα", ru: "Вилла с видом на море" },
    short_description: { en: "Three-bed villa" },
    adviser_view: {},
    public_description: {
      en: "Detached villa <200 m from the coast> & pool.",
      el: "Μονοκατοικία κοντά στη θάλασσα.",
      ru: "Отдельная вилла у моря.",
    },
    district: { en: "Paphos", el: "Πάφος", ru: "Пафос" },
    area: { en: "Peyia", el: "Πέγεια", ru: "Пейя" },
    sea_distance_m: 200,
    currency: "EUR",
    asking_price: 650000,
    rent_price_month: null,
    vat_status: "resale_no_vat",
    covered_area_sqm: 210,
    plot_area_sqm: 780,
    veranda_sqm: 40,
    roof_garden_sqm: null,
    basement_sqm: null,
    bedrooms: 3,
    bathrooms: 2,
    wc: 1,
    parking_spaces: 2,
    has_storage: true,
    floor_number: null,
    total_floors: 2,
    year_built: 2016,
    energy_class: "B",
    features: ["Private pool", "Sea view"],
    title_deed_status: "separate",
    construction_status: null,
    delivery_date: null,
    published_at: "2026-09-01T10:00:00+00:00",
    updated_at: "2026-09-10T08:30:15+00:00",
    images: [],
    ...over,
  }) as unknown as PublicListingRow;

const img = (n: number): { url: string; alt: string | null } => ({
  url: `https://p.supabase.co/storage/v1/object/public/media/properties/p1/${n}_jpeg.jpg`,
  alt: n === 1 ? "Front elevation" : null,
});

/** Sale villa, three languages, exact coordinates, two photos. */
export const SALE_VILLA: FeedListing = {
  row: base({}),
  coords: { lat: 34.8821, lng: 32.3789, approx: false },
  images: [img(1), img(2)],
};

/** Rent apartment, English only, approximate location, one photo. */
export const RENT_FLAT: FeedListing = {
  row: base({
    reference: "PAF0002",
    property_type: "apartment",
    transaction_type: "rent",
    title: { en: "Two-bed apartment, Kato Paphos" },
    public_description: { en: "Furnished, second floor, lift." },
    area: { en: "Kato Paphos" },
    asking_price: null,
    rent_price_month: 1400,
    covered_area_sqm: 85,
    plot_area_sqm: null,
    bedrooms: 2,
    bathrooms: 1,
    floor_number: 2,
    total_floors: 4,
    year_built: 2009,
    energy_class: null,
    features: [],
    updated_at: "2026-09-11T12:00:00+00:00",
  }),
  coords: { lat: 34.75, lng: 32.41, approx: true },
  images: [img(1)],
};

/** Land: plot only, no bedrooms, no coordinates. */
export const LAND_PLOT: FeedListing = {
  row: base({
    reference: "PAF0003",
    property_type: "land",
    title: { en: "Residential plot, Tala" },
    public_description: { en: "Plot with planning zone Ka6." },
    area: { en: "Tala" },
    asking_price: 180000,
    covered_area_sqm: null,
    plot_area_sqm: 1200,
    veranda_sqm: null,
    bedrooms: null,
    bathrooms: null,
    wc: null,
    parking_spaces: null,
    has_storage: null,
    total_floors: null,
    year_built: null,
    energy_class: null,
    features: [],
    updated_at: "2026-09-12T09:00:00+00:00",
  }),
  coords: null,
  images: [img(1)],
};

/** Sale-or-rent with both prices: goes out once, as a sale. */
export const SALE_OR_RENT: FeedListing = {
  row: base({
    reference: "PAF0004",
    property_type: "townhouse",
    transaction_type: "sale_or_rent",
    asking_price: 320000,
    rent_price_month: 1600,
    updated_at: "2026-09-12T10:00:00+00:00",
  }),
  coords: { lat: 34.77, lng: 32.43, approx: false },
  images: [img(1), img(2)],
};

export const ALL = [SALE_VILLA, RENT_FLAT, LAND_PLOT, SALE_OR_RENT];

export const SETTINGS = {
  contact_number: "+357 26 000000",
  whatsapp_number: "+357 99 000000",
  email: "sales@example.com",
};
```

- [ ] **Step 3: Write the failing test**

```ts
// lib/services/portals/dialects/kyero.test.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { kyero, KYERO_TYPES } from "./kyero";
import { ALL, LAND_PLOT, RENT_FLAT, SALE_OR_RENT, SALE_VILLA, SETTINGS } from "./__fixtures__/listings";

const GOLDEN = join(import.meta.dirname, "__fixtures__", "kyero.golden.xml");

/** `UPDATE_GOLDEN=1 npx vitest run …kyero.test.ts` rewrites the golden. Read the diff before committing it. */
function golden(actual: string): string {
  if (process.env.UPDATE_GOLDEN || !existsSync(GOLDEN)) writeFileSync(GOLDEN, actual);
  return readFileSync(GOLDEN, "utf8");
}

const parse = (xml: string) =>
  new XMLParser({ ignoreAttributes: false, isArray: (name) => name === "property" || name === "image" || name === "feature" }).parse(xml);

describe("kyero dialect", () => {
  it("renders the golden document byte for byte", () => {
    const xml = kyero.render(ALL, SETTINGS);
    expect(xml).toBe(golden(xml));
  });

  it("is well-formed XML with the v3 header", () => {
    const xml = kyero.render(ALL, SETTINGS);
    expect(XMLValidator.validate(xml)).toBe(true);
    const doc = parse(xml);
    expect(doc.root.kyero.feed_version).toBe(3);
    expect(doc.root.property).toHaveLength(4);
  });

  it("every property carries the mandatory Kyero nodes", () => {
    const doc = parse(kyero.render(ALL, SETTINGS));
    for (const p of doc.root.property) {
      for (const k of ["id", "date", "ref", "price", "currency", "price_freq", "type", "town", "province", "country", "desc"]) {
        expect(p, `${p.ref} lacks ${k}`).toHaveProperty(k);
      }
      expect(p.country).toBe("Cyprus");
    }
  });

  it("a sale carries price_freq=sale and the asking price; a rent carries month and the monthly rent", () => {
    const doc = parse(kyero.render([SALE_VILLA, RENT_FLAT], SETTINGS));
    const [sale, rent] = doc.root.property;
    expect(sale.price_freq).toBe("sale");
    expect(sale.price).toBe(650000);
    expect(rent.price_freq).toBe("month");
    expect(rent.price).toBe(1400);
  });

  it("sale-or-rent goes out once, as a sale", () => {
    const doc = parse(kyero.render([SALE_OR_RENT], SETTINGS));
    expect(doc.root.property).toHaveLength(1);
    expect(doc.root.property[0].price_freq).toBe("sale");
    expect(doc.root.property[0].price).toBe(320000);
  });

  it("an approximate location is never emitted as coordinates", () => {
    const doc = parse(kyero.render([SALE_VILLA, RENT_FLAT], SETTINGS));
    const [exact, approx] = doc.root.property;
    expect(exact.location.latitude).toBe(34.8821);
    expect(approx.location).toBeUndefined();
  });

  it("emits en and ru descriptions, never el (Kyero has no Greek node)", () => {
    const xml = kyero.render([SALE_VILLA], SETTINGS);
    expect(xml).toContain("<desc><en>");
    expect(xml).toContain("<ru>");
    expect(xml).not.toContain("<el>");
  });

  it("escapes the description", () => {
    const xml = kyero.render([SALE_VILLA], SETTINGS);
    expect(xml).toContain("&lt;200 m from the coast&gt; &amp; pool");
  });

  it("land has a plot and no beds; the date is Kyero's format", () => {
    const doc = parse(kyero.render([LAND_PLOT], SETTINGS));
    const p = doc.root.property[0];
    expect(p.surface_area.plot).toBe(1200);
    expect(p.surface_area.built).toBeUndefined();
    expect(p.beds).toBeUndefined();
    expect(p.date).toBe("2026-09-12 09:00:00");
  });

  it("caps images at fifty", () => {
    const many = { ...SALE_VILLA, images: Array.from({ length: 60 }, (_, i) => ({ url: `https://x/${i}.jpg`, alt: null })) };
    const doc = parse(kyero.render([many], SETTINGS));
    expect(doc.root.property[0].images.image).toHaveLength(50);
  });

  it("the empty document is well-formed and holds no property", () => {
    expect(XMLValidator.validate(kyero.empty())).toBe(true);
    expect(kyero.empty()).not.toContain("<property>");
  });

  it("maps every CRM property type it can and leaves mixed_use/other unmapped", () => {
    expect(KYERO_TYPES.villa).toBe("Villa");
    expect(KYERO_TYPES.land).toBe("Land");
    expect(KYERO_TYPES.mixed_use).toBeUndefined();
    expect(KYERO_TYPES.other).toBeUndefined();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run lib/services/portals/dialects/kyero.test.ts`
Expected: FAIL — `Cannot find module './kyero'`

- [ ] **Step 5: Write the dialect interface and the Kyero renderer**

```ts
// lib/services/portals/dialects/index.ts
import type { FeedListing } from "@/lib/services/portals/feed-listing";
import type { Dialect } from "@/lib/services/portals/registry";
import { kyero, KYERO_CURRENCIES, KYERO_TYPES } from "./kyero";

/**
 * A dialect is a pure function from listings to a document. This interface is
 * the seam the spec names: a push adapter (milestone "never", unless the
 * operator changes course) would implement a sibling interface reading the
 * same `FeedListing`.
 */
export interface DialectRenderer {
  render(listings: readonly FeedListing[], settings: Record<string, string>): string;
  /** what a DISABLED portal's URL answers: valid, and empty, so the portal clears its copy */
  empty(): string;
  contentType: string;
}

/** `null` = no renderer yet (spec pending). The registry's `spec` field and this table must agree — eligibility.test pins it. */
export const DIALECT_RENDERERS: Record<Dialect, DialectRenderer | null> = {
  kyero,
  rera: null,
  trovit: null,
  bazaraki: null,
  prian: null,
};

/** CRM `property_type` → the dialect's type value. A type absent here is ineligible for that dialect. */
export const DIALECT_TYPE_MAPS: Record<Dialect, Readonly<Record<string, string>>> = {
  kyero: KYERO_TYPES,
  rera: {},
  trovit: {},
  bazaraki: {},
  prian: {},
};

/** Currencies the dialect can express; `null` = any. */
export const DIALECT_CURRENCIES: Record<Dialect, readonly string[] | null> = {
  kyero: KYERO_CURRENCIES,
  rera: ["EUR"],
  trovit: null,
  bazaraki: null,
  prian: null,
};
```

```ts
// lib/services/portals/dialects/kyero.ts
import { textIn, type FeedListing } from "@/lib/services/portals/feed-listing";
import type { DialectRenderer } from "./index";
import { XML_HEADER, tag } from "./xml";

/**
 * Kyero XML v3.9 (help.kyero.com/estate-agents/xml-import-specification,
 * 2024-09-03). The lingua franca: JamesEdition, A Place in the Sun, Properstar
 * and the UK feed providers all ingest it. Absolute feed, all lowercase tags,
 * UTF-8, ≤ 50 photos, `date` drives updates, absence means removal.
 */
export const KYERO_TYPES: Readonly<Record<string, string>> = {
  apartment: "Apartment",
  villa: "Villa",
  townhouse: "Town House",
  house: "House",
  land: "Land",
  shop: "Commercial",
  office: "Commercial",
  warehouse: "Commercial",
  building: "Building",
  hotel: "Hotel",
};

export const KYERO_CURRENCIES = ["EUR", "GBP", "USD"] as const;

const MAX_IMAGES = 50;

/** `2026-09-10T08:30:15+00:00` → `2026-09-10 08:30:15` (UTC; Kyero wants a wall-clock string). */
function kyeroDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
}

function renderProperty(l: FeedListing, settings: Record<string, string>): string {
  const r = l.row;
  const isRent = r.transaction_type === "rent";
  const price = isRent ? r.rent_price_month : r.asking_price;
  const children: string[] = [
    tag("id", r.reference),
    tag("date", kyeroDate(r.updated_at)),
    tag("ref", r.reference),
    tag("price", price == null ? null : Math.round(Number(price))),
    tag("currency", r.currency),
    tag("price_freq", isRent ? "month" : "sale"),
    tag("type", KYERO_TYPES[r.property_type] ?? null),
    tag("town", textIn(r.area, "en") || textIn(r.district, "en")),
    tag("province", textIn(r.district, "en")),
    tag("country", "Cyprus"),
  ];
  if (l.coords && !l.coords.approx) {
    children.push(tag("location", [tag("latitude", l.coords.lat), tag("longitude", l.coords.lng)]));
  }
  children.push(
    tag("beds", r.bedrooms),
    tag("baths", r.bathrooms),
    tag("surface_area", [
      tag("built", r.covered_area_sqm == null ? null : Math.round(Number(r.covered_area_sqm))),
      tag("plot", r.plot_area_sqm == null ? null : Math.round(Number(r.plot_area_sqm))),
    ]),
    r.energy_class ? tag("energy_rating", [tag("consumption", r.energy_class)]) : "",
    tag("desc", [tag("en", textIn(r.public_description, "en")), tag("ru", textIn(r.public_description, "ru") || null)]),
  );
  const features = (r.features ?? []).filter((f) => f && f.trim());
  if (features.length) children.push(tag("features", features.map((f) => tag("feature", f))));
  children.push(
    tag(
      "images",
      l.images.slice(0, MAX_IMAGES).map((img, i) => tag("image", [tag("url", img.url)], { id: i + 1 })),
    ),
    tag("contact_number", settings.contact_number || null),
    tag("whatsapp_number", settings.whatsapp_number || null),
    tag("email", settings.email || null),
  );
  return tag("property", children);
}

const HEADER = tag("kyero", [tag("feed_version", 3)]);

export const kyero: DialectRenderer = {
  contentType: "application/xml; charset=utf-8",
  render(listings, settings) {
    const body = listings.map((l) => renderProperty(l, settings)).join("\n");
    return `${XML_HEADER}<root>\n${HEADER}\n${body}\n</root>\n`;
  },
  empty() {
    return `${XML_HEADER}<root>\n${HEADER}\n</root>\n`;
  },
};
```

Note the import cycle `index.ts ↔ kyero.ts` is type-only from `kyero.ts`'s side (`import type`), which TypeScript erases; `index.ts` imports the value. This is the same shape as `feed-etag.ts`'s consumers and is fine under Vite's module graph.

- [ ] **Step 6: Run the test to generate the golden, then read it**

Run: `npx vitest run lib/services/portals/dialects/kyero.test.ts`
Expected: PASS (12 tests). The first run writes `__fixtures__/kyero.golden.xml`.

Open the golden and check by eye: four `<property>` blocks; PAF0001 has `<location>`, PAF0002 does not; PAF0003 has `<plot>1200</plot>` and no `<built>`; the description shows `&lt;200 m from the coast&gt; &amp; pool`; `<contact_number>+357 26 000000</contact_number>` appears in every property.

- [ ] **Step 7: Run the whole unit suite**

Run: `npm test`
Expected: all green; the count grew by the new files' tests.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json lib/services/portals/dialects/
git commit -m "portals: Kyero v3.9 dialect with a golden document" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

**Amendments applied at implementation and after review (2026-09-14; the committed files are the authority, not the block above):**
- `registry.ts` exports `kyeroSettingsSchema` and `KyeroSettings`; `kyero.render` parses its settings with the schema first, so defaults apply and a typo'd key is a compile error. A test pins that `{}` emits no contact nodes and a malformed e-mail throws.
- Fixtures are typed `(over: Partial<FeedRow>): FeedRow` with no cast and use `PortalFeedImage`; all 36 columns present.
- Blank text is left to `tag()` (no `|| null`), optional children are `cond ? tag(...) : null`, and prices/areas are rounded without a `Number()` wrapper — PostgREST numeric is a JS number here.
- Features are filtered for blanks BEFORE the element is gated, so an all-blank array emits no `<features>` element; a test pins it (14 tests).
- The test-side parser/validator is `fast-xml-parser` on the self-contained **v4** line, pinned exactly (v5 pulled seven small transitive dev packages).
- Not pinned by the golden: a listing with both areas null renders `<surface_area></surface_area>`, and one with no images `<images></images>`, both by `tag()`'s container rule.

**Quality-review follow-ups (third commit on 2026-09-14):**
- `DialectRenderer` lives in `dialects/types.ts`; `index.ts` re-exports it and states why the dialect tables are tables rather than renderer fields (eligibility must answer for dialects with no renderer yet).
- `feedPrice(row)` in `feed-listing.ts` is the one definition of the price a portal shows; the renderer and both eligibility adapters (Task 5) use it.
- Energy class goes through `KYERO_ENERGY`: Cyprus's `B+` folds to `B`; anything outside A–G is omitted.
- `surface_area` and `images` are gated like `features`: nothing inside, no element.
- A fifth fixture, `SHOP_UNIT` (commercial, energy B+, one photo), joins `ALL`; `SETTINGS` is `KYERO_SETTINGS`; the golden was regenerated deliberately and its diff read.
- The golden is written only under `UPDATE_GOLDEN=1`; a missing golden throws instead of blessing whatever the code produced.
- The type map is pinned against `PROPERTY_TYPES` from `lib/validators/properties.ts` (every CRM type maps except `mixed_use` and `other`; shop/office/warehouse fold to Commercial). 17 tests.
- Not changed, noted for the runbook and milestone 2: Kyero's `<type>` vocabulary for "Land" and "Building" is unverified until the validator run; `<new_build>` and a `<url>` back-link are operator questions.

---

### Task 5: Eligibility, one definition

**Files:**
- Create: `lib/services/portals/eligibility.ts`
- Test: `lib/services/portals/eligibility.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/services/portals/eligibility.test.ts
import { describe, expect, it } from "vitest";
import { DIALECT_RENDERERS } from "./dialects";
import { SALE_VILLA, RENT_FLAT, LAND_PLOT } from "./dialects/__fixtures__/listings";
import { eligibilityFor, eligibilityInputFromFeed, REASON_TEXT, type EligibilityInput } from "./eligibility";
import { PORTALS, portalById } from "./registry";

const je = portalById("jamesedition")!;
const ok: EligibilityInput = {
  isPublic: true,
  hasPrice: true,
  currency: "EUR",
  descriptionEn: "A villa",
  photoCount: 2,
  coords: { lat: 34.8, lng: 32.4, approx: false },
  propertyType: "villa",
  districtEn: "Paphos",
  areaEn: "Peyia",
};

describe("eligibilityFor", () => {
  it("passes a complete public listing", () => {
    expect(eligibilityFor(je, ok)).toEqual({ ok: true });
  });

  it.each([
    ["not_public", { isPublic: false }],
    ["no_price", { hasPrice: false }],
    ["currency_unsupported", { currency: "RUB" }],
    ["no_description_en", { descriptionEn: "   " }],
    ["too_few_photos", { photoCount: 1 }],
    ["type_unmapped", { propertyType: "mixed_use" }],
  ] as const)("reports %s", (reason, patch) => {
    const r = eligibilityFor(je, { ...ok, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toEqual([reason]);
  });

  it("reports every failing reason, not just the first", () => {
    const r = eligibilityFor(je, { ...ok, hasPrice: false, photoCount: 0 });
    if (r.ok) throw new Error("expected failure");
    expect(r.reasons).toEqual(["no_price", "too_few_photos"]);
  });

  it("needsCoords is a per-portal requirement", () => {
    const strict = { ...je, requirements: { ...je.requirements, needsCoords: true } };
    const r = eligibilityFor(strict, { ...ok, coords: null });
    if (r.ok) throw new Error("expected failure");
    expect(r.reasons).toEqual(["no_coords"]);
  });

  it("a pending portal maps no types, so nothing is eligible for it", () => {
    const r = eligibilityFor(portalById("bazaraki")!, ok);
    if (r.ok) throw new Error("expected failure");
    expect(r.reasons).toContain("type_unmapped");
  });

  it("every reason has words for the desk", () => {
    for (const k of ["not_public", "no_price", "currency_unsupported", "no_description_en", "too_few_photos", "no_coords", "type_unmapped", "city_unmapped"] as const) {
      expect(REASON_TEXT[k].length).toBeGreaterThan(10);
    }
  });

  it("registry `spec` and the renderer table agree", () => {
    for (const p of PORTALS) {
      expect(DIALECT_RENDERERS[p.dialect] !== null, `${p.id}: spec=${p.spec}`).toBe(p.spec === "public");
    }
  });
});

describe("eligibilityInputFromFeed", () => {
  it("reads the feed listing: a feed row is public by construction", () => {
    const i = eligibilityInputFromFeed(SALE_VILLA);
    expect(i).toEqual({
      isPublic: true,
      hasPrice: true,
      currency: "EUR",
      descriptionEn: "Detached villa <200 m from the coast> & pool.",
      photoCount: 2,
      coords: { lat: 34.8821, lng: 32.3789, approx: false },
      propertyType: "villa",
      districtEn: "Paphos",
      areaEn: "Peyia",
    });
  });

  it("a rent listing has a price when the monthly rent is set; land has coords null", () => {
    expect(eligibilityInputFromFeed(RENT_FLAT).hasPrice).toBe(true);
    expect(eligibilityInputFromFeed(LAND_PLOT).coords).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/services/portals/eligibility.test.ts`
Expected: FAIL — `Cannot find module './eligibility'`

- [ ] **Step 3: Write the module**

```ts
// lib/services/portals/eligibility.ts
import { DIALECT_CURRENCIES, DIALECT_TYPE_MAPS } from "./dialects";
import { textIn, type FeedCoords, type FeedListing } from "./feed-listing";
import type { PortalDefinition } from "./registry";

/**
 * Why a listing may or may not go to a portal (spec §Eligibility). ONE
 * function, two consumers: the feed route silently excludes, the property
 * card shows the reasons. `city_unmapped` is reserved for the RERA dialect
 * (milestone 2) and is listed so the desk text exists when it lands.
 */
export type EligibilityReason =
  | "not_public"
  | "no_price"
  | "currency_unsupported"
  | "no_description_en"
  | "too_few_photos"
  | "no_coords"
  | "type_unmapped"
  | "city_unmapped";

export interface EligibilityInput {
  /** would the site feed show it: visibility public AND status available */
  isPublic: boolean;
  hasPrice: boolean;
  currency: string;
  descriptionEn: string;
  /** photos with a JPEG rendition — what the portal will actually receive */
  photoCount: number;
  coords: FeedCoords | null;
  propertyType: string;
  districtEn: string | null;
  areaEn: string | null;
}

export type Eligibility = { ok: true } | { ok: false; reasons: EligibilityReason[] };

export const REASON_TEXT: Record<EligibilityReason, string> = {
  not_public: "Not on the website: the listing must be public and available.",
  no_price: "No asking price or monthly rent.",
  currency_unsupported: "This portal cannot show the listing's currency.",
  no_description_en: "No English public description.",
  too_few_photos: "Too few photos with a JPEG rendition for this portal.",
  no_coords: "This portal requires map coordinates.",
  type_unmapped: "This portal has no category for this property type.",
  city_unmapped: "This portal does not recognise the listing's town.",
};

export function eligibilityFor(portal: PortalDefinition, input: EligibilityInput): Eligibility {
  const reasons: EligibilityReason[] = [];
  if (!input.isPublic) reasons.push("not_public");
  if (!input.hasPrice) reasons.push("no_price");
  const currencies = DIALECT_CURRENCIES[portal.dialect];
  if (currencies && !currencies.includes(input.currency)) reasons.push("currency_unsupported");
  if (!input.descriptionEn.trim()) reasons.push("no_description_en");
  if (input.photoCount < portal.requirements.minPhotos) reasons.push("too_few_photos");
  if (portal.requirements.needsCoords && !input.coords) reasons.push("no_coords");
  if (!(input.propertyType in DIALECT_TYPE_MAPS[portal.dialect])) reasons.push("type_unmapped");
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

/** The feed route's adapter. A `public_listings` row is public by construction. */
export function eligibilityInputFromFeed(l: FeedListing): EligibilityInput {
  const r = l.row;
  const isRent = r.transaction_type === "rent";
  return {
    isPublic: true,
    hasPrice: isRent ? r.rent_price_month != null : r.asking_price != null,
    currency: r.currency,
    descriptionEn: textIn(r.public_description, "en"),
    photoCount: l.images.length,
    coords: l.coords,
    propertyType: r.property_type,
    districtEn: textIn(r.district, "en") || null,
    areaEn: textIn(r.area, "en") || null,
  };
}

/** The property page's adapter — from the row the page already holds. */
export function eligibilityInputFromProperty(p: {
  visibility: string;
  status: string;
  transaction_type: string;
  asking_price: number | null;
  rent_price_month: number | null;
  currency: string;
  public_description: unknown;
  property_type: string;
  districtName: unknown;
  areaName: unknown;
  jpegPhotoCount: number;
  coords: FeedCoords | null;
}): EligibilityInput {
  const isRent = p.transaction_type === "rent";
  return {
    isPublic: p.visibility === "public" && p.status === "available",
    hasPrice: isRent ? p.rent_price_month != null : p.asking_price != null,
    currency: p.currency,
    descriptionEn: textIn(p.public_description, "en"),
    photoCount: p.jpegPhotoCount,
    coords: p.coords,
    propertyType: p.property_type,
    districtEn: textIn(p.districtName, "en") || null,
    areaEn: textIn(p.areaName, "en") || null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/services/portals/eligibility.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/services/portals/eligibility.ts lib/services/portals/eligibility.test.ts
git commit -m "portals: eligibility — one rule for the feed and the toggles" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

**Amendments applied at implementation (2026-09-14; the committed files are the authority, not the block above):**
- `hasPrice` in both adapters comes from `feedPrice()` in `feed-listing.ts`; there is no third copy of the rent/sale rule.
- A new reason, `no_location_text`: Kyero's mandatory `<town>` and `<province>` come from `area.en` and `district.en`, so a listing with both blank is ineligible for every portal. One of the two suffices.
- Type-map membership uses `Object.hasOwn`, never `in` (which answers true for `"constructor"`); a test pins it.
- Fixture names follow Task 4: `KYERO_SETTINGS`, and `SHOP_UNIT` (one photo) is the JamesEdition `too_few_photos` case. 21 tests. The property-page adapter feeds `feedPrice()` through an `as Parameters<typeof feedPrice>[0]` cast because the page row types `transaction_type` as a plain string.

---

### Task 6: Migration 0095

**Files:**
- Create: `supabase/migrations/0095_portal_syndication.sql`
- Modify: `scripts/backup/verify-restore.sql` (migrations pin 94 → 95; regenerate the function-grants table)
- Modify: `docs/04_RLS_POLICY_MATRIX.md` (two rows)
- Modify: `lib/supabase/database.types.ts` (regenerated)

- [ ] **Step 1: Write the migration**

```sql
-- =============================================================================
-- 0095 — portal syndication: where a listing is advertised beyond the site
--        (docs/superpowers/specs/2026-09-14-portal-syndication-design.md)
--
-- WHAT THIS ADDS. Two tables and three anon-callable functions so that an
-- external portal can PULL a feed of exactly the listings the desk selected
-- for it, and one column so those feeds can hand out JPEG photographs.
--
--   portal_connections  one row per org per portal: enabled, a random feed
--                       token that IS the URL, non-secret settings, and the
--                       "last pulled" facts the route writes. Admin-write.
--   portal_listings     one row per listing per portal: selected by whom,
--                       when. Deselecting deletes the row; the events chain
--                       keeps the history. Writable by whoever may edit the
--                       listing (same rule as properties_update).
--   property_media.path_jpeg   a fourth rendition (1600 px JPEG), because
--                       RERA accepts JPEG/PNG only and four other portals
--                       leave the format undocumented. Null until backfilled.
--
-- THE PREDICATE IS THE SITE'S. portal_supplement() answers only for selected
-- rows that public_listings() would show (visibility public, status
-- available) — copied here rather than referenced because a SECURITY DEFINER
-- function cannot call the other's row filter, and RLS test portals.test.ts
-- pins the two together. So "on a portal" ⊆ "on the site", and a sale,
-- withdrawal or archive leaves every portal at its next pull.
--
-- COORDINATES LEAVE HERE AND NOWHERE ELSE. public_listings() carries none;
-- this function returns them for selected listings only, with the approx
-- flag the dialects honour (an approximate location is never emitted as an
-- exact point — spec §Coordinates).
--
-- public_listings() and public_listings_etag() are untouched: the site feed
-- stays byte-identical and RLS test 41's 36-column pin stays true.
--
-- Additive: apply to hosted BEFORE the merge.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. portal_connections
-- ---------------------------------------------------------------------------
create table if not exists public.portal_connections (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  -- a registry id (lib/services/portals/registry.ts); the shape is pinned here, the list there
  portal           text not null check (portal ~ '^[a-z_]{2,40}$'),
  enabled          boolean not null default false,
  -- the URL's secret: 32 random bytes as hex. Rotated by setting a new value, never null.
  feed_token       text not null unique default encode(gen_random_bytes(32), 'hex')
                   check (feed_token ~ '^[0-9a-f]{64}$'),
  -- non-secret per-portal fields (contact number, e-mail); validated by the registry's schema on write
  settings         jsonb not null default '{}'::jsonb,
  last_pulled_at   timestamptz,
  last_pulled_ua   text,
  last_pull_count  int,
  -- milestone 3: the JamesEdition leads pull's upper bound
  leads_pulled_to  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  updated_by       uuid references public.profiles(id) on delete set null,
  unique (org_id, portal)
);
comment on table public.portal_connections is
  'One row per organisation per external portal (0095). enabled + feed_token '
  'make the pull URL /api/portals/<portal>/<token>; settings holds the '
  'portal''s non-secret fields; the last_pull* columns are written by the '
  'route on every pull. Secrets (a leads API token) live in the Vercel '
  'environment, never here.';

drop trigger if exists portal_connections_updated_at on public.portal_connections;
create trigger portal_connections_updated_at
  before update on public.portal_connections
  for each row execute function set_updated_at();

alter table public.portal_connections enable row level security;
revoke all privileges on table public.portal_connections from anon;
revoke all privileges on table public.portal_connections from authenticated;
-- No DELETE: a portal is disabled, not forgotten (its token would otherwise
-- come back different and the portal would be pointed at a dead URL).
grant select, insert, update on table public.portal_connections to authenticated;

drop policy if exists portal_connections_select on public.portal_connections;
create policy portal_connections_select on public.portal_connections for select
  using (org_id = (select public.current_org_id()));
drop policy if exists portal_connections_insert on public.portal_connections;
create policy portal_connections_insert on public.portal_connections for insert
  with check (org_id = (select public.current_org_id())
              and (select public.current_role_gnk()) = 'admin');
drop policy if exists portal_connections_update on public.portal_connections;
create policy portal_connections_update on public.portal_connections for update
  using (org_id = (select public.current_org_id())
         and (select public.current_role_gnk()) = 'admin')
  with check (org_id = (select public.current_org_id())
              and (select public.current_role_gnk()) = 'admin');
-- A TABLE CREATED AFTER 0029 DOES NOT INHERIT require_aal2; rls_aal2_coverage() must stay at 0.
drop policy if exists require_aal2 on public.portal_connections;
create policy require_aal2 on public.portal_connections
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));

-- ---------------------------------------------------------------------------
-- 2. portal_listings
-- ---------------------------------------------------------------------------
create table if not exists public.portal_listings (
  property_id  uuid not null references public.properties(id) on delete cascade,
  portal       text not null check (portal ~ '^[a-z_]{2,40}$'),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  selected_at  timestamptz not null default now(),
  selected_by  uuid references public.profiles(id) on delete set null,
  primary key (property_id, portal)
);
create index if not exists portal_listings_org_portal_idx
  on public.portal_listings (org_id, portal);
comment on table public.portal_listings is
  'A listing chosen for a portal (0095). Per listing only — no rules. '
  'Deselecting deletes the row; portal_selected / portal_removed events on '
  'the property carry the history. The feed shows a row only while the site '
  'feed would (portal_supplement).';

alter table public.portal_listings enable row level security;
revoke all privileges on table public.portal_listings from anon;
revoke all privileges on table public.portal_listings from authenticated;
grant select, insert, delete on table public.portal_listings to authenticated;

drop policy if exists portal_listings_select on public.portal_listings;
create policy portal_listings_select on public.portal_listings for select
  using (org_id = (select public.current_org_id()));
-- Whoever may UPDATE the property may put it on a portal: the properties_update
-- rule (0002) verbatim, evaluated against the listing's own row.
drop policy if exists portal_listings_insert on public.portal_listings;
create policy portal_listings_insert on public.portal_listings for insert
  with check (
    org_id = (select public.current_org_id())
    and selected_by = (select auth.uid())
    and exists (
      select 1 from public.properties p
       where p.id = property_id
         and p.org_id = (select public.current_org_id())
         and ((select public.current_role_gnk()) in ('admin', 'listing_manager')
              or ((select public.current_role_gnk()) = 'agent'
                  and p.assigned_agent_id = (select auth.uid())))
    )
  );
drop policy if exists portal_listings_delete on public.portal_listings;
create policy portal_listings_delete on public.portal_listings for delete
  using (
    org_id = (select public.current_org_id())
    and exists (
      select 1 from public.properties p
       where p.id = property_id
         and p.org_id = (select public.current_org_id())
         and ((select public.current_role_gnk()) in ('admin', 'listing_manager')
              or ((select public.current_role_gnk()) = 'agent'
                  and p.assigned_agent_id = (select auth.uid())))
    )
  );
drop policy if exists require_aal2 on public.portal_listings;
create policy require_aal2 on public.portal_listings
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));

-- ---------------------------------------------------------------------------
-- 3. The JPEG rendition
-- ---------------------------------------------------------------------------
alter table public.property_media add column if not exists path_jpeg text;
comment on column public.property_media.path_jpeg is
  'Fourth rendition (0095): 1600 px JPEG beside the WebP full, same watermark '
  'policy, for portal feeds. Null until scripts/media/backfill-jpeg.mts has run.';

-- ---------------------------------------------------------------------------
-- 4. The three anon-callable functions
-- ---------------------------------------------------------------------------
create or replace function public.portal_connection_by_token(p_portal text, p_token text)
returns table (org_slug text, enabled boolean, settings jsonb)
language sql stable security definer set search_path = public as $$
  select o.slug, c.enabled, c.settings
    from portal_connections c
    join organizations o on o.id = c.org_id
   where c.portal = p_portal
     and c.feed_token = p_token
$$;

create or replace function public.portal_supplement(p_token text)
returns table (
  reference       text,
  lat             double precision,
  lng             double precision,
  location_approx boolean,
  images          jsonb
)
language sql stable security definer set search_path = public as $$
  select p.reference,
         st_y(p.location::geometry),
         st_x(p.location::geometry),
         p.location_approx,
         coalesce((
           select jsonb_agg(jsonb_build_object('jpeg', m.path_jpeg, 'alt', m.alt)
                            order by m.is_cover desc, m.sort_order, m.created_at)
             from property_media m
            where m.property_id = p.id
              and m.kind = 'photo'
              and m.path_jpeg is not null
         ), '[]'::jsonb)
    from portal_connections c
    join portal_listings pl on pl.org_id = c.org_id and pl.portal = c.portal
    join properties p on p.id = pl.property_id
   where c.feed_token = p_token
     and c.enabled
     -- the site feed's predicate (0088 public_listings), pinned together by portals.test.ts
     and p.visibility = 'public'
     and p.status     = 'available'
$$;

create or replace function public.note_portal_pull(p_token text, p_ua text, p_count int)
returns void
language sql volatile security definer set search_path = public as $$
  update portal_connections
     set last_pulled_at  = now(),
         last_pulled_ua  = left(coalesce(p_ua, ''), 200),
         last_pull_count = p_count
   where feed_token = p_token
$$;

-- The feed is public by design (spec §Decisions); everything else stays off.
revoke execute on function public.portal_connection_by_token(text, text) from public;
grant  execute on function public.portal_connection_by_token(text, text) to anon, authenticated, service_role;
revoke execute on function public.portal_supplement(text) from public;
grant  execute on function public.portal_supplement(text) to anon, authenticated, service_role;
revoke execute on function public.note_portal_pull(text, text, int) from public;
grant  execute on function public.note_portal_pull(text, text, int) to anon, authenticated, service_role;
```

- [ ] **Step 2: Apply it locally and regenerate types**

Run: `npx supabase db reset` (applies all 95 migrations and `supabase/dev-fixtures.sql`), then `npm run db:types`.
Expected: `lib/supabase/database.types.ts` now has `portal_connections`, `portal_listings`, `property_media.path_jpeg`, and the three functions under `Functions`. Run `npm run typecheck` — expected clean (nothing uses them yet).

- [ ] **Step 3: Bump the restore drill's pins**

In `scripts/backup/verify-restore.sql`, change `94::bigint as migrations` to `95::bigint as migrations`. Then regenerate the function-grants table: run the `select distinct p.proname, p.prosecdef, has_function_privilege(...)` query printed in the comment above that table against the local database

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -At -F ',' -f /tmp/grants-query.sql
```

(the query text copied from the comment into `/tmp/grants-query.sql` — a file, not a heredoc), and paste the rows over the table. The three new functions appear with `anon=true`; nothing else changes.

Run: `npx vitest run scripts/backup/verify-restore.test.ts`
Expected: PASS ("pins exactly as many migrations as the repo ships").

- [ ] **Step 4: Document the policies**

Append to the table in `docs/04_RLS_POLICY_MATRIX.md`, after the `interaction_notes` row:

```markdown
| portal_connections | A AG LM | A | A | ❌ | 0095: one row per org per portal — enabled, feed token, non-secret settings, last-pull facts. Disabled, never deleted. `portal_connection_by_token` / `note_portal_pull` are SECURITY DEFINER and anon-callable by token. |
| portal_listings | A AG LM | A LM, AG on an assigned listing (`selected_by = uid`) | ❌ | A LM, AG on an assigned listing | 0095: a listing chosen for a portal. Same rule as `properties_update`. `portal_supplement` (SECURITY DEFINER, by token) returns selected rows that the site feed would show — the only place coordinates leave. |
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0095_portal_syndication.sql lib/supabase/database.types.ts scripts/backup/verify-restore.sql docs/04_RLS_POLICY_MATRIX.md
git commit -m "0095: portal_connections, portal_listings, path_jpeg, three anon feed functions" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: RLS tests for 0095

**Files:**
- Create: `supabase/tests/portals.test.ts`

- [ ] **Step 1: Write the tests**

```ts
// supabase/tests/portals.test.ts
/**
 * 0095 — portal syndication. Who may write the connection, who may select a
 * listing, and what a token reveals. Requires the local stack: npm run test:rls
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ORG_A,
  ORG_B,
  anonClient,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

const svc = serviceClient();
const anon = anonClient();
const run = Date.now().toString(36);
const PORTAL = "jamesedition";

let adminA: TestUser;
let agentA: TestUser;
let adminB: TestUser;
let token = "";
let publicId = "";
let privateId = "";
let mediaIds: string[] = [];

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  await ensureTestOrg(svc, ORG_B, "Test Org B", "test-org-b");
  adminA = await createTestUser(svc, `portals-adm-${run}@example.invalid`, "admin", ORG_A, { enrolFactor: true });
  agentA = await createTestUser(svc, `portals-agt-${run}@example.invalid`, "agent", ORG_A, { enrolFactor: true });
  adminB = await createTestUser(svc, `portals-admb-${run}@example.invalid`, "admin", ORG_B, { enrolFactor: true });

  // a fresh connection row for this run (service role; the admin tests below write their own)
  const { data: conn, error } = await svc
    .from("portal_connections")
    .upsert({ org_id: ORG_A, portal: PORTAL, enabled: true }, { onConflict: "org_id,portal" })
    .select("feed_token")
    .single();
  if (error) throw new Error(error.message);
  token = conn.feed_token;

  const mk = async (ref: string, visibility: "public" | "private", assigned: string | null) => {
    const { data, error } = await svc
      .from("properties")
      .insert({
        org_id: ORG_A,
        reference: ref.slice(0, 20),
        property_type: "villa",
        status: "available",
        visibility,
        asking_price: 500000,
        currency: "EUR",
        public_description: { en: "Test villa" },
        assigned_agent_id: assigned,
        location: "SRID=4326;POINT(32.38 34.88)",
        location_approx: false,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id as string;
  };
  publicId = await mk(`ZZPRT-P${run}`, "public", agentA.id);
  privateId = await mk(`ZZPRT-X${run}`, "private", null);

  const { data: media, error: mErr } = await svc
    .from("property_media")
    .insert([
      { org_id: ORG_A, property_id: publicId, kind: "photo", path_full: `t/${run}_1_full.webp`, path_jpeg: `t/${run}_1_jpeg.jpg`, is_cover: true, sort_order: 0, alt: { en: "Front" } },
      { org_id: ORG_A, property_id: publicId, kind: "photo", path_full: `t/${run}_2_full.webp`, path_jpeg: null, is_cover: false, sort_order: 1 },
      { org_id: ORG_A, property_id: publicId, kind: "plan", path_full: `t/${run}_3_full.webp`, path_jpeg: `t/${run}_3_jpeg.jpg`, is_cover: false, sort_order: 2 },
    ])
    .select("id");
  if (mErr) throw new Error(mErr.message);
  mediaIds = (media ?? []).map((m) => m.id as string);
});

afterAll(async () => {
  await svc.from("property_media").delete().in("id", mediaIds);
  await svc.from("properties").delete().in("id", [publicId, privateId]);
});

describe("portal_connections", () => {
  it("an agent cannot enable a portal (insert refused, update matches 0 rows)", async () => {
    const ins = await agentA.client.from("portal_connections").insert({ org_id: ORG_A, portal: "properstar" });
    expect(ins.error?.code).toBe("42501");
    const upd = await agentA.client.from("portal_connections").update({ enabled: false }).eq("portal", PORTAL).select("id");
    expect(upd.error).toBeNull();
    expect(upd.data).toHaveLength(0);
  });

  it("an admin of another org sees nothing and changes nothing", async () => {
    const sel = await adminB.client.from("portal_connections").select("id").eq("org_id", ORG_A);
    expect(sel.data).toHaveLength(0);
    const upd = await adminB.client.from("portal_connections").update({ enabled: false }).eq("org_id", ORG_A).select("id");
    expect(upd.data).toHaveLength(0);
  });

  it("an admin of the org may update it, and the token is never readable by anon", async () => {
    const upd = await adminA.client.from("portal_connections").update({ settings: { email: "x@y.z" } }).eq("portal", PORTAL).select("id");
    expect(upd.error).toBeNull();
    expect(upd.data).toHaveLength(1);
    const a = await anon.from("portal_connections").select("feed_token");
    expect(a.error?.code ?? "42501").toBe("42501");
  });
});

describe("portal_listings", () => {
  afterAll(async () => {
    await svc.from("portal_listings").delete().in("property_id", [publicId, privateId]);
  });

  it("an agent may select a listing assigned to them and not one that is not", async () => {
    const own = await agentA.client
      .from("portal_listings")
      .insert({ org_id: ORG_A, property_id: publicId, portal: PORTAL, selected_by: agentA.id });
    expect(own.error).toBeNull();
    const other = await agentA.client
      .from("portal_listings")
      .insert({ org_id: ORG_A, property_id: privateId, portal: PORTAL, selected_by: agentA.id });
    expect(other.error?.code).toBe("42501");
  });

  it("a delete by someone who may not edit the listing matches 0 rows", async () => {
    const del = await adminB.client.from("portal_listings").delete().eq("property_id", publicId).select("portal");
    expect(del.data).toHaveLength(0);
  });

  it("selecting cannot be filed under another user's name", async () => {
    const r = await agentA.client
      .from("portal_listings")
      .insert({ org_id: ORG_A, property_id: publicId, portal: "properstar", selected_by: adminA.id });
    expect(r.error?.code).toBe("42501");
  });
});

describe("the token functions (anon)", () => {
  beforeAll(async () => {
    await svc.from("portal_listings").upsert([
      { org_id: ORG_A, property_id: publicId, portal: PORTAL, selected_by: adminA.id },
      { org_id: ORG_A, property_id: privateId, portal: PORTAL, selected_by: adminA.id },
    ]);
  });
  afterAll(async () => {
    await svc.from("portal_listings").delete().in("property_id", [publicId, privateId]);
    await svc.from("portal_connections").update({ enabled: true }).eq("feed_token", token);
  });

  it("a wrong token answers nothing; the right one answers the org slug", async () => {
    const wrong = await anon.rpc("portal_connection_by_token", { p_portal: PORTAL, p_token: "f".repeat(64) });
    expect(wrong.error).toBeNull();
    expect(wrong.data).toHaveLength(0);
    const right = await anon.rpc("portal_connection_by_token", { p_portal: PORTAL, p_token: token });
    expect(right.data?.[0]).toMatchObject({ org_slug: "test-org-a", enabled: true });
    const otherPortal = await anon.rpc("portal_connection_by_token", { p_portal: "properstar", p_token: token });
    expect(otherPortal.data).toHaveLength(0);
  });

  it("portal_supplement returns the selected public listing with coords and only JPEG photos, never the private one", async () => {
    const { data, error } = await anon.rpc("portal_supplement", { p_token: token });
    expect(error).toBeNull();
    const refs = (data ?? []).map((r) => r.reference);
    expect(refs).toContain(`ZZPRT-P${run}`.slice(0, 20));
    expect(refs).not.toContain(`ZZPRT-X${run}`.slice(0, 20));
    const row = (data ?? []).find((r) => r.reference === `ZZPRT-P${run}`.slice(0, 20))!;
    expect(row.lat).toBeCloseTo(34.88, 5);
    expect(row.lng).toBeCloseTo(32.38, 5);
    expect(row.location_approx).toBe(false);
    // one photo with a JPEG; the JPEG-less photo and the plan are absent
    expect(row.images).toEqual([{ jpeg: `t/${run}_1_jpeg.jpg`, alt: { en: "Front" } }]);
  });

  it("the supplement's predicate is the site feed's: a sold listing leaves both", async () => {
    await svc.from("properties").update({ status: "sold" }).eq("id", publicId);
    const sup = await anon.rpc("portal_supplement", { p_token: token });
    expect((sup.data ?? []).map((r) => r.reference)).not.toContain(`ZZPRT-P${run}`.slice(0, 20));
    const site = await anon.rpc("public_listings", { p_org_slug: "test-org-a", p_limit: 100 });
    expect((site.data ?? []).map((r) => r.reference)).not.toContain(`ZZPRT-P${run}`.slice(0, 20));
    await svc.from("properties").update({ status: "available" }).eq("id", publicId);
  });

  it("a disabled connection answers an empty supplement", async () => {
    await svc.from("portal_connections").update({ enabled: false }).eq("feed_token", token);
    const sup = await anon.rpc("portal_supplement", { p_token: token });
    expect(sup.data).toHaveLength(0);
  });

  it("note_portal_pull records the pull", async () => {
    const { error } = await anon.rpc("note_portal_pull", { p_token: token, p_ua: "Test Crawler/1.0", p_count: 1 });
    expect(error).toBeNull();
    const { data } = await svc.from("portal_connections").select("last_pulled_ua, last_pull_count, last_pulled_at").eq("feed_token", token).single();
    expect(data).toMatchObject({ last_pulled_ua: "Test Crawler/1.0", last_pull_count: 1 });
    expect(data?.last_pulled_at).not.toBeNull();
  });

  it("anon cannot read either table directly", async () => {
    const a = await anon.from("portal_listings").select("portal");
    expect(a.error?.code ?? "42501").toBe("42501");
  });

  it("the database's portal-id check agrees with the registry's PORTAL_ID_PATTERN", async () => {
    // one id the regex rejects must be refused by 0095's CHECK, and one it accepts must not be
    expect(PORTAL_ID_PATTERN.test("Not-Valid")).toBe(false);
    const bad = await svc.from("portal_connections").insert({ org_id: ORG_A, portal: "Not-Valid" });
    expect(bad.error?.code).toBe("23514");
    expect(PORTAL_ID_PATTERN.test("zz_probe")).toBe(true);
    const good = await svc.from("portal_connections").insert({ org_id: ORG_A, portal: "zz_probe" }).select("id").single();
    expect(good.error).toBeNull();
    await svc.from("portal_connections").delete().eq("id", good.data!.id);
  });
});
```

(add `import { PORTAL_ID_PATTERN } from "@/lib/services/portals/registry";` at the top; the RLS vitest config resolves `@`.)

- [ ] **Step 2: Run the RLS suite**

Run: `npm run test:rls -- supabase/tests/portals.test.ts`
Expected: PASS (11 tests). Then run the whole suite: `npm run test:rls` — `rls_aal2_coverage` in `mfa-enforcement.test.ts` must still report 0.

If `insert` of `location` as `SRID=4326;POINT(...)` is refused by PostgREST, use the form the properties action writes (`lib/actions/properties.ts`, search `location:`) — copy that exact string shape.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/portals.test.ts
git commit -m "rls: portals — admin-only connections, edit-rights selection, what a token reveals" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: The JPEG rendition

**Files:**
- Modify: `lib/services/media.ts:8-16` (RENDITIONS) and the loop in `processPropertyImage`
- Modify: `lib/services/media.test.ts` ("produces WebP renditions at the spec widths")
- Modify: `lib/actions/media.ts:86-135` (renditionPath, uploads, insert) and `:401-420` (delete)
- Modify: `scripts/import/media.mts:190-225`
- Modify: `app/(app)/properties/[id]/page.tsx:83` (select `path_jpeg`)
- Create: `scripts/media/backfill-jpeg.mts`

- [ ] **Step 1: Write the failing test**

Replace the test `"produces WebP renditions at the spec widths"` in `lib/services/media.test.ts` with:

```ts
  it("produces renditions at the spec widths in the spec formats", async () => {
    const { renditions, width, height } = await processPropertyImage(gpsJpeg);
    expect(width).toBe(2400);
    expect(height).toBe(1600);
    for (const { name, width: target, format } of RENDITIONS) {
      const meta = await sharp(renditions[name]).metadata();
      expect(meta.format, name).toBe(format);
      expect(meta.width, name).toBe(target);
    }
  });

  it("the JPEG rendition is the full rendition's twin: same width, JPEG, watermarked together", async () => {
    const watermark = await sharp({
      create: { width: 600, height: 200, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.6 } },
    })
      .png()
      .toBuffer();
    const { renditions, watermarked } = await processPropertyImage(gpsJpeg, { watermark });
    expect(watermarked).toBe(true);
    const full = await sharp(renditions.full).metadata();
    const jpeg = await sharp(renditions.jpeg).metadata();
    expect(jpeg.format).toBe("jpeg");
    expect(jpeg.width).toBe(full.width);
    expect(jpeg.exif).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/services/media.test.ts`
Expected: FAIL — `format` is not a property of a RENDITIONS entry; `renditions.jpeg` undefined.

- [ ] **Step 3: Extend the pipeline**

In `lib/services/media.ts` replace the `RENDITIONS` block and the loop body:

```ts
/**
 * Media pipeline (doc 02 §A7): strip EXIF → renditions thumb 400 / card 800 /
 * full 1600 WebP, plus (0095) `jpeg` 1600 JPEG — the full rendition's twin for
 * portal feeds, because RERA takes JPEG/PNG only and four other portals leave
 * the format undocumented → optional watermark on `full` AND `jpeg` when the
 * property is publicly visible. Sharp discards metadata by default — we never
 * call withMetadata() on renditions, which is what guarantees GPS/EXIF removal.
 */
export const RENDITIONS = [
  { name: "thumb", width: 400, format: "webp" },
  { name: "card", width: 800, format: "webp" },
  { name: "full", width: 1600, format: "webp" },
  { name: "jpeg", width: 1600, format: "jpeg" },
] as const;
export type RenditionName = (typeof RENDITIONS)[number]["name"];

/** Storage extension per rendition: `<id>_full.webp`, `<id>_jpeg.jpg`. */
export function renditionExt(name: RenditionName): "webp" | "jpg" {
  return name === "jpeg" ? "jpg" : "webp";
}
export function renditionMime(name: RenditionName): "image/webp" | "image/jpeg" {
  return name === "jpeg" ? "image/jpeg" : "image/webp";
}
```

and inside `processPropertyImage`, replace the `for` loop with:

```ts
  const encode = (p: sharp.Sharp, name: RenditionName) =>
    name === "jpeg"
      ? p.jpeg({ quality: 85, mozjpeg: true })
      : p.webp({ quality: name === "thumb" ? 72 : 80 });
  const source = await base.clone().toBuffer();
  let wmBuffer: Buffer | null = null;
  for (const { name, width } of RENDITIONS) {
    let pipeline = sharp(source).resize({ width, withoutEnlargement: true });
    if ((name === "full" || name === "jpeg") && options.watermark) {
      if (!wmBuffer) {
        // scale watermark to ~25% of image width, bottom-right
        const targetWidth = Math.min(width, meta.width);
        wmBuffer = await sharp(options.watermark)
          .resize({ width: Math.round(targetWidth * 0.25) })
          .png()
          .toBuffer();
      }
      pipeline = sharp(await pipeline.toBuffer()).composite([{ input: wmBuffer, gravity: "southeast" }]);
      watermarked = true;
    }
    out[name] = await encode(pipeline, name).toBuffer();
  }
```

- [ ] **Step 4: Run the media tests**

Run: `npx vitest run lib/services/media.test.ts`
Expected: PASS, including the existing watermark and no-enlarge tests.

- [ ] **Step 5: Upload, record and delete the fourth rendition**

In `lib/actions/media.ts`:

- change `const renditionPath = (r: string) => …` (line ~86) to
  ```ts
  const renditionPath = (r: RenditionName) => `properties/${propertyId}/${id}_${r}.${renditionExt(r)}`;
  ```
  and import `renditionExt, renditionMime, type RenditionName` from `@/lib/services/media`;
- replace the three rendition `upload(...)` entries in `uploads` with one mapped block:
  ```ts
  ...RENDITIONS.map(({ name }) =>
    admin.storage
      .from(renditionBucket)
      .upload(renditionPath(name), binaryBody(processed.renditions[name], renditionMime(name)), {
        contentType: renditionMime(name),
      }),
  ),
  ```
  (import `RENDITIONS` too);
- in the `property_media` insert add `path_jpeg: renditionPath("jpeg"),` after `path_full`;
- in the bulk delete (line ~401) add `path_jpeg` to the `.select(...)` string and to the `flatMap` — `[m.path_thumb, m.path_card, m.path_full, m.path_jpeg]`.

In `scripts/import/media.mts` make the same four changes (renditionPath with the extension, the mapped uploads, `path_jpeg` in the insert).

In `app/(app)/properties/[id]/page.tsx` line 83 add `path_jpeg` to the `property_media` select (the Portals card in Task 12 counts it).

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 6: Write the backfill script**

```ts
// scripts/media/backfill-jpeg.mts
/**
 * One-off after 0095: give every existing photo its JPEG rendition.
 *
 * Reads the stored `full` WebP (already EXIF-free and watermarked as policy
 * had it), re-encodes to JPEG at the same width, uploads beside it, and sets
 * path_jpeg. Idempotent: rows with path_jpeg are skipped, so it can be rerun
 * after a partial failure. Service role, like the importers.
 *
 *   node --env-file=.env.local scripts/media/backfill-jpeg.mts          # local
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/media/backfill-jpeg.mts   # hosted
 */
import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(2);
}
const supabase = createClient(url, key, { auth: { persistSession: false } });

const { data: rows, error } = await supabase
  .from("property_media")
  .select("id, path_full")
  .eq("kind", "photo")
  .is("path_jpeg", null)
  .not("path_full", "is", null);
if (error) {
  console.error(error.message);
  process.exit(1);
}

let done = 0;
let failed = 0;
for (const row of rows ?? []) {
  const full = row.path_full as string;
  const jpegPath = full.replace(/_full\.webp$/, "_jpeg.jpg");
  if (jpegPath === full) {
    console.warn(`skip ${row.id}: unexpected path ${full}`);
    failed++;
    continue;
  }
  const dl = await supabase.storage.from("media").download(full);
  if (dl.error || !dl.data) {
    console.warn(`skip ${row.id}: download failed — ${dl.error?.message}`);
    failed++;
    continue;
  }
  const jpeg = await sharp(Buffer.from(await dl.data.arrayBuffer())).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  const up = await supabase.storage.from("media").upload(jpegPath, jpeg, { contentType: "image/jpeg", upsert: true });
  if (up.error) {
    console.warn(`skip ${row.id}: upload failed — ${up.error.message}`);
    failed++;
    continue;
  }
  const upd = await supabase.from("property_media").update({ path_jpeg: jpegPath }).eq("id", row.id).select("id");
  if (upd.error || !upd.data?.length) {
    console.warn(`skip ${row.id}: row update failed — ${upd.error?.message ?? "0 rows"}`);
    failed++;
    continue;
  }
  done++;
}
console.log(`backfill-jpeg: ${done} written, ${failed} skipped, ${(rows ?? []).length} candidates`);
process.exit(failed ? 1 : 0);
```

Add to `package.json` scripts: `"media:backfill-jpeg": "node --env-file=.env.local scripts/media/backfill-jpeg.mts"`.

- [ ] **Step 7: Prove the backfill locally**

Run: `npm run media:backfill-jpeg`
Expected: a line like `backfill-jpeg: N written, 0 skipped, N candidates` where N is the number of fixture photos; a second run prints `0 written, 0 skipped, 0 candidates`.

- [ ] **Step 8: Commit**

```bash
git add lib/services/media.ts lib/services/media.test.ts lib/actions/media.ts scripts/import/media.mts scripts/media/backfill-jpeg.mts package.json "app/(app)/properties/[id]/page.tsx"
git commit -m "media: a JPEG rendition beside the WebP full, for portal feeds (0095), with a backfill" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Feed assembly

**Files:**
- Create: `lib/services/portals/feed.ts`
- Test: `lib/services/portals/feed.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/services/portals/feed.test.ts
import { describe, expect, it } from "vitest";
import { kyero } from "./dialects/kyero";
import { SALE_VILLA, RENT_FLAT, LAND_PLOT, SETTINGS } from "./dialects/__fixtures__/listings";
import { assemblePortalFeed, MAX_PAGES } from "./feed";
import type { PublicListingRow, SupplementRow } from "./feed-listing";
import { MAX_LIMIT } from "@/lib/services/public-listings";
import { portalById } from "./registry";

const je = portalById("jamesedition")!;
const rows = [SALE_VILLA.row, RENT_FLAT.row, LAND_PLOT.row];
const sup = (l: { row: PublicListingRow; coords: { lat: number; lng: number; approx: boolean } | null; images: { url: string }[] }): SupplementRow => ({
  reference: l.row.reference,
  lat: l.coords?.lat ?? null,
  lng: l.coords?.lng ?? null,
  location_approx: l.coords?.approx ?? false,
  images: l.images.map((i) => ({ jpeg: i.url.split("/media/")[1], alt: null })),
});
const pages = (all: PublicListingRow[]) => async (offset: number) => all.slice(offset, offset + MAX_LIMIT);

describe("assemblePortalFeed", () => {
  it("keeps selected listings in feed order and drops the unselected", async () => {
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: SETTINGS, supabaseUrl: "https://p.supabase.co",
      supplements: [sup(LAND_PLOT), sup(SALE_VILLA)],
      fetchPage: pages(rows),
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.count).toBe(1); // LAND_PLOT has one photo; JamesEdition needs two
    expect(r.body).toContain("<ref>PAF0001</ref>");
    expect(r.body).not.toContain("<ref>PAF0002</ref>");
    expect(r.body).not.toContain("<ref>PAF0003</ref>");
  });

  it("stops paging once every selected reference is found", async () => {
    let calls = 0;
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: SETTINGS, supabaseUrl: "https://p",
      supplements: [sup(SALE_VILLA)],
      fetchPage: async (offset) => { calls++; return pages(Array.from({ length: 250 }, (_, i) => (i === 0 ? SALE_VILLA.row : { ...LAND_PLOT.row, reference: `X${i}` })))(offset); },
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("marks truncation at the page ceiling instead of looping forever", async () => {
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: SETTINGS, supabaseUrl: "https://p",
      supplements: [{ ...sup(SALE_VILLA), reference: "NEVER" }],
      fetchPage: async () => Array.from({ length: MAX_LIMIT }, (_, i) => ({ ...LAND_PLOT.row, reference: `Y${i}` })),
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.truncated).toBe(true);
    expect(r.count).toBe(0);
    expect(MAX_PAGES).toBe(25);
  });

  it("a failing page is an error, not an empty feed (an empty feed would delist everything)", async () => {
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: SETTINGS, supabaseUrl: "https://p",
      supplements: [sup(SALE_VILLA)],
      fetchPage: async () => { throw new Error("db down"); },
    });
    expect(r).toEqual({ ok: false, error: "db down" });
  });

  it("no selection renders the empty document", async () => {
    const r = await assemblePortalFeed({
      portal: je, renderer: kyero, settings: SETTINGS, supabaseUrl: "https://p",
      supplements: [], fetchPage: pages(rows),
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.body).toBe(kyero.empty());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/services/portals/feed.test.ts`
Expected: FAIL — `Cannot find module './feed'`

- [ ] **Step 3: Write the assembler**

```ts
// lib/services/portals/feed.ts
import { MAX_LIMIT } from "@/lib/services/public-listings";
import type { DialectRenderer } from "./dialects";
import { eligibilityFor, eligibilityInputFromFeed } from "./eligibility";
import { buildFeedListings, type PublicListingRow, type SupplementRow } from "./feed-listing";
import type { PortalDefinition } from "./registry";

/** 25 × 100 = 2,500 listings — the ceiling gnk-web reads the site feed with. */
export const MAX_PAGES = 25;

export interface AssembleArgs {
  portal: PortalDefinition;
  renderer: DialectRenderer;
  settings: Record<string, string>;
  supplements: readonly SupplementRow[];
  supabaseUrl: string;
  /** one page of `public_listings()` at this offset; throws on a database error */
  fetchPage: (offset: number) => Promise<PublicListingRow[]>;
}

export type AssembleResult =
  | { ok: true; body: string; count: number; truncated: boolean }
  | { ok: false; error: string };

/**
 * The portal feed is a PROJECTION of the site feed: page through
 * public_listings(), keep the references the supplement (selection ∩ public)
 * names, drop what the portal's requirements refuse, render. A page that
 * fails is an error — never an empty document, because every pull portal
 * treats an empty feed as "remove everything".
 */
export async function assemblePortalFeed(a: AssembleArgs): Promise<AssembleResult> {
  const wanted = new Set(a.supplements.map((s) => s.reference));
  const rows: PublicListingRow[] = [];
  let truncated = false;
  if (wanted.size > 0) {
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const batch = await a.fetchPage(page * MAX_LIMIT);
        for (const r of batch) if (wanted.has(r.reference)) rows.push(r);
        if (rows.length === wanted.size || batch.length < MAX_LIMIT) break;
        if (page === MAX_PAGES - 1) truncated = true;
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const listings = buildFeedListings(rows, a.supplements, a.supabaseUrl).filter(
    (l) => eligibilityFor(a.portal, eligibilityInputFromFeed(l)).ok,
  );
  const body = listings.length ? a.renderer.render(listings, a.settings) : a.renderer.empty();
  return { ok: true, body, count: listings.length, truncated };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/services/portals/feed.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Mutation check on the two read-path predicates (spec §Testing; READ paths only — never the events hash)**

Temporarily change `if (wanted.has(r.reference)) rows.push(r);` to `rows.push(r);` and run the file: "keeps selected listings … drops the unselected" must FAIL (PAF0002 appears). Revert. Then temporarily remove `.filter((l) => eligibilityFor(...).ok)` and run: the same test must FAIL on `count` (3, not 1). Revert. Both reds prove the tests are load-bearing; `git diff --stat lib/services/portals/feed.ts` must be empty before the commit.

- [ ] **Step 6: Commit**

```bash
git add lib/services/portals/feed.ts lib/services/portals/feed.test.ts
git commit -m "portals: feed assembly — a projection of the site feed, never empty by accident" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: The feed route

**Files:**
- Create: `app/api/portals/[portal]/[token]/route.ts`
- Modify: `proxy.ts:93`

- [ ] **Step 1: Exempt the prefix from the auth gate**

In `proxy.ts`, extend the comment block above line 93 with:

```ts
   *
   * `/api/portals/` (0095) is the PORTAL feed: an external portal pulls it by
   * a 64-hex token in the path. Same construction as `/api/public/` — anon
   * key only, so its reach is what 0095 grants `anon` by name — and the same
   * rule: nothing goes under it that is not meant for the open internet.
```

and change the condition to:

```ts
  if (
    path.startsWith("/p/") ||
    path.startsWith("/api/public/") ||
    path.startsWith("/api/portals/") ||
    path === "/offline"
  ) {
```

- [ ] **Step 2: Write the route**

```ts
// app/api/portals/[portal]/[token]/route.ts
import { after, NextResponse, type NextRequest } from "next/server";
import { createPublicClient } from "@/lib/supabase/public";
import { feedEtag } from "@/lib/services/feed-etag";
import { DIALECT_RENDERERS } from "@/lib/services/portals/dialects";
import { assemblePortalFeed } from "@/lib/services/portals/feed";
import { portalById } from "@/lib/services/portals/registry";
import { MAX_LIMIT } from "@/lib/services/public-listings";

/**
 * The portal feed (spec 2026-09-14 §The feed route; migration 0095).
 *
 * PUBLIC AND UNAUTHENTICATED BY DESIGN, like /api/public/listings beside it:
 * a portal's crawler pulls it on its own schedule. `proxy.ts` exempts
 * `/api/portals/`. Anon client only — its reach is the three functions 0095
 * grants by name.
 *
 * The token in the path is the whole of the caller's proof. A wrong one costs
 * one indexed lookup and a 404 and is NOT metered: there is nothing behind
 * it to protect, and a counter row would be the shared-lock problem REL-03
 * removed from the site feed on 2026-09-13.
 *
 * A DISABLED portal answers 200 with the dialect's EMPTY document, never 404:
 * every pull portal treats absence as removal, so an empty feed clears our
 * listings there and a 404 would leave them stale.
 */
export const dynamic = "force-dynamic";

const MAX_AGE_SECONDS = 300;
const CACHE_CONTROL = `public, max-age=${MAX_AGE_SECONDS}`;
const NO_STORE = { "Cache-Control": "no-store" } as const;
const TOKEN = /^[0-9a-f]{64}$/;

const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
const unavailable = () => NextResponse.json({ error: "Feed unavailable." }, { status: 503, headers: NO_STORE });

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ portal: string; token: string }> },
) {
  const { portal: portalId, token } = await ctx.params;
  const portal = portalById(portalId);
  if (!portal || !TOKEN.test(token)) return notFound();
  const renderer = DIALECT_RENDERERS[portal.dialect];
  // spec pending: no renderer exists, so the switch could never have enabled it
  if (!renderer) return notFound();

  const supabase = createPublicClient();
  const conn = await supabase.rpc("portal_connection_by_token", { p_portal: portalId, p_token: token });
  const row = conn.data?.[0];
  if (conn.error || !row) return notFound();

  const xml = (body: string, headers: Record<string, string>) =>
    new NextResponse(body, { status: 200, headers: { "Content-Type": renderer.contentType, ...headers } });

  if (!row.enabled) return xml(renderer.empty(), NO_STORE);

  const [snapshot, supplement] = await Promise.all([
    supabase.rpc("public_listings_etag", { p_org_slug: row.org_slug }),
    supabase.rpc("portal_supplement", { p_token: token }),
  ]);
  if (snapshot.error || supplement.error) return unavailable();

  const result = await assemblePortalFeed({
    portal,
    renderer,
    settings: (row.settings ?? {}) as Record<string, string>,
    supplements: supplement.data ?? [],
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    fetchPage: async (offset) => {
      const page = await supabase.rpc("public_listings", {
        p_org_slug: row.org_slug,
        p_limit: MAX_LIMIT,
        p_offset: offset,
      });
      if (page.error) throw new Error(page.error.message);
      return page.data ?? [];
    },
  });
  if (!result.ok) return unavailable();
  if (result.truncated) {
    console.warn(`[portal-feed] ${portalId}: selection exceeds ${MAX_LIMIT * 25} listings; feed truncated`);
  }

  // Serialised once; the validator is a digest of these bytes (feed-etag.ts).
  const etag = feedEtag(String(snapshot.data), result.body);

  // The pull is noted after the response, and a failed note never fails the feed.
  const ua = request.headers.get("user-agent") ?? "";
  after(async () => {
    const { error } = await supabase.rpc("note_portal_pull", { p_token: token, p_ua: ua, p_count: result.count });
    if (error) console.warn(`[portal-feed] note_portal_pull failed: ${error.message}`);
  });

  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": CACHE_CONTROL } });
  }
  return xml(result.body, { ETag: etag, "Cache-Control": CACHE_CONTROL });
}
```

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npm run lint && npm run check:static-routes`
Expected: clean. (`check:static-routes` guards pages, not API routes; run it anyway because the proxy changed.)

- [ ] **Step 4: Smoke it against the local stack**

Start the dev server (through the desktop app's preview, never Bash) and, with the connection row from the RLS test or one made through the settings page in Task 12, fetch:

```bash
curl -si "http://localhost:3000/api/portals/jamesedition/$(printf 'f%.0s' {1..64})" | head -3
```
Expected: `HTTP/1.1 404`.

```bash
curl -si "http://localhost:3000/api/portals/jamesedition/<real token>" | head -8
```
Expected: `200`, `Content-Type: application/xml; charset=utf-8`, an `ETag: W/"…"`, `Cache-Control: public, max-age=300`, and a body starting `<?xml version="1.0" encoding="UTF-8"?>` `<root>`.

- [ ] **Step 5: Commit**

```bash
git add proxy.ts "app/api/portals/[portal]/[token]/route.ts"
git commit -m "portals: the feed route — token in the path, empty document when disabled, pull noted after the response" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Server actions and timeline lines

**Files:**
- Create: `lib/actions/portals.ts`
- Create: `lib/validators/portals.ts`
- Modify: `lib/services/events.ts:137` (two `EVENT_LINES` entries)
- Modify: `messages/en.json`, `messages/el.json`, `messages/ru.json` (`events` namespace)
- Test: `lib/validators/portals.test.ts`

- [ ] **Step 1: Write the failing validator test**

```ts
// lib/validators/portals.test.ts
import { describe, expect, it } from "vitest";
import { portalIdSchema, portalSettingsForm } from "./portals";

describe("portal validators", () => {
  it("accepts a registry id and refuses anything else", () => {
    expect(portalIdSchema.safeParse("jamesedition").success).toBe(true);
    expect(portalIdSchema.safeParse("JamesEdition").success).toBe(false);
    expect(portalIdSchema.safeParse("nope").success).toBe(false);
  });

  it("parses a settings form through the portal's own schema", () => {
    const r = portalSettingsForm({ portal: "jamesedition", email: " a@b.c ", stray: "x" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ portal: "jamesedition", settings: { contact_number: "", whatsapp_number: "", email: "a@b.c" } });
  });

  it("refuses a settings form for an unknown portal", () => {
    expect(portalSettingsForm({ portal: "nope" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/validators/portals.test.ts`
Expected: FAIL — `Cannot find module './portals'`

- [ ] **Step 3: Write the validators**

```ts
// lib/validators/portals.ts
import { z } from "zod";
import { PORTAL_IDS, portalById } from "@/lib/services/portals/registry";

export const portalIdSchema = z.enum(PORTAL_IDS);

export type PortalSettingsForm =
  | { success: true; data: { portal: (typeof PORTAL_IDS)[number]; settings: Record<string, string> } }
  | { success: false; error: string };

/** The settings form carries `portal` plus that portal's own fields; each portal's zod schema decides. */
export function portalSettingsForm(raw: Record<string, unknown>): PortalSettingsForm {
  const id = portalIdSchema.safeParse(raw.portal);
  if (!id.success) return { success: false, error: "Unknown portal." };
  const def = portalById(id.data)!;
  const parsed = def.settingsSchema.safeParse(raw);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid settings." };
  return { success: true, data: { portal: id.data, settings: parsed.data } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/validators/portals.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the actions**

```ts
// lib/actions/portals.ts
"use server";
import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { getCurrentProfile, type CurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { DIALECT_RENDERERS } from "@/lib/services/portals/dialects";
import { portalById } from "@/lib/services/portals/registry";
import { createClient } from "@/lib/supabase/server";
import { portalIdSchema, portalSettingsForm } from "@/lib/validators/portals";

/**
 * Portal syndication actions (spec 2026-09-14 §Settings, §Property page).
 *
 * Connection changes are admin-only here AND by 0095's policies; selection is
 * whoever may edit the listing, likewise twice. Every write checks the row
 * count — an RLS-filtered zero-row write must never report success or log
 * an event — and every success is an event.
 */
export type PortalActionState = { error: string | null; savedAt: number | null };
const ok = (): PortalActionState => ({ error: null, savedAt: Date.now() });
const fail = (error: string): PortalActionState => ({ error, savedAt: null });

type Session = { supabase: Awaited<ReturnType<typeof createClient>>; profile: CurrentProfile };

async function session(): Promise<Session> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  return { supabase, profile };
}

async function requireAdmin(): Promise<Session | { denied: string }> {
  const s = await session();
  if (s.profile.role !== "admin") return { denied: "Admins only." };
  return s;
}

function newToken(): string {
  return randomBytes(32).toString("hex");
}

/* ---------------- connections (admin) ---------------- */

export async function setPortalEnabled(portalId: string, enabled: boolean): Promise<PortalActionState> {
  const id = portalIdSchema.safeParse(portalId);
  if (!id.success) return fail("Unknown portal.");
  const def = portalById(id.data)!;
  const gate = await requireAdmin();
  if ("denied" in gate) return fail(gate.denied);
  const { supabase, profile } = gate;

  if (enabled) {
    if (def.spec === "pending" || !DIALECT_RENDERERS[def.dialect]) {
      return fail(`${def.name} cannot be enabled yet: its feed format is not available to the CRM.`);
    }
    const { data: existing } = await supabase
      .from("portal_connections")
      .select("settings")
      .eq("portal", id.data)
      .maybeSingle();
    const settings = (existing?.settings ?? {}) as Record<string, string>;
    const missing = def.requiredSettings.filter((k) => !settings[k]);
    if (missing.length) return fail(`Fill in ${missing.join(", ")} before enabling ${def.name}.`);
  }

  // Insert-if-absent, then update — NOT an upsert carrying feed_token, which
  // would rotate the token on every toggle and point the portal at a dead URL.
  // The database default mints the token on insert; newToken() serves only
  // regeneratePortalToken().
  const { data: existingRow } = await supabase
    .from("portal_connections")
    .select("id")
    .eq("portal", id.data)
    .maybeSingle();
  let affected = 0;
  if (existingRow) {
    const { data: rows, error } = await supabase
      .from("portal_connections")
      .update({ enabled, updated_by: profile.id })
      .eq("id", existingRow.id)
      .select("id");
    if (error) return fail(error.message);
    affected = rows?.length ?? 0;
  } else {
    const { data: rows, error } = await supabase
      .from("portal_connections")
      .insert({ org_id: profile.orgId, portal: id.data, enabled, updated_by: profile.id })
      .select("id");
    if (error) return fail(error.message);
    affected = rows?.length ?? 0;
  }
  if (!affected) return fail("Nothing changed — your role may not manage portals.");
  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "organization",
    entityId: profile.orgId,
    eventType: enabled ? "portal_enabled" : "portal_disabled",
    payload: { portal: id.data },
  });
  revalidatePath("/settings/portals");
  return ok();
}

export async function savePortalSettings(_prev: PortalActionState, formData: FormData): Promise<PortalActionState> {
  const parsed = portalSettingsForm(Object.fromEntries(formData));
  if (!parsed.success) return fail(parsed.error);
  const gate = await requireAdmin();
  if ("denied" in gate) return fail(gate.denied);
  const { supabase, profile } = gate;
  const { data: existing } = await supabase
    .from("portal_connections")
    .select("id")
    .eq("portal", parsed.data.portal)
    .maybeSingle();
  let affected = 0;
  if (existing) {
    const { data: rows, error } = await supabase
      .from("portal_connections")
      .update({ settings: parsed.data.settings, updated_by: profile.id })
      .eq("id", existing.id)
      .select("id");
    if (error) return fail(error.message);
    affected = rows?.length ?? 0;
  } else {
    const { data: rows, error } = await supabase
      .from("portal_connections")
      .insert({ org_id: profile.orgId, portal: parsed.data.portal, settings: parsed.data.settings, updated_by: profile.id })
      .select("id");
    if (error) return fail(error.message);
    affected = rows?.length ?? 0;
  }
  if (!affected) return fail("Nothing saved — your role may not manage portals.");
  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "organization",
    entityId: profile.orgId,
    eventType: "portal_settings_updated",
    payload: { portal: parsed.data.portal, keys: Object.keys(parsed.data.settings) },
  });
  revalidatePath("/settings/portals");
  return ok();
}

export async function regeneratePortalToken(portalId: string): Promise<PortalActionState> {
  const id = portalIdSchema.safeParse(portalId);
  if (!id.success) return fail("Unknown portal.");
  const gate = await requireAdmin();
  if ("denied" in gate) return fail(gate.denied);
  const { supabase, profile } = gate;
  const { data: rows, error } = await supabase
    .from("portal_connections")
    .update({ feed_token: newToken(), updated_by: profile.id })
    .eq("portal", id.data)
    .select("id");
  if (error) return fail(error.message);
  if (!rows?.length) return fail("No connection to rotate — enable the portal first.");
  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "organization",
    entityId: profile.orgId,
    eventType: "portal_token_regenerated",
    payload: { portal: id.data },
  });
  revalidatePath("/settings/portals");
  return ok();
}

/* ---------------- selection (whoever may edit the listing) ---------------- */

async function listingFacts(supabase: Session["supabase"], propertyId: string) {
  const { data } = await supabase
    .from("properties")
    .select("id, reference, org_id")
    .eq("id", propertyId)
    .maybeSingle();
  return data;
}

export async function selectPortal(propertyId: string, portalId: string): Promise<PortalActionState> {
  const id = portalIdSchema.safeParse(portalId);
  if (!id.success) return fail("Unknown portal.");
  const { supabase, profile } = await session();
  const listing = await listingFacts(supabase, propertyId);
  if (!listing) return fail("Listing not found.");
  const { data: conn } = await supabase
    .from("portal_connections")
    .select("enabled")
    .eq("portal", id.data)
    .maybeSingle();
  if (!conn?.enabled) return fail("That portal is not enabled — an admin enables it under Settings → Portals.");
  const { data: rows, error } = await supabase
    .from("portal_listings")
    .insert({ org_id: listing.org_id, property_id: propertyId, portal: id.data, selected_by: profile.id })
    .select("portal");
  if (error) {
    if (error.code === "23505") return ok(); // already selected: the desk's intent is met
    if (error.code === "42501") return fail("Your role cannot put this listing on a portal.");
    return fail(error.message);
  }
  if (!rows?.length) return fail("Nothing changed — your role may not select this listing.");
  await logEvent(supabase, {
    orgId: listing.org_id,
    actorId: profile.id,
    entityType: "property",
    entityId: propertyId,
    eventType: "portal_selected",
    payload: { portal: id.data, reference: listing.reference },
  });
  revalidatePath(`/properties/${propertyId}`);
  return ok();
}

export async function deselectPortal(propertyId: string, portalId: string): Promise<PortalActionState> {
  const id = portalIdSchema.safeParse(portalId);
  if (!id.success) return fail("Unknown portal.");
  const { supabase, profile } = await session();
  const listing = await listingFacts(supabase, propertyId);
  if (!listing) return fail("Listing not found.");
  const { data: rows, error } = await supabase
    .from("portal_listings")
    .delete()
    .eq("property_id", propertyId)
    .eq("portal", id.data)
    .select("portal");
  if (error) return fail(error.message);
  if (!rows?.length) return fail("Nothing changed — it was not selected, or your role may not change it.");
  await logEvent(supabase, {
    orgId: listing.org_id,
    actorId: profile.id,
    entityType: "property",
    entityId: propertyId,
    eventType: "portal_removed",
    payload: { portal: id.data, reference: listing.reference },
  });
  revalidatePath(`/properties/${propertyId}`);
  return ok();
}
```

- [ ] **Step 6: Timeline lines**

In `lib/services/events.ts`, inside `EVENT_LINES` (after the `publish_override` entry), add:

```ts
  portal_selected: (p, t) => t("portalSelected", { portal: String(p.portal ?? "") }),
  portal_removed: (p, t) => t("portalRemoved", { portal: String(p.portal ?? "") }),
  portal_enabled: (p, t) => t("portalEnabled", { portal: String(p.portal ?? "") }),
  portal_disabled: (p, t) => t("portalDisabled", { portal: String(p.portal ?? "") }),
  portal_settings_updated: (p, t) => t("portalSettingsUpdated", { portal: String(p.portal ?? "") }),
  portal_token_regenerated: (p, t) => t("portalTokenRegenerated", { portal: String(p.portal ?? "") }),
```

In the `"events"` object of each messages file add:

`messages/en.json`
```json
    "portalSelected": "Selected for portal {portal}",
    "portalRemoved": "Removed from portal {portal}",
    "portalEnabled": "Portal {portal} enabled",
    "portalDisabled": "Portal {portal} disabled",
    "portalSettingsUpdated": "Portal {portal} settings updated",
    "portalTokenRegenerated": "Portal {portal} feed URL regenerated"
```
`messages/el.json`
```json
    "portalSelected": "Επιλέχθηκε για την πύλη {portal}",
    "portalRemoved": "Αφαιρέθηκε από την πύλη {portal}",
    "portalEnabled": "Η πύλη {portal} ενεργοποιήθηκε",
    "portalDisabled": "Η πύλη {portal} απενεργοποιήθηκε",
    "portalSettingsUpdated": "Ενημερώθηκαν οι ρυθμίσεις της πύλης {portal}",
    "portalTokenRegenerated": "Ανανεώθηκε το URL ροής της πύλης {portal}"
```
`messages/ru.json`
```json
    "portalSelected": "Выбрано для портала {portal}",
    "portalRemoved": "Снято с портала {portal}",
    "portalEnabled": "Портал {portal} включён",
    "portalDisabled": "Портал {portal} выключен",
    "portalSettingsUpdated": "Обновлены настройки портала {portal}",
    "portalTokenRegenerated": "Обновлён URL фида портала {portal}"
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: clean; `lib/services/events.test.ts` still passes (if it pins the message keys against `EVENT_LINES`, the six new keys satisfy it in all three files).

- [ ] **Step 8: Commit**

```bash
git add lib/actions/portals.ts lib/validators/portals.ts lib/validators/portals.test.ts lib/services/events.ts messages/en.json messages/el.json messages/ru.json
git commit -m "portals: actions — enable/disable, settings, token rotation, select/deselect; every write counted, every success an event" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Settings → Portals

**Files:**
- Create: `app/(app)/settings/portals/page.tsx`
- Create: `components/features/settings/portal-card.tsx`
- Modify: `components/features/settings/settings-nav.tsx:5-13`

- [ ] **Step 1: Add the nav entry**

In `SECTIONS`, after `{ href: "/settings/cyprus-config", label: "Cyprus config" },` add:

```ts
  { href: "/settings/portals", label: "Portals" },
```

- [ ] **Step 2: Write the page**

```tsx
// app/(app)/settings/portals/page.tsx
import { PortalCard, type PortalCardConnection } from "@/components/features/settings/portal-card";
import { getCurrentProfile } from "@/lib/services/auth";
import { PORTALS } from "@/lib/services/portals/registry";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function PortalsSettingsPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  // pages render in parallel with the layout's admin gate — stop here too
  if (profile.role !== "admin") return null;

  const { data: rows } = await supabase
    .from("portal_connections")
    .select("portal, enabled, feed_token, settings, last_pulled_at, last_pulled_ua, last_pull_count");
  const byPortal = new Map((rows ?? []).map((r) => [r.portal, r]));
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-2">
        Where listings are advertised beyond the website. Enabling a portal gives it a feed URL to pull;
        nothing goes out until an agent ticks a listing for that portal on its Marketing tab. The website
        never depends on any of this. Every change here is an event.
      </p>
      {PORTALS.map((def) => {
        const r = byPortal.get(def.id);
        const connection: PortalCardConnection | null = r
          ? {
              enabled: r.enabled,
              feedUrl: `${appUrl}/api/portals/${def.id}/${r.feed_token}`,
              settings: (r.settings ?? {}) as Record<string, string>,
              lastPulledAt: r.last_pulled_at,
              lastPulledUa: r.last_pulled_ua,
              lastPullCount: r.last_pull_count,
            }
          : null;
        return <PortalCard key={def.id} portal={def} connection={connection} />;
      })}
    </div>
  );
}
```

- [ ] **Step 3: Write the card**

```tsx
// components/features/settings/portal-card.tsx
"use client";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { Copy, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  regeneratePortalToken,
  savePortalSettings,
  setPortalEnabled,
  type PortalActionState,
} from "@/lib/actions/portals";
import type { PortalDefinition } from "@/lib/services/portals/registry";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTime } from "@/lib/utils/format";

export interface PortalCardConnection {
  enabled: boolean;
  feedUrl: string;
  settings: Record<string, string>;
  lastPulledAt: string | null;
  lastPulledUa: string | null;
  lastPullCount: number | null;
}

const initialState: PortalActionState = { error: null, savedAt: null };

/**
 * One portal on Settings → Portals (spec §Settings). The switch is a plain
 * button, not a form: a click is the whole intent. Settings are a form so a
 * half-typed phone number is not saved on blur.
 */
export function PortalCard({
  portal,
  connection,
}: {
  portal: PortalDefinition;
  connection: PortalCardConnection | null;
}) {
  const [pending, start] = useTransition();
  const [state, formAction, saving] = useActionState(savePortalSettings, initialState);
  const last = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);
  const enabled = connection?.enabled ?? false;
  const pendingSpec = portal.spec === "pending";

  useEffect(() => {
    if (state.savedAt && state.savedAt !== last.current) {
      last.current = state.savedAt;
      toast.success(`${portal.name} settings saved`);
    }
  }, [state.savedAt, portal.name]);
  useEffect(() => {
    if (state.error) toast.error(state.error);
  }, [state.error]);

  const toggle = () =>
    start(async () => {
      const r = await setPortalEnabled(portal.id, !enabled);
      if (r.error) toast.error(r.error);
      else toast.success(enabled ? `${portal.name} disabled — its feed now empties` : `${portal.name} enabled`);
    });

  const regenerate = () => {
    if (!window.confirm(`Regenerate the ${portal.name} feed URL? The portal must be given the new URL; the old one stops answering.`)) return;
    start(async () => {
      const r = await regeneratePortalToken(portal.id);
      if (r.error) toast.error(r.error);
      else toast.success("New feed URL minted — give it to the portal");
    });
  };

  const copy = async () => {
    if (!connection) return;
    await navigator.clipboard.writeText(connection.feedUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="rounded-[10px] border border-border bg-surface p-5" data-testid={`portal-card-${portal.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-text-1">{portal.name}</h2>
          <p className="mt-1 text-xs text-text-3">{portal.audience}</p>
          <p className="mt-1 text-xs text-text-3">
            Format: {portal.dialect} · pulls {portal.pullCadence} ·{" "}
            <a className="underline" href={portal.docsUrl} target="_blank" rel="noreferrer">
              spec
            </a>
          </p>
        </div>
        {pendingSpec ? (
          <span className="rounded-md bg-surface-2 px-2 py-1 text-xs font-medium text-text-2">
            not available in this build — cannot be enabled yet
          </span>
        ) : (
          <Button
            type="button"
            variant={enabled ? "secondary" : "default"}
            size="sm"
            disabled={pending}
            onClick={toggle}
            aria-pressed={enabled}
            data-testid={`portal-toggle-${portal.id}`}
          >
            {enabled ? "Disable" : "Enable"}
          </Button>
        )}
      </div>

      {connection && !pendingSpec ? (
        <div className="mt-4 flex flex-col gap-2">
          <Label htmlFor={`feed-url-${portal.id}`}>Feed URL to give the portal</Label>
          <div className="flex gap-2">
            <Input
              id={`feed-url-${portal.id}`}
              readOnly
              value={connection.feedUrl}
              data-testid={`portal-feed-url-${portal.id}`}
              className="font-mono text-xs"
            />
            <Button type="button" variant="secondary" size="sm" onClick={copy} aria-label="Copy feed URL">
              <Copy className="size-4" /> {copied ? "Copied" : "Copy"}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={regenerate} disabled={pending} aria-label="Regenerate feed URL">
              <RefreshCw className="size-4" /> Regenerate
            </Button>
          </div>
          <p className="text-xs text-text-3">
            {enabled ? "Answers the selected listings." : "Answers an empty document while disabled, so the portal clears its copy."}{" "}
            {connection.lastPulledAt
              ? `Last pulled ${formatDateTime(connection.lastPulledAt)} by ${connection.lastPulledUa || "an unnamed crawler"} — ${connection.lastPullCount ?? 0} listings.`
              : "Never pulled yet."}
          </p>
        </div>
      ) : null}

      <ul className="mt-4 list-disc pl-5 text-xs text-text-3">
        <li>at least {portal.requirements.minPhotos} photo{portal.requirements.minPhotos === 1 ? "" : "s"} with a JPEG rendition</li>
        <li>an English public description and a price</li>
        {portal.requirements.needsCoords ? <li>map coordinates</li> : null}
        <li>languages carried: {portal.requirements.languages.join(", ")}</li>
      </ul>

      {portal.settingsFields.length ? (
        <form action={formAction} className="mt-4 grid gap-3 sm:grid-cols-3">
          <input type="hidden" name="portal" value={portal.id} />
          {portal.settingsFields.map((f) => (
            <div key={f.key} className="flex flex-col gap-1">
              <Label htmlFor={`${portal.id}-${f.key}`}>
                {f.label}
                {portal.requiredSettings.includes(f.key) ? " *" : ""}
              </Label>
              <Input
                id={`${portal.id}-${f.key}`}
                name={f.key}
                defaultValue={connection?.settings[f.key] ?? ""}
                placeholder={f.placeholder}
              />
            </div>
          ))}
          <div className="sm:col-span-3">
            <Button type="submit" size="sm" disabled={saving}>
              Save settings
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
```

- [ ] **Step 4: Look at it**

Run the dev server through the desktop app's preview, open `/settings/portals` as the seed admin. Expected: eight cards; four with an Enable button, four with the "spec pending" badge; enabling JamesEdition shows a feed URL ending in 64 hex characters and "Never pulled yet."; a `curl` of that URL answers `200` with the empty Kyero document; the Activity timeline on the organisation shows "Portal jamesedition enabled".

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/settings/portals/page.tsx" components/features/settings/portal-card.tsx components/features/settings/settings-nav.tsx
git commit -m "settings: Portals — enable, feed URL, settings, last pull, spec-pending badge" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: The Portals card on the property page

**Files:**
- Create: `components/features/properties/portals-card.tsx`
- Modify: `app/(app)/properties/[id]/page.tsx` (data fetch near line 75; Marketing tab near line 760)

- [ ] **Step 1: Write the card**

```tsx
// components/features/properties/portals-card.tsx
"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { deselectPortal, selectPortal } from "@/lib/actions/portals";
import { REASON_TEXT, type Eligibility } from "@/lib/services/portals/eligibility";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils/format";

export interface PortalRow {
  id: string;
  name: string;
  eligibility: Eligibility;
  selected: { at: string; byName: string | null } | null;
  lastPulledAt: string | null;
}

/**
 * Marketing tab → Portals (spec §Property page). One row per ENABLED portal;
 * the reasons come from the same function the feed uses, so a disabled
 * toggle names why the listing would be missing from that feed.
 */
export function PortalsCard({ propertyId, portals, readOnly }: { propertyId: string; portals: PortalRow[]; readOnly: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  if (portals.length === 0) {
    return (
      <section className="rounded-[10px] border border-border bg-surface p-6">
        <h2 className="text-sm font-semibold text-text-1">Portals</h2>
        <p className="mt-1 text-sm text-text-2">No portal is enabled. An admin enables them under Settings → Portals.</p>
      </section>
    );
  }

  const flip = (row: PortalRow) =>
    start(async () => {
      const r = row.selected ? await deselectPortal(propertyId, row.id) : await selectPortal(propertyId, row.id);
      if (r.error) toast.error(r.error);
      else {
        toast.success(row.selected ? `Removed from ${row.name} at its next pull` : `On ${row.name} at its next pull`);
        router.refresh();
      }
    });

  return (
    <section className="rounded-[10px] border border-border bg-surface p-6" data-testid="portals-card">
      <h2 className="text-sm font-semibold text-text-1">Portals</h2>
      <p className="mt-1 text-xs text-text-3">
        Where this listing is advertised beyond the website. A portal picks the change up at its next pull.
      </p>
      <ul className="mt-4 divide-y divide-border">
        {portals.map((row) => {
          const blocked = !row.eligibility.ok;
          return (
            <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 py-3" data-testid={`portal-row-${row.id}`}>
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-1">{row.name}</p>
                {row.selected ? (
                  <p className="text-xs text-text-3">
                    Selected {formatDateTime(row.selected.at)}
                    {row.selected.byName ? ` by ${row.selected.byName}` : ""}
                  </p>
                ) : null}
                <p className="text-xs text-text-3">
                  {row.lastPulledAt ? `Portal last pulled ${formatDateTime(row.lastPulledAt)}` : "Portal has not pulled yet"}
                </p>
                {blocked && !row.eligibility.ok ? (
                  <ul className="mt-1 list-disc pl-4 text-xs text-warning">
                    {row.eligibility.reasons.map((r) => (
                      <li key={r}>{REASON_TEXT[r]}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <Button
                type="button"
                size="sm"
                variant={row.selected ? "secondary" : "default"}
                disabled={readOnly || pending || (blocked && !row.selected)}
                onClick={() => flip(row)}
                aria-pressed={Boolean(row.selected)}
                data-testid={`portal-select-${row.id}`}
              >
                {row.selected ? "Remove" : "Select"}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

A selected listing that has since become ineligible keeps its Remove button enabled: the row may be removed, and the reasons explain why the feed is not carrying it.

- [ ] **Step 2: Fetch the facts on the page**

In `app/(app)/properties/[id]/page.tsx`, after the existing `Promise.all` that loads the property (around line 75), add a second fetch that runs once `p` is known:

```ts
  const [{ data: portalConnections }, { data: portalSelections }] = await Promise.all([
    supabase
      .from("portal_connections")
      .select("portal, enabled, last_pulled_at")
      .eq("enabled", true),
    supabase
      .from("portal_listings")
      .select("portal, selected_at, selected_by")
      .eq("property_id", id),
  ]);
  const selectorIds = [...new Set((portalSelections ?? []).map((s) => s.selected_by).filter((x): x is string => Boolean(x)))];
  const { data: selectors } = selectorIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", selectorIds)
    : { data: [] as { id: string; full_name: string }[] };
  const selectorName = new Map((selectors ?? []).map((s) => [s.id, s.full_name]));
  const jpegPhotoCount = (mediaRows ?? []).filter((m) => m.kind === "photo" && m.path_jpeg).length;
  const portalInput = eligibilityInputFromProperty({
    visibility: p.visibility,
    status: p.status,
    transaction_type: p.transaction_type,
    asking_price: p.asking_price,
    rent_price_month: p.rent_price_month,
    currency: p.currency,
    public_description: p.public_description,
    property_type: p.property_type,
    districtName: p.districts?.name ?? null,
    areaName: p.areas?.name ?? null,
    jpegPhotoCount,
    coords: (() => {
      const pt = parseLocationPoint(p.location);
      return pt ? { lat: pt.lat, lng: pt.lng, approx: p.location_approx } : null;
    })(),
  });
  type PortalConn = NonNullable<typeof portalConnections>[number];
  const portalRows: PortalRow[] = (portalConnections ?? [])
    .map((c) => ({ c, def: portalById(c.portal) }))
    .filter((x): x is { c: PortalConn; def: PortalDefinition } => x.def !== null)
    .map(({ c, def }) => {
      const sel = (portalSelections ?? []).find((s) => s.portal === c.portal);
      return {
        id: def.id,
        name: def.name,
        eligibility: eligibilityFor(def, portalInput),
        selected: sel ? { at: sel.selected_at, byName: sel.selected_by ? (selectorName.get(sel.selected_by) ?? null) : null } : null,
        lastPulledAt: c.last_pulled_at,
      };
    });
```

with these imports added at the top of the page:

```ts
import { PortalsCard, type PortalRow } from "@/components/features/properties/portals-card";
import { eligibilityFor, eligibilityInputFromProperty } from "@/lib/services/portals/eligibility";
import { portalById, type PortalDefinition } from "@/lib/services/portals/registry";
import { parseLocationPoint } from "@/lib/utils/geo";
```

`parseLocationPoint` returns `LatLng | null`; check its field names in `lib/utils/geo.ts` (`lat`/`lng`) and adjust the two property reads if the type spells them differently.

- [ ] **Step 3: Render it in the Marketing tab**

Replace the Marketing `TabsContent` (around line 760) with:

```tsx
        <TabsContent value="marketing" className="mt-4">
          <div className="flex max-w-3xl flex-col gap-4">
            <div className="rounded-[10px] border border-border bg-surface p-6">
              <MarketingForm property={p} readOnly={!canEditProperty} />
            </div>
            <PortalsCard propertyId={p.id} portals={portalRows} readOnly={!canEditProperty} />
          </div>
        </TabsContent>
```

- [ ] **Step 4: Look at it**

Open a public, available listing with two JPEG photos (run the backfill if the fixtures predate 0095) → Marketing tab. Expected: a Portals card with one row per enabled portal; Select works and the row shows "Selected … by Admin"; a private listing shows the "Not on the website" reason and a disabled Select. The property's Activity tab shows "Selected for portal jamesedition".

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add components/features/properties/portals-card.tsx "app/(app)/properties/[id]/page.tsx"
git commit -m "property page: Portals card on the Marketing tab — toggles with the feed's own reasons" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: End-to-end

**Files:**
- Create: `tests/e2e/portals.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
// tests/e2e/portals.spec.ts
import { test, expect, request as pwRequest } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { baseUrl, fixtureProfile, isLocal, runTag, serviceClient } from "./helpers";

/**
 * Enable a portal → select a listing → the feed carries it → remove → gone.
 * The whole loop the spec promises, through the two UI surfaces and the
 * public route, with the anonymous fetch a portal's crawler would make.
 */
test.beforeEach(() => {
  test.skip(!isLocal(), "needs the local stack service key");
});

async function seedPublicListing(svc: SupabaseClient, orgId: string, tag: string) {
  const { data: district } = await svc.from("districts").select("id").eq("org_id", orgId).eq("code", "PAF").single();
  const reference = `E2EPRT${tag}`.slice(0, 20).toUpperCase();
  const { data: prop, error } = await svc
    .from("properties")
    .insert({
      org_id: orgId,
      reference,
      property_type: "villa",
      transaction_type: "sale",
      status: "available",
      visibility: "public",
      published_at: new Date().toISOString(),
      district_id: district!.id,
      asking_price: 450000,
      currency: "EUR",
      bedrooms: 3,
      bathrooms: 2,
      covered_area_sqm: 180,
      title: { en: "E2E portal villa" },
      public_description: { en: "Portal e2e listing." },
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const { error: mErr } = await svc.from("property_media").insert([
    { org_id: orgId, property_id: prop.id, kind: "photo", path_full: `e2e/${tag}_1_full.webp`, path_jpeg: `e2e/${tag}_1_jpeg.jpg`, is_cover: true, sort_order: 0 },
    { org_id: orgId, property_id: prop.id, kind: "photo", path_full: `e2e/${tag}_2_full.webp`, path_jpeg: `e2e/${tag}_2_jpeg.jpg`, is_cover: false, sort_order: 1 },
  ]);
  if (mErr) throw new Error(mErr.message);
  return { id: prop.id as string, reference };
}

test("enable → select → feed → remove → gone", async ({ page }) => {
  const svc = serviceClient();
  const { orgId } = await fixtureProfile(svc);
  const tag = runTag().replace(/-/g, "");
  const listing = await seedPublicListing(svc, orgId, tag);

  try {
    // 1. enable JamesEdition (idempotent across runs: an enabled card shows Disable)
    await page.goto("/settings/portals");
    const toggle = page.getByTestId("portal-toggle-jamesedition");
    if ((await toggle.textContent())?.trim() === "Enable") {
      await toggle.click();
      await expect(toggle).toHaveText("Disable");
    }
    const feedUrl = await page.getByTestId("portal-feed-url-jamesedition").inputValue();
    expect(feedUrl).toMatch(/\/api\/portals\/jamesedition\/[0-9a-f]{64}$/);

    // 2. select the listing on its Marketing tab
    await page.goto(`/properties/${listing.id}`);
    await page.getByRole("tab", { name: "Marketing" }).click();
    const select = page.getByTestId("portal-select-jamesedition");
    await expect(select).toHaveText("Select");
    await expect(select).toBeEnabled();
    await select.click();
    await expect(select).toHaveText("Remove");

    // 3. the portal's view: anonymous, no cookies
    const api = await pwRequest.newContext({ baseURL: baseUrl() });
    const res = await api.get(feedUrl.replace(/^https?:\/\/[^/]+/, ""));
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/xml");
    const xml = await res.text();
    expect(xml).toContain(`<ref>${listing.reference}</ref>`);
    expect(xml).toContain(`/media/e2e/${tag}_1_jpeg.jpg`);

    // 4. remove → gone
    await select.click();
    await expect(select).toHaveText("Select");
    const after = await api.get(feedUrl.replace(/^https?:\/\/[^/]+/, ""));
    expect(await after.text()).not.toContain(`<ref>${listing.reference}</ref>`);

    // 5. the wrong token is a 404, not a hint
    const bad = await api.get(`/api/portals/jamesedition/${"0".repeat(64)}`);
    expect(bad.status()).toBe(404);
  } finally {
    await svc.from("properties").delete().eq("id", listing.id); // media and selection cascade
  }
});
```

- [ ] **Step 2: Run it**

Run: `npx playwright test tests/e2e/portals.spec.ts --project=setup --project=desktop`
Expected: 1 passed. If the Marketing tab's Select stays disabled, the seed is missing something the eligibility names — read the reasons the card prints (they are the test's diagnostic) rather than loosening the assertion. If the Marketing tab does not switch on `click()`, use `dispatchEvent("mousedown")` on the trigger — the Radix quirk recorded in HANDOFF §7.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/portals.spec.ts
git commit -m "e2e: portals — enable, select, the feed carries it, remove, gone" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: Docs, records, verification, ship

**Files:**
- Modify: `docs/DECISIONS.md` (append)
- Modify: `HANDOFF.md` §0 (a row)
- Modify: `docs/BACKLOG.md` (milestones 2 and 3 as the next buildable items)
- Modify: `tests/README.md` (test counts)

- [ ] **Step 1: DECISIONS entry**

Append to `docs/DECISIONS.md`, following the existing `- **YYYY-MM-DD · T-… — title**` form:

```markdown
- **2026-09-14 · T-portal-syndication-m1 (migration 0095) — a listing is chosen,
  per listing, for external portals; the CRM publishes pull feeds and holds no
  certificate.** Doc 01 §10 placed external portal feeds in Phase 5 and made the
  Do-Not-Build list binding until then; the operator pulled the item forward on
  2026-09-14 after the market research in
  `docs/superpowers/specs/2026-09-14-portal-syndication-design.md`. Decisions:
  (1) pull feeds only — Rightmove and Zoopla are reached through a registered
  feed provider fed by the CRM's Kyero feed; (2) per-listing selection, no
  rules; (3) the portal feed is a PROJECTION of `public_listings` — the route
  keeps selected references, so "on a portal" ⊆ "on the site" structurally;
  (4) coordinates leave through `portal_supplement` only, for selected rows,
  and an approximate location is never emitted as an exact point; (5) a
  disabled portal answers an empty document, never 404; (6) photos go out as a
  new JPEG rendition (`path_jpeg`), because RERA takes JPEG/PNG only. Not built:
  push adapters, an outbox, inbound e-mail parsing. Bazaraki and Prian stay
  `spec: "pending"` until the operator obtains their formats.
```

- [ ] **Step 2: HANDOFF §0 row and the backlog**

Add the §0 row in the form the file uses (date, what shipped, migration, hosted state, test counts measured — see Step 4). In `docs/BACKLOG.md`, under the buildable items, add milestone 2 (RERA + Thribee dialects; `city_unmapped`; the RERA validator when it exists) and milestone 3 (JamesEdition leads pull: migration 0096 with `leads.portal`, `leads.external_ref`, the four defaulted `submit_public_enquiry` parameters, `/api/cron/portal-leads`, the button, the manual portal field) each pointing at the spec section.

- [ ] **Step 3: Full verification**

Run, in this order, and paste each result into the HANDOFF row:

```bash
npm run typecheck
```
```bash
npm run lint
```
```bash
npm test
```
```bash
npm run test:rls
```
```bash
npm run test:e2e:desktop
```
Expected: every command exits 0. Record the three test counts (unit, RLS, e2e) in `tests/README.md` and the HANDOFF row.

- [ ] **Step 4: Ship in the agreed order**

1. Push the branch: `git push -u origin feat/portal-syndication-m1` — CI rehearsal (RLS suite on a migration-built database).
2. Apply 0095 to hosted BEFORE merging (`npx supabase db push` with the linked project; the CLI token lives in `~/.gnk-crm/backup.env`). Confirm with `npx supabase migration list` that hosted shows 95.
3. Run the backfill against hosted once: `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/media/backfill-jpeg.mts`. Expect `N written, 0 skipped`.
4. Merge to `main`; Vercel deploys. Verify on production: `/settings/portals` renders for the admin; a `curl` of a wrong token answers 404; enable one portal and `curl` its URL — the empty Kyero document.
5. Commit the HANDOFF row with the measured counts and the production check.

- [ ] **Step 5: Commit**

```bash
git add docs/DECISIONS.md HANDOFF.md docs/BACKLOG.md tests/README.md
git commit -m "docs: portal syndication m1 — DECISIONS T-portal-syndication-m1, HANDOFF §0 row, milestones 2 and 3 on the backlog" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review against the spec (done while writing; recorded here)

- **Registry, connections, listings, path_jpeg, three functions** — Tasks 1, 6.
- **Eligibility as one definition; reasons enumerated** — Task 5; `city_unmapped` reserved for milestone 2 as the spec allows.
- **Feed route: 404 unknown, empty doc when disabled, ETag from bytes, max-age 300, pull noted after response, token skips metering** — Tasks 9, 10.
- **Kyero dialect rules: sale/rent, sale-or-rent once, approx coords dropped, en+ru, 50 images, contact settings** — Task 4.
- **JPEG rendition, backfill script, delete path** — Task 8.
- **Settings page: enable, URL + copy + regenerate with confirm, settings form, requirements, last pull, pending badge** — Task 12.
- **Property card: enabled portals only, reasons, selected-by, last pull, two actions, no site knock** — Tasks 11, 13.
- **Events on every write; row-count guard** — Task 11.
- **RLS tests, route behaviours, golden dialect tests, e2e** — Tasks 4, 7, 9, 14.
- **Ops: proxy exemption, DECISIONS, HANDOFF, ship order** — Tasks 10, 15.
- **Deferred to their milestones:** RERA/Thribee (M2); leads pull, `leads` columns, enquiry-door parameters, cron, `CRON_SECRET`, `JAMESEDITION_LEADS_TOKEN` (M3).

Type names used consistently across tasks: `PortalDefinition`, `PORTALS`, `portalById`, `DialectRenderer`, `DIALECT_RENDERERS`, `DIALECT_TYPE_MAPS`, `DIALECT_CURRENCIES`, `FeedListing`, `SupplementRow`, `PublicListingRow`, `eligibilityFor`, `eligibilityInputFromFeed`, `eligibilityInputFromProperty`, `REASON_TEXT`, `assemblePortalFeed`, `PortalActionState`, `setPortalEnabled`, `savePortalSettings`, `regeneratePortalToken`, `selectPortal`, `deselectPortal`, `RENDITIONS`, `renditionExt`, `renditionMime`.
