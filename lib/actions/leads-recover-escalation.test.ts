import { describe, expect, it, vi } from "vitest";

/**
 * The escalation's recovery (0111): two buttons on the inbox row of a
 * website lead whose escalation stopped. The DATABASE decides whether the
 * admin may, and which of the two actions the row admits —
 * supabase/tests/lead-escalation-recovery.test.ts pins every refusal on a
 * real stack. This file pins what the action does around that decision:
 * it validates its own input, asks through the caller's own session,
 * surfaces the function's words and nothing else, and kicks the worker for
 * THAT job — not "any job of the lead" — once the row is pending again.
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
  getCurrentProfile: async () => ({ id: "actor-1", orgId: "org-1", role: "admin" }),
}));
vi.mock("@/lib/services/enquiry-alert-worker", () => ({ runEnquiryAlertWorker }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return { ...original, after: (fn: () => unknown) => state.afters.push(fn) };
});

const { recoverLeadEscalation } = await import("@/lib/actions/leads");

const JOB = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";

const reset = () => {
  state.rpc.mockReset();
  state.afters = [];
  runEnquiryAlertWorker.mockClear();
  revalidatePath.mockClear();
};

describe("recoverLeadEscalation", () => {
  it("retry: asks the database through the caller's session, then sends at once for THAT job", async () => {
    reset();
    state.rpc.mockResolvedValue({ data: [{ id: JOB, lead_id: "lead-1", state: "pending" }], error: null });
    await expect(recoverLeadEscalation({ jobId: JOB, action: "retry" })).resolves.toBeUndefined();
    expect(state.rpc).toHaveBeenCalledWith("request_lead_escalation_recovery", { p_job_id: JOB, p_action: "retry" });
    expect(state.afters, "the send is scheduled after the answer, like the desk alert's").toHaveLength(1);
    await state.afters[0]!();
    expect(runEnquiryAlertWorker).toHaveBeenCalledTimes(1);
    const [client, opts] = runEnquiryAlertWorker.mock.calls[0]!;
    expect(client).toEqual({ marker: "admin" });
    expect(opts).toMatchObject({ leadId: "lead-1", jobId: JOB, limit: 1 });
    expect(String(opts.workerId), "named for the job AND unique per run: a late completion from an earlier run must not land on this claim").toMatch(
      new RegExp(`^recover:${JOB}:[0-9a-f-]{36}$`),
    );
    expect(revalidatePath).toHaveBeenCalledWith("/leads");
  });

  it("resend: sends the job id and the action and nothing typed (0115 — the chain keeps no reason)", async () => {
    reset();
    state.rpc.mockResolvedValue({ data: [{ id: JOB, lead_id: "lead-1", state: "pending" }], error: null });
    await recoverLeadEscalation({ jobId: JOB, action: "resend" });
    expect(state.rpc).toHaveBeenCalledWith("request_lead_escalation_recovery", { p_job_id: JOB, p_action: "resend" });
  });

  it("a stale browser still posting a reason has it dropped before the database is asked", async () => {
    reset();
    state.rpc.mockResolvedValue({ data: [{ id: JOB, lead_id: "lead-1", state: "pending" }], error: null });
    const stale = { jobId: JOB, action: "resend", reason: "Called Zenobia Quillfeather-Test on +357 99 000 111" };
    await recoverLeadEscalation(stale as never);
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect(state.rpc.mock.calls[0]![1]).toEqual({ p_job_id: JOB, p_action: "resend" });
    expect(JSON.stringify(state.rpc.mock.calls)).not.toContain("Zenobia");
  });

  it("refuses malformed input before asking anything: a non-uuid, an unknown action", async () => {
    reset();
    await expect(recoverLeadEscalation({ jobId: "job-7", action: "retry" })).rejects.toThrow(/invalid/i);
    await expect(recoverLeadEscalation({ jobId: JOB, action: "reset" as never })).rejects.toThrow(/invalid/i);
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.afters).toHaveLength(0);
  });

  it("surfaces the function's own refusal in its own words, and sends nothing", async () => {
    reset();
    state.rpc.mockResolvedValue({
      data: null,
      error: { code: "P0001", message: "The same key is still safe to reuse — use Retry, which cannot send a second copy." },
    });
    await expect(recoverLeadEscalation({ jobId: JOB, action: "resend" })).rejects.toThrow(/still safe to reuse/);
    expect(state.afters).toHaveLength(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("hides any other database error behind one sentence", async () => {
    reset();
    state.rpc.mockResolvedValue({
      data: null,
      error: { code: "42P01", message: 'relation "notification_jobs" does not exist' },
    });
    await expect(recoverLeadEscalation({ jobId: JOB, action: "retry" })).rejects.toThrow(/could not queue/i);
    await expect(recoverLeadEscalation({ jobId: JOB, action: "retry" })).rejects.not.toThrow(/notification_jobs/);
    expect(state.afters).toHaveLength(0);
  });

  it("treats no row back as no job, not as success", async () => {
    reset();
    state.rpc.mockResolvedValue({ data: [], error: null });
    await expect(recoverLeadEscalation({ jobId: JOB, action: "retry" })).rejects.toThrow(/no escalation/i);
    expect(state.afters).toHaveLength(0);
  });
});
