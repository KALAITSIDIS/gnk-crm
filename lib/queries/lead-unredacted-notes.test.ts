import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { fakeClient } from "@/lib/testing/fake-client";
import { loadLeadsWithUnredactedNotes } from "./lead-unredacted-notes";

const db = (f: ReturnType<typeof fakeClient>) => f.client as unknown as SupabaseClient<Database>;

describe("loadLeadsWithUnredactedNotes", () => {
  it("makes no query for a page without a redacted, unlinked lead", async () => {
    const f = fakeClient({});
    expect(await loadLeadsWithUnredactedNotes(db(f), [])).toEqual(new Set());
    expect(f.calls).toEqual([]);
  });

  it("asks once for the page's leads, unredacted lead notes only, and answers with their ids", async () => {
    const f = fakeClient({
      interaction_notes: [{ data: [{ entity_id: "l1" }, { entity_id: "l1" }, { entity_id: "l3" }], error: null }],
    });
    expect(await loadLeadsWithUnredactedNotes(db(f), ["l1", "l2", "l3"])).toEqual(new Set(["l1", "l3"]));
    expect(f.served.interaction_notes).toBe(1);
    expect(f.argsOf("interaction_notes", "eq")).toEqual([["entity_type", "lead"]]);
    expect(f.argsOf("interaction_notes", "in")).toEqual([["entity_id", ["l1", "l2", "l3"]]]);
    expect(f.argsOf("interaction_notes", "is")).toEqual([["redacted_at", null]]);
  });

  it("offers nothing extra when the read fails, rather than breaking the page", async () => {
    const f = fakeClient({ interaction_notes: [{ data: null, error: { message: "boom" } }] });
    expect(await loadLeadsWithUnredactedNotes(db(f), ["l1"])).toEqual(new Set());
  });
});
