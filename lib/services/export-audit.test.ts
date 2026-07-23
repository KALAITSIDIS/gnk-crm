import { describe, expect, it, vi } from "vitest";
import { logListExport } from "./export-audit";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/** Minimal fake client that records the row passed to events.insert(). */
function fakeClient() {
  const insert = vi.fn().mockResolvedValue({ error: null });
  const client = {
    from: (table: string) => {
      expect(table).toBe("events");
      return { insert };
    },
  } as unknown as SupabaseClient<Database>;
  return { client, insert };
}

describe("logListExport", () => {
  it("writes an org-level 'exported' event with list, count and filters", async () => {
    const { client, insert } = fakeClient();
    await logListExport(client, {
      orgId: "org-1",
      actorId: "user-1",
      list: "contacts",
      count: 42,
      filters: { type: "buyer", archived: "1" },
    });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith({
      org_id: "org-1",
      actor_id: "user-1",
      entity_type: "export",
      entity_id: null, // an export is org-level, not tied to one row
      event_type: "exported",
      payload: { list: "contacts", count: 42, filters: { type: "buyer", archived: "1" } },
    });
  });

  it("omits the filters key entirely when no filters were applied", async () => {
    const { client, insert } = fakeClient();
    await logListExport(client, { orgId: "o", actorId: "u", list: "contacts", count: 0, filters: {} });
    const row = insert.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect(row.payload).toEqual({ list: "contacts", count: 0 });
    expect(row.payload).not.toHaveProperty("filters");
  });

  it("propagates a failed audit insert so the export can fail closed", async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: "denied" } });
    const client = { from: () => ({ insert }) } as unknown as SupabaseClient<Database>;
    await expect(
      logListExport(client, { orgId: "o", actorId: "u", list: "contacts", count: 1 }),
    ).rejects.toThrow(/logEvent failed/);
  });
});
