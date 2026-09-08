import { describe, expect, it, vi } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";

/**
 * `media_deleted` must carry the photo's filename whoever does the deleting.
 *
 * `property_media` never stored the original filename, so a delete recovers it
 * from the photo's own `media_uploaded` event — otherwise the timeline reads
 * "Photo deleted" with nothing to say which one, the state the 2026-07-16 audit
 * added the lookup to fix.
 *
 * That lookup ran on the CALLER's client. `events_select` (0063) shows a
 * non-admin only rows where `actor_id = auth.uid()`, while
 * `property_media_delete` admits admin OR listing_manager — so a listing manager
 * tidying a gallery an agent filled found no upload event and wrote a permanent,
 * hash-chained event with no `file`, where the identical delete by an admin would
 * have carried one. Events are append-only: there is no correcting it later.
 *
 * The answer to "what was this photo called" does not depend on who is asking,
 * so it is asked of the system, with `org_id` filtered explicitly because the
 * admin client has no RLS to add it.
 */

const state = vi.hoisted(() => ({
  caller: null as unknown,
  admin: null as unknown,
  role: "listing_manager" as string,
}));
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.caller }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.admin }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "lm-1", orgId: "org-1", role: state.role }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/services/storage", () => ({ removeObjectsBestEffort: vi.fn(async () => {}) }));
vi.mock("@/lib/services/quality-score", () => ({ recomputeQualityScore: vi.fn(async () => null) }));

const { deleteMediaBulk } = await import("@/lib/actions/media");

const deleted = [
  {
    id: "m1",
    kind: "photo",
    is_cover: false,
    path_thumb: null,
    path_card: null,
    path_full: null,
    path_original: null,
  },
];

/** The upload event a COLLEAGUE wrote — invisible to this deleter under RLS. */
const uploadEvent = { payload: { media_id: "m1", file: "villa-front.jpg" } };

function harness() {
  const admin = fakeClient({
    events: [{ data: [uploadEvent], error: null }],
    property_media: [{ data: [], error: null }],
  });
  state.admin = admin.client;
  const caller = fakeClient({
    property_media: [
      { data: deleted, error: null },
      { data: [], error: null },
    ],
    // if the action ever asks the CALLER for events, it gets what RLS would
    // actually return to a listing manager for someone else's upload: nothing
    events: [{ data: [], error: null }],
  });
  state.caller = caller.client;
  return { admin, caller };
}

describe("deleteMediaBulk names the photo it deleted", () => {
  it("recovers the filename from the SYSTEM, not from the deleter's own events", async () => {
    logEvent.mockClear();
    const { admin, caller } = harness();

    const res = await deleteMediaBulk("prop-1", ["m1"]);
    expect(res.error).toBeNull();

    expect(admin.served.events, "the system answered it").toBe(1);
    expect(
      caller.served.events ?? 0,
      "the caller's client would have returned nothing for a colleague's upload",
    ).toBe(0);

    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][1]).toMatchObject({
      eventType: "media_deleted",
      payload: { media_id: "m1", file: "villa-front.jpg" },
    });
  });

  it("scopes the event read by org — the admin client has no RLS to do it", async () => {
    const { admin } = harness();
    await deleteMediaBulk("prop-1", ["m1"]);
    expect(admin.argsOf("events", "eq")).toEqual(
      expect.arrayContaining([
        ["org_id", "org-1"],
        ["entity_type", "property"],
        ["entity_id", "prop-1"],
        ["event_type", "media_uploaded"],
      ]),
    );
  });

  it("still writes the event when no upload row exists — best-effort, as before", async () => {
    logEvent.mockClear();
    const admin = fakeClient({
      events: [{ data: [], error: null }],
      property_media: [{ data: [], error: null }],
    });
    state.admin = admin.client;
    state.caller = fakeClient({
      property_media: [
        { data: deleted, error: null },
        { data: [], error: null },
      ],
    }).client;

    await deleteMediaBulk("prop-1", ["m1"]);
    const payload = (logEvent.mock.calls[0][1] as { payload: Record<string, unknown> }).payload;
    expect(payload.media_id).toBe("m1");
    expect(payload.file, "a genuine miss still renders the bare line").toBeUndefined();
  });
});
