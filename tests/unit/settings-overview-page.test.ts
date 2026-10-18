import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

/**
 * /settings — the activation-readiness overview (A07), rendered as the REAL
 * page with the deployment's environment holding sentinel values: the session
 * and service-role clients are scripted, and the provider's domain listing is
 * a stubbed `fetch`. Pins that a non-admin gets nothing (and causes no read),
 * that neither the streamed fallback nor the final overview carries any
 * environment value, and that the page holds no form, button or input.
 */

const state = vi.hoisted(() => ({
  role: "admin" as string,
  reads: [] as string[],
}));

vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "u-1", orgId: "org-1", role: state.role, fullName: "Admin Person" }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      state.reads.push(table);
      const answer =
        table === "cyprus_config"
          ? { data: [{ key: "lead_routing", value: { mode: "off", agents: [] } }], error: null }
          : { data: [{ id: "11111111-1111-4111-8111-111111111111", role: "admin", is_active: true, email: "admin-sentinel@x.test" }], error: null };
      const chain: Record<string, unknown> = {
        select: () => chain,
        in: () => chain,
        eq: () => chain,
        then: (resolve: (v: unknown) => void) => resolve(answer),
      };
      return chain;
    },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.reads.push("admin");
    return { storage: { from: () => ({ list: async () => ({ data: [{ name: "watermark.png", updated_at: "t" }], error: null }) }) } };
  },
}));

const KEY = "re_SENTINEL_PAGE_KEY_abc123";
const DESK = "desk-sentinel@x.test";
const VALUES = [KEY, DESK, "SENTINEL_CRON_PAGE", "SENTINEL_SALT_PAGE", "SENTINEL_FWD_PAGE", "SENTINEL_REVAL_PAGE", "admin-sentinel@x.test"];

beforeEach(() => {
  state.role = "admin";
  state.reads = [];
  vi.stubEnv("RESEND_API_KEY", KEY);
  vi.stubEnv("ENQUIRY_ALERT_TO", DESK);
  vi.stubEnv("ENQUIRY_ALERT_FROM", "GNK <hello@send.sentinel-domain.test>");
  vi.stubEnv("CRON_SECRET", "SENTINEL_CRON_PAGE");
  vi.stubEnv("IP_HASH_SALT", "SENTINEL_SALT_PAGE");
  vi.stubEnv("ENQUIRY_FORWARD_KEY", "SENTINEL_FWD_PAGE");
  vi.stubEnv("SITE_REVALIDATE_URL", "https://site.test/api/revalidate");
  vi.stubEnv("SITE_REVALIDATE_KEY", "SENTINEL_REVAL_PAGE");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function page(): Promise<ReactElement | null> {
  const { default: Page } = await import("@/app/(app)/settings/page");
  return (await Page()) as ReactElement | null;
}

describe("/settings", () => {
  it("renders nothing for a non-admin and reads nothing — the layout shows 'Admins only'", async () => {
    state.role = "agent";
    await expect(page()).resolves.toBeNull();
    expect(state.reads).toEqual([]);
  });

  it("streams the overview: a fallback that is still checking the sender, then the provider's answer — neither holding any env value", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ object: "list", has_more: false, data: [{ name: "send.sentinel-domain.test", status: "verified", capabilities: { sending: "enabled" } }] }),
        { status: 200 },
      ),
    );
    const el = await page();
    expect(el).not.toBeNull();
    const { fallback, children } = el!.props as { fallback: ReactElement; children: ReactElement };

    const early = renderToStaticMarkup(fallback);
    expect(early).toContain('data-testid="readiness-sending-domain" data-state="checking"');

    const WithSender = children.type as (p: unknown) => Promise<ReactElement>;
    const late = renderToStaticMarkup(await WithSender(children.props));
    expect(late).toContain('data-testid="readiness-sending-domain" data-state="on"');
    expect(late).toContain(">Verified<");
    expect(late).toContain('data-testid="readiness-desk-alert" data-state="on"');
    expect(late).toContain('data-testid="readiness-visitor-ack" data-state="on"');
    expect(late).toContain('data-testid="readiness-watermark" data-state="on"');
    // the one provider call is the read-only domain listing
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/domains/);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("GET");

    for (const html of [early, late]) {
      for (const v of VALUES) expect(html, v).not.toContain(v);
      expect(html).not.toContain("site.test/api/revalidate");
      expect(html).not.toMatch(/<form|<button|<input|<select|<textarea/);
    }
  });
});
