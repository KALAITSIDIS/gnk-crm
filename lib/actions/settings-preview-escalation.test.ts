import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Settings → Lead escalation → Preview activation (0112). The DATABASE
 * evaluates the proposed values and refuses anyone but an aal2 admin of the
 * row's organisation — supabase/tests/lead-escalation-preview.test.ts pins
 * that on a real stack. This file pins what the action does around it: it
 * validates the form with the PREVIEW schema (nobody ticked is allowed),
 * stops a non-admin before asking, carries the stored timezone like the
 * save does, asks through the caller's own session with the bounded page,
 * surfaces the function's words and nothing else, refuses a document it
 * cannot read, and — the point — revalidates nothing and logs no event.
 */
const state = vi.hoisted(() => ({
  rpc: vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(),
  stored: { value: { enabled: false, timezone: "Europe/Athens", recipients: [], after_minutes: 15, max_age_hours: 48, working_hours: null } } as {
    value: unknown;
  } | null,
  role: "admin" as "admin" | "agent",
}));
const revalidatePath = vi.hoisted(() => vi.fn());
const logEvent = vi.hoisted(() => vi.fn());

vi.mock("sharp", () => ({ default: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ marker: "admin" }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: state.rpc,
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: table === "cyprus_config" ? state.stored : null, error: null }),
        }),
      }),
    }),
  }),
}));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "actor-1", orgId: "org-1", role: state.role, fullName: "Actor" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath }));

const { previewLeadEscalation } = await import("@/lib/actions/settings");

const A = "11111111-1111-1111-1111-111111111111";

const DOC = {
  evaluated_at: "2026-09-28T06:20:00+00:00",
  evaluated_as_enabled: true,
  stored_enabled: false,
  policy: { enabled: true, after_minutes: 20, max_age_hours: 24, recipients: [A], working_hours: null, timezone: "Europe/Athens" },
  recipients: [{ id: A, full_name: "A", role: "admin", is_active: true, has_email: true, eligible: true, reason: "ok" }],
  eligible_recipient_count: 1,
  counts: { considered: 0, due: 0, would_send: 0, no_recipient: 0, only_recipient_is_assignee: 0, not_yet_due: 0, past_cutoff: 0, already_escalated: 0 },
  leads: [],
  truncated: false,
  limit: 50,
};

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
  }
  return fd;
}

const proposed = { enabled: "on", after_minutes: "20", max_age_hours: "24", recipients: [A, A] };

beforeEach(() => {
  state.rpc.mockReset();
  state.role = "admin";
  revalidatePath.mockClear();
  logEvent.mockClear();
});

describe("previewLeadEscalation", () => {
  it("asks the database for the proposed values through the caller's session, with the stored timezone and the bounded page", async () => {
    state.rpc.mockResolvedValue({ data: DOC, error: null });
    const res = await previewLeadEscalation(form(proposed));
    expect(res.error).toBeNull();
    expect(res.preview?.counts.due).toBe(0);
    expect(state.rpc).toHaveBeenCalledTimes(1);
    const [name, args] = state.rpc.mock.calls[0]!;
    expect(name).toBe("preview_lead_escalation");
    expect(args).toEqual({
      p_policy: { enabled: true, after_minutes: 20, max_age_hours: 24, recipients: [A], working_hours: null, timezone: "Europe/Athens" },
      p_limit: 50,
    });
  });

  it("carries working hours in the sweep's shape when they are on", async () => {
    state.rpc.mockResolvedValue({ data: DOC, error: null });
    await previewLeadEscalation(form({ ...proposed, hours_enabled: "on", days: ["5", "1"], start: "08:30", end: "17:00" }));
    const args = state.rpc.mock.calls[0]![1] as { p_policy: Record<string, unknown> };
    expect(args.p_policy.working_hours).toEqual({ days: [1, 5], start: "08:30", end: "17:00" });
  });

  it("previews with nobody ticked — that is the preview that shows every enquiry as unsendable", async () => {
    state.rpc.mockResolvedValue({ data: DOC, error: null });
    const res = await previewLeadEscalation(form({ enabled: "on", after_minutes: "15", max_age_hours: "48" }));
    expect(res.error).toBeNull();
    const args = state.rpc.mock.calls[0]![1] as { p_policy: Record<string, unknown> };
    expect(args.p_policy.recipients).toEqual([]);
  });

  it("refuses a silly form with the form's own sentence, before asking anything", async () => {
    const res = await previewLeadEscalation(form({ ...proposed, after_minutes: "2" }));
    expect(res.error).toMatch(/minimum/i);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("stops a non-admin before asking", async () => {
    state.role = "agent";
    const res = await previewLeadEscalation(form(proposed));
    expect(res.error).toMatch(/admins only/i);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("surfaces the function's own refusal in its own words, and hides any other database error behind one sentence", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "Second factor required." } });
    expect((await previewLeadEscalation(form(proposed))).error).toBe("Second factor required.");
    state.rpc.mockResolvedValue({ data: null, error: { code: "42883", message: "function public.preview_lead_escalation(jsonb, integer) does not exist" } });
    const other = await previewLeadEscalation(form(proposed));
    expect(other.error).toMatch(/could not/i);
    expect(other.error).not.toMatch(/preview_lead_escalation/);
  });

  it("refuses a document it cannot read rather than rendering it", async () => {
    state.rpc.mockResolvedValue({ data: { counts: "many" }, error: null });
    const res = await previewLeadEscalation(form(proposed));
    expect(res.error).toMatch(/shape|understand/i);
    expect(res.preview).toBeNull();
  });

  it("writes nothing: no revalidation, no event, no admin client", async () => {
    state.rpc.mockResolvedValue({ data: DOC, error: null });
    await previewLeadEscalation(form(proposed));
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });

  /**
   * Audit 2026-09-22 (late): the sender is reported apart from the
   * recipients — the old `providerArmed` said "armed" for Resend's test
   * sender and an unverified domain alike. The report comes with the
   * preview; the provider is asked (read-only) only for a custom From, and
   * only once the caller has passed the admin gate.
   */
  describe("the sender report", () => {
    const OLD = { ...process.env };
    beforeEach(() => {
      process.env = { ...OLD };
    });
    afterEach(() => {
      process.env = { ...OLD };
      vi.restoreAllMocks();
    });

    it("says not configured without the provider key or the desk address, asking nobody", async () => {
      delete process.env.RESEND_API_KEY;
      delete process.env.ENQUIRY_ALERT_TO;
      const fetchMock = vi.spyOn(globalThis, "fetch");
      state.rpc.mockResolvedValue({ data: DOC, error: null });
      const res = await previewLeadEscalation(form(proposed));
      expect(res.error).toBeNull();
      expect(res.error === null && res.sender.state).toBe("not_configured");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("says test sender when ENQUIRY_ALERT_FROM is unset, even with the key and desk address — not 'armed'", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      process.env.ENQUIRY_ALERT_TO = "desk@example.com";
      delete process.env.ENQUIRY_ALERT_FROM;
      const fetchMock = vi.spyOn(globalThis, "fetch");
      state.rpc.mockResolvedValue({ data: DOC, error: null });
      const res = await previewLeadEscalation(form(proposed));
      expect(res.error === null && res.sender).toEqual({ state: "test_sender", fromSet: false, domain: "resend.dev" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("asks the provider's domain list for a custom From — once, read-only — and never for a caller the gate stops", async () => {
      process.env.RESEND_API_KEY = "re_test_key";
      process.env.ENQUIRY_ALERT_TO = "desk@example.com";
      process.env.ENQUIRY_ALERT_FROM = "GN Kalaitsidis <alerts@send.kalaitsidis.com>";
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => new Response(JSON.stringify({ object: "list", has_more: false, data: [{ name: "send.kalaitsidis.com", status: "pending" }] }), { status: 200 }));
      state.rpc.mockResolvedValue({ data: DOC, error: null });

      state.role = "agent";
      expect((await previewLeadEscalation(form(proposed))).error).toMatch(/admins only/i);
      expect((await previewLeadEscalation(form({ ...proposed, after_minutes: "2" }))).error).toMatch(/minimum/i);
      expect(fetchMock, "a refused caller makes no provider call").not.toHaveBeenCalled();

      state.role = "admin";
      const res = await previewLeadEscalation(form(proposed));
      expect(res.error === null && res.sender).toEqual({ state: "custom_not_verified", domain: "send.kalaitsidis.com", providerStatus: "pending" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toMatch(/^https:\/\/api\.resend\.com\/domains/);
      expect(init?.method).toBe("GET");
    });
  });
});
