import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/**
 * Settings → Organization (A07 review), rendered as the REAL page with the
 * session and service-role clients scripted. Pins the page's two fixes:
 *
 *  - a FAILED branding listing reads "Could not check whether one is
 *    uploaded", never "Not uploaded yet." — the old page read a failed
 *    listing as an empty folder (`brandingFiles ?? []`), the reassuring
 *    answer and the wrong one;
 *  - each upload's hint says what the file does today (BRANDING_USE), not
 *    the old promise that the logo is "used on documents and reports".
 *
 * And that a non-admin gets nothing and causes no read (the layout shows
 * "Admins only").
 */

type Listing = { data: unknown; error: { message: string } | null } | Error;

const state = vi.hoisted(() => ({
  role: "admin" as string,
  reads: [] as string[],
  listing: { data: [], error: null } as { data: unknown; error: { message: string } | null } | Error,
}));

// the forms' hooks and actions, outside a Next app: rendering must need neither
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/actions/settings", () => ({ updateOrgName: vi.fn(), uploadBranding: vi.fn() }));

vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "u-1", orgId: "org-1", role: state.role, fullName: "Admin Person" }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      state.reads.push(table);
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: { name: "GNK Test Office" }, error: null }),
      };
      return chain;
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.reads.push("admin");
    return {
      storage: {
        from: () => ({
          list: async () => {
            if (state.listing instanceof Error) throw state.listing;
            return state.listing;
          },
          getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.test/media/${path}` } }),
        }),
      },
    };
  },
}));

const { default: OrganizationSettingsPage } = await import("@/app/(app)/settings/organization/page");
const { BRANDING_USE } = await import("@/lib/services/branding");

const decode = (s: string) =>
  s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

async function render(listing: Listing): Promise<string> {
  state.listing = listing;
  const el = (await OrganizationSettingsPage()) as ReactElement | null;
  expect(el).not.toBeNull();
  return decode(renderToStaticMarkup(el!));
}

const count = (html: string, needle: string) => html.split(needle).length - 1;
const COULD_NOT_CHECK = "Could not check whether one is uploaded";
const NOT_UPLOADED = "Not uploaded yet.";

beforeEach(() => {
  state.role = "admin";
  state.reads = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("Settings → Organization", () => {
  it("renders nothing for a non-admin and reads nothing — the layout shows 'Admins only'", async () => {
    state.role = "agent";
    await expect(OrganizationSettingsPage()).resolves.toBeNull();
    expect(state.reads).toEqual([]);
  });

  it("a failed branding listing is 'Could not check' for both files — never 'Not uploaded yet.'", async () => {
    for (const listing of [
      { data: null, error: { message: "storage unavailable" } },
      { data: null, error: null }, // an answer with no file list
      new Error("socket hang up"), // a listing that rejected
    ] satisfies Listing[]) {
      const html = await render(listing);
      expect(count(html, COULD_NOT_CHECK)).toBe(2);
      expect(html).not.toContain(NOT_UPLOADED);
      expect(html).not.toContain("<img");
    }
  });

  it("an empty folder is 'Not uploaded yet.' for both — and only then", async () => {
    const html = await render({ data: [], error: null });
    expect(count(html, NOT_UPLOADED)).toBe(2);
    expect(html).not.toContain(COULD_NOT_CHECK);
    expect(html).not.toContain("<img");
  });

  it("an uploaded file shows its preview, cache-busted by its own updated_at; the other stays 'Not uploaded yet.'", async () => {
    const html = await render({ data: [{ name: "logo.png", updated_at: "2026-10-18T09:00:00Z" }], error: null });
    expect(html).toContain('src="https://storage.test/media/branding/logo.png?v=2026-10-18T09%3A00%3A00Z"');
    expect(html).toContain('alt="Current logo"');
    expect(count(html, NOT_UPLOADED)).toBe(1);
    expect(html).not.toContain(COULD_NOT_CHECK);
  });

  it("each hint says what the file does today — not that the logo is used on documents and reports", async () => {
    const html = await render({ data: [], error: null });
    expect(html).toContain(`PNG · ${BRANDING_USE.logo}`);
    expect(html).toContain(`PNG with transparency · ${BRANDING_USE.watermark}`);
    expect(html).not.toMatch(/used on documents and reports/i);
    expect(html).not.toMatch(/media pipeline/i);
    // the organization's own name still loads into its form
    expect(html).toContain('value="GNK Test Office"');
  });
});
