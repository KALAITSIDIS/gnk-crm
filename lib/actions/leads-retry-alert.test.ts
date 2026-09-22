import { describe, expect, it, vi } from "vitest";

/**
 * The staff retry (0101): a button on the inbox row of a website lead whose
 * desk alert failed. The DATABASE decides whether the person may (their org,
 * their lead or an admin, no live claim, not already accepted, not redacted —
 * supabase/tests/enquiry-alert-outbox.test.ts pins every refusal on a real
 * stack). This file pins what the action does around that decision: it asks
 * through the caller's own session, surfaces the function's words and nothing
 * else, and kicks the worker for THAT lead once the row is pending again.
 */
const state = vi.hoisted(() => ({
  rpc: vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(),
  afters: [] as Array<() => unknown>,
}));
const runEnquiryAlertWorker = vi.hoisted(() =>
  vi.fn<(client: unknown, opts: Record<string, unknown>) => Promise<unknown>>(async () => ({})),
);
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: state.rpc }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ marker: "admin" }) }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "actor-1", orgId: "org-1", role: "agent" }),
}));
vi.mock("@/lib/services/enquiry-alert-worker", () => ({ runEnquiryAlertWorker }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return { ...original, after: (fn: () => unknown) => state.afters.push(fn) };
});

const { retryEnquiryAlert } = await import("@/lib/actions/leads");

const reset = () => {
  state.rpc.mockReset();
  state.afters = [];
  runEnquiryAlertWorker.mockClear();
  revalidatePath.mockClear();
};

describe("retryEnquiryAlert", () => {
  it("asks the database through the caller's session, then sends at once for that lead", async () => {
    reset();
    state.rpc.mockResolvedValue({ data: [{ id: "job-7", lead_id: "lead-1", state: "pending" }], error: null });
    await expect(retryEnquiryAlert("lead-1")).resolves.toBeUndefined();
    expect(state.rpc).toHaveBeenCalledWith("request_enquiry_alert_retry", { p_lead_id: "lead-1" });
    expect(state.afters, "the send is scheduled after the answer, like the route's").toHaveLength(1);
    await state.afters[0]!();
    expect(runEnquiryAlertWorker).toHaveBeenCalledTimes(1);
    const [client, opts] = runEnquiryAlertWorker.mock.calls[0]!;
    expect(client).toEqual({ marker: "admin" });
    expect(opts, "the lead AND the job it was told about (0111): a lead carrying both kinds must not have the other claimed").toMatchObject({
      leadId: "lead-1",
      jobId: "job-7",
      limit: 1,
    });
    expect(String(opts.workerId), "named for the job AND unique per run: a late completion from an earlier run must not land on this claim").toMatch(
      /^retry:job-7:[0-9a-f-]{36}$/,
    );
    expect(revalidatePath).toHaveBeenCalledWith("/leads");
  });

  it("surfaces the function's own refusal in its own words, and sends nothing", async () => {
    reset();
    state.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "The alert is being sent right now — try again in a minute." },
    });
    await expect(retryEnquiryAlert("lead-1")).rejects.toThrow(/being sent right now/);
    expect(state.afters).toHaveLength(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("hides any other database error behind one sentence", async () => {
    reset();
    state.rpc.mockResolvedValue({
      data: null,
      error: { code: "42P01", message: 'relation "notification_jobs" does not exist' },
    });
    await expect(retryEnquiryAlert("lead-1")).rejects.toThrow(/could not queue/i);
    await expect(retryEnquiryAlert("lead-1")).rejects.not.toThrow(/notification_jobs/);
    expect(state.afters).toHaveLength(0);
  });

  it("treats no row back as no job, not as success", async () => {
    reset();
    state.rpc.mockResolvedValue({ data: [], error: null });
    await expect(retryEnquiryAlert("lead-1")).rejects.toThrow(/no desk alert/i);
    expect(state.afters).toHaveLength(0);
  });
});
