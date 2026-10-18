import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The three typed config forms (Nudges 0052, Lead routing 0098, Lead
 * escalation 0107) write one `cyprus_config` row each, row-count guarded: an
 * update that matched nothing — the row deleted, or RLS filtering it — must
 * not claim success, write an event or revalidate.
 *
 * A08 (review 2026-10-18): the refusal used to tell the admin to "re-run
 * migration 0052", an instruction for whoever deploys the database, not for
 * the person on the form. It now says what happened and who can fix it, with
 * the migration kept as the technical part for support. These drive the real
 * actions over a client whose update matches no row.
 */
const state = vi.hoisted(() => ({ updated: [] as string[] }));
const revalidatePath = vi.hoisted(() => vi.fn());
const logEvent = vi.hoisted(() => vi.fn());

vi.mock("sharp", () => ({ default: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => ({
      update: () => ({
        eq: (_col: string, key: string) => ({
          select: async () => {
            state.updated.push(`${table}:${key}`);
            return { data: [], error: null };
          },
        }),
      }),
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }),
  }),
}));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "actor-1", orgId: "org-1", role: "admin", fullName: "Actor" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath }));

const { saveNudgeThresholds, saveLeadRouting, saveLeadEscalation } = await import("@/lib/actions/settings");

const initial = { error: null, savedAt: null, tempPassword: null, invitedEmail: null, notice: null };

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

beforeEach(() => {
  state.updated = [];
  revalidatePath.mockClear();
  logEvent.mockClear();
});

describe("a typed config form whose row is missing", () => {
  const cases = [
    {
      name: "Nudges",
      run: () =>
        saveNudgeThresholds(
          initial,
          form({ deal_no_contact_days: "14", viewing_feedback_hours: "48", reservation_expiry_days: "2", installment_due_days: "7" }),
        ),
      key: "nudge_thresholds",
      migration: "0052",
    },
    { name: "Lead routing", run: () => saveLeadRouting(initial, form({ mode: "off" })), key: "lead_routing", migration: "0098" },
    {
      name: "Lead escalation",
      run: () => saveLeadEscalation(initial, form({ after_minutes: "15", max_age_hours: "48" })),
      key: "lead_escalation",
      migration: "0107",
    },
  ];

  for (const c of cases) {
    it(`${c.name}: says the setting is missing and who to ask, keeps the migration as the technical part, and claims nothing`, async () => {
      const res = await c.run();
      expect(state.updated, "the update was attempted").toEqual([`cyprus_config:${c.key}`]);
      expect(res.error).toBe(`This setting is missing — contact support (technical: migration ${c.migration}).`);
      expect(res.error).not.toMatch(/re-run/i);
      expect(res.savedAt).toBeNull();
      expect(logEvent).not.toHaveBeenCalled();
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  }
});
