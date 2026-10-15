import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOT_CONFIRMED_NOTICE, NOT_RECORDED_NOTICE } from "@/lib/services/optimistic-save";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * A one-time secret is shown, never lost (T-one-time-secrets; BACKLOG "A
 * one-time secret is created and never shown", in "Throws after a commit —
 * 2026-10-13").
 *
 * Four actions hand back a secret that exists nowhere else: `inviteUser` the
 * colleague's one-time password, `setPortalEnabled` and
 * `regeneratePortalToken` a feed URL, `createShareLink` and
 * `createAvailabilityLink` a link. Each used to await its event line AFTER
 * the secret was committed, and `logEvent` throws EventWriteError on any
 * answer that is not a 201 — so the action rethrew to the error page, the
 * secret was never shown, and the obvious retry was refused (an invite:
 * `email_exists`) or minted a second one.
 *
 * Driven through the REAL actions and the REAL logEvent: the `events` insert
 * is answered as PostgREST would answer it, so logEvent throws exactly as in
 * production. Three kinds of answer:
 *   - UNSETTLED (XX000, a code-less 502, a hollow 204): the line may be
 *     written. The secret comes back WITH a notice that its timeline entry
 *     could not be CONFIRMED (BACKLOG's NOTE: a failed logEvent does not say
 *     whether its line was written), the page is revalidated, and nothing is
 *     revoked or deleted.
 *   - REFUSED (42501, which `certainlyRolledBack` understands): the line is
 *     certainly missing. A link or a feed URL still comes back, with the
 *     house's NOT_RECORDED_NOTICE; an invite is undone — the account deleted,
 *     so no account exists without its line — unless the delete itself is not
 *     confirmed.
 *   - A failure BEFORE the secret is committed refuses exactly as it did.
 *
 * The two steps between the commit and the line — the invite's profile
 * insert and a link's curation insert — used to delete on ANY failure. Now
 * only a refusal deletes; an unknown answer is read back.
 */
const state = vi.hoisted(() => ({
  session: null as unknown,
  admin: null as null | { from: (table: string) => unknown },
}));
const auth = vi.hoisted(() => ({
  createUser: vi.fn<(attrs: Record<string, unknown>) => Promise<unknown>>(),
  deleteUser: vi.fn<(id: string) => Promise<unknown>>(),
}));
const revalidatePath = vi.hoisted(() => vi.fn<(path: string) => void>());

vi.mock("sharp", () => ({ default: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.session }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: { admin: auth },
    from: (table: string) => {
      if (!state.admin) throw new Error(`the admin client was asked for ${table} with none scripted`);
      return state.admin.from(table);
    },
  }),
}));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "admin-1", orgId: "org-1", role: "admin", fullName: "An Admin" }),
}));
vi.mock("next/cache", () => ({ revalidatePath }));

const { inviteUser } = await import("@/lib/actions/settings");
const { setPortalEnabled, regeneratePortalToken } = await import("@/lib/actions/portals");
const { createShareLink, createAvailabilityLink } = await import("@/lib/actions/share-links");

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const USER_ID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7d01";
const LINK_ID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7d02";
const PROPERTY_1 = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7d03";
const PROPERTY_2 = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7d04";
const PROJECT_ID = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7d05";
const EMAIL = "new.agent@example.com";

/** answers to the `events` insert under which the line MAY have landed */
const UNSETTLED: [string, FakePage][] = [
  ["XX000, reportable for a commit that went through", { data: null, error: { message: "Fixture: internal error", code: "XX000" } }],
  ["a code-less 502 from the gateway", { data: null, error: { message: "" }, status: 502 }],
  ["a hollow 204 that never said Created", { data: null, error: null, status: 204 }],
];
/** an answer `certainlyRolledBack` understands: the line is certainly not there */
const REFUSED: FakePage = {
  data: null,
  error: { message: 'new row violates row-level security policy for table "events"', code: "42501" },
};
/**
 * Every event-line failure, with the notice it earns: a link or a feed URL
 * keeps its secret under all of them; only the words differ by certainty.
 */
const EVERY_EVENT_FAILURE: [string, FakePage, string][] = [
  ...UNSETTLED.map(([label, page]): [string, FakePage, string] => [label, page, NOT_CONFIRMED_NOTICE]),
  ["42501, a certain refusal", REFUSED, NOT_RECORDED_NOTICE],
];

function use(session: Record<string, FakePage[]>, admin: Record<string, FakePage[]> = {}) {
  const s = fakeClient(session);
  const a = fakeClient(admin);
  state.session = s.client;
  state.admin = a.client;
  return { session: s, admin: a };
}

/** the event rows the action asked to write, by type */
const linesWritten = (fake: ReturnType<typeof fakeClient>) =>
  fake.argsOf("events", "insert").map((args) => (args[0] as { event_type: string }).event_type);

beforeEach(() => {
  auth.createUser.mockReset().mockResolvedValue({ data: { user: { id: USER_ID } }, error: null });
  auth.deleteUser.mockReset().mockResolvedValue({ data: { user: null }, error: null });
  revalidatePath.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/* ------------------------------------------------------------------ */
/* inviteUser                                                          */
/* ------------------------------------------------------------------ */

const inviteForm = () => {
  const fd = new FormData();
  fd.set("email", EMAIL);
  fd.set("full_name", "New Agent");
  fd.set("role", "agent");
  return fd;
};
const BLANK = { error: null, savedAt: null, tempPassword: null, invitedEmail: null, notice: null };
/** the password the action handed GoTrue — the one the admin must be shown */
const passwordGiven = () => (auth.createUser.mock.calls[0]![0] as { password: string }).password;

describe("inviteUser — the one-time password", () => {
  it("control: everything lands — the password, no notice, one `invited` line", async () => {
    const { session } = use({ profiles: [{ data: null, error: null }] });
    const res = await inviteUser(BLANK, inviteForm());
    expect(res.error).toBeNull();
    expect(res.tempPassword).toBe(passwordGiven());
    expect(res.invitedEmail).toBe(EMAIL);
    expect(res.notice ?? null).toBeNull();
    expect(linesWritten(session)).toEqual(["invited"]);
    expect(auth.deleteUser).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/settings/users");
  });

  it.each(UNSETTLED)(
    "an `invited` line that may have landed (%s) shows the password WITH the notice, revalidates, and keeps the account",
    async (_label, answer) => {
      const { session } = use({ profiles: [{ data: null, error: null }], events: [answer] });
      const res = await inviteUser(BLANK, inviteForm());
      expect(res.error).toBeNull();
      expect(res.tempPassword, "the password exists nowhere else").toBe(passwordGiven());
      expect(res.invitedEmail).toBe(EMAIL);
      expect(res.notice, "the line may be there: it could not be CONFIRMED").toBe(NOT_CONFIRMED_NOTICE);
      expect(revalidatePath).toHaveBeenCalledWith("/settings/users");
      expect(auth.deleteUser, "never delete on an unsettled answer — the line may name this user").not.toHaveBeenCalled();
      expect(linesWritten(session)).toEqual(["invited"]);
    },
  );

  it("a REFUSED `invited` line undoes the invitation: the account is deleted and nothing is shown", async () => {
    use({ profiles: [{ data: null, error: null }], events: [REFUSED] });
    const res = await inviteUser(BLANK, inviteForm());
    expect(auth.deleteUser).toHaveBeenCalledTimes(1);
    expect(auth.deleteUser).toHaveBeenCalledWith(USER_ID);
    expect(res.tempPassword, "no password for an account that no longer exists").toBeNull();
    expect(res.error).toMatch(/could not be recorded/i);
    expect(res.error).toMatch(/removed/i);
    expect(res.error, "the database's words are not the sentence").not.toMatch(/row-level security/);
  });

  it.each([
    ["answers an error", async () => ({ data: null, error: { message: "fetch failed" } })],
    ["throws", async () => Promise.reject(new Error("socket hang up"))],
  ] as const)(
    "a refused line whose undo %s keeps the account — and shows its password WITH the notice",
    async (_label, deleteAnswer) => {
      auth.deleteUser.mockImplementation(deleteAnswer);
      use({ profiles: [{ data: null, error: null }], events: [REFUSED] });
      const res = await inviteUser(BLANK, inviteForm());
      expect(auth.deleteUser).toHaveBeenCalledTimes(1);
      expect(res.error).toBeNull();
      expect(res.tempPassword).toBe(passwordGiven());
      expect(res.notice).toBe(NOT_RECORDED_NOTICE);
      expect(revalidatePath).toHaveBeenCalledWith("/settings/users");
    },
  );

  it("an account GoTrue refuses (email_exists) refuses as today: nothing else runs", async () => {
    auth.createUser.mockResolvedValue({
      data: { user: null },
      error: { message: "A user with this email address has already been registered", status: 422, code: "email_exists" },
    });
    const { session } = use({});
    const res = await inviteUser(BLANK, inviteForm());
    expect(res.error).toBe("A user with this email address has already been registered");
    expect(res.tempPassword).toBeNull();
    expect(session.calls, "no profile, no line").toHaveLength(0);
    expect(auth.deleteUser).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["42501", "23505", "23503", "PGRST204"])(
    "a REFUSED profile insert (%s) deletes the orphan login and refuses as today",
    async (code) => {
      const { session } = use({ profiles: [{ data: null, error: { message: `Fixture: refused ${code}`, code } }] });
      const res = await inviteUser(BLANK, inviteForm());
      expect(auth.deleteUser).toHaveBeenCalledWith(USER_ID);
      expect(res.error).toBe(`Fixture: refused ${code}`);
      expect(res.tempPassword).toBeNull();
      expect(linesWritten(session), "no line for an invitation that did not happen").toEqual([]);
    },
  );

  it("a refused profile insert whose delete is not confirmed says the sign-in account may remain", async () => {
    auth.deleteUser.mockResolvedValue({ data: null, error: { message: "fetch failed" } });
    use({ profiles: [{ data: null, error: { message: "Fixture: refused", code: "42501" } }] });
    const res = await inviteUser(BLANK, inviteForm());
    expect(res.tempPassword).toBeNull();
    expect(res.error).toMatch(/^Fixture: refused/);
    expect(res.error).toMatch(/may still exist/i);
    expect(res.error).toContain(EMAIL);
  });

  const UNKNOWN_PROFILE: [string, FakePage][] = [
    ["XX000", { data: null, error: { message: "Fixture: internal error", code: "XX000" } }],
    ["57014", { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } }],
    ["a code-less 502", { data: null, error: { message: "" }, status: 502 }],
    ["a hollow 204", { data: null, error: null, status: 204 }],
  ];

  it.each(UNKNOWN_PROFILE)(
    "a profile insert answered %s is read back, never deleted — found, the invitation completes",
    async (_label, answer) => {
      const { session, admin } = use(
        { profiles: [answer] },
        { profiles: [{ data: [{ id: USER_ID }], error: null }] },
      );
      const res = await inviteUser(BLANK, inviteForm());
      expect(auth.deleteUser, "an unknown answer never deletes the account").not.toHaveBeenCalled();
      expect(admin.argsOf("profiles", "eq"), "read back by this account's id").toEqual([["id", USER_ID]]);
      expect(res.error).toBeNull();
      expect(res.tempPassword).toBe(passwordGiven());
      expect(res.notice ?? null).toBeNull();
      expect(linesWritten(session)).toEqual(["invited"]);
    },
  );

  it.each([
    ["finds no row", { data: [], error: null }],
    ["fails", { data: null, error: { message: "Fixture: read failed" } }],
  ] as [string, FakePage][])(
    "a profile insert answered XX000 whose read-back %s keeps the account and shows the password WITH a notice to check",
    async (_label, readBack) => {
      const { session } = use(
        { profiles: [{ data: null, error: { message: "Fixture: internal error", code: "XX000" } }] },
        { profiles: [readBack] },
      );
      const res = await inviteUser(BLANK, inviteForm());
      expect(auth.deleteUser).not.toHaveBeenCalled();
      expect(res.error).toBeNull();
      expect(res.tempPassword).toBe(passwordGiven());
      expect(res.notice).toMatch(/profile could not be confirmed/i);
      expect(res.notice).toContain(EMAIL);
      expect(linesWritten(session), "the account exists, so its line is written").toEqual(["invited"]);
      expect(revalidatePath).toHaveBeenCalledWith("/settings/users");
    },
  );

  it("an unconfirmed profile AND an unconfirmed line: the password, with BOTH said", async () => {
    use(
      { profiles: [{ data: null, error: { message: "", code: "57014" } }], events: [UNSETTLED[1]![1]] },
      { profiles: [{ data: [], error: null }] },
    );
    const res = await inviteUser(BLANK, inviteForm());
    expect(auth.deleteUser).not.toHaveBeenCalled();
    expect(res.tempPassword).toBe(passwordGiven());
    expect(res.notice).toMatch(/profile could not be confirmed/i);
    expect(res.notice, "neither notice hides the other").toContain(NOT_CONFIRMED_NOTICE);
  });
});

/* ------------------------------------------------------------------ */
/* the portal feed URL                                                 */
/* ------------------------------------------------------------------ */

const PORTAL_PATH = "/settings/portals";
const portalWrites = (fake: ReturnType<typeof fakeClient>) =>
  fake.calls.filter((c) => c.table === "portal_connections" && ["insert", "update", "delete", "upsert"].includes(c.method));

describe("setPortalEnabled — a first enable's feed URL", () => {
  it.each(EVERY_EVENT_FAILURE)(
    "a `portal_enabled` line that fails (%s) still hands the token back WITH the notice, and never rotates it again",
    async (_label, answer, notice) => {
      const { session } = use({
        portal_connections: [
          { data: null, error: null }, // no row yet
          { data: [{ id: "conn-1" }], error: null }, // the INSERT that stores the digest
        ],
        events: [answer],
      });
      const res = await setPortalEnabled("jamesedition", true);
      expect(res.error).toBeNull();
      expect(res.token).toMatch(/^[0-9a-f]{64}$/);
      const payload = session.argsOf("portal_connections", "insert")[0]![0] as { feed_token_sha256: string };
      expect(sha256(res.token!), "the token whose digest the row holds").toBe(payload.feed_token_sha256);
      expect(res.notice).toBe(notice);
      expect(revalidatePath).toHaveBeenCalledWith(PORTAL_PATH);
      expect(portalWrites(session), "no second write: the URL is never revoked").toHaveLength(1);
      expect(linesWritten(session)).toEqual(["portal_enabled"]);
    },
  );

  it("a disable whose line fails is still a disable, with the notice (no token)", async () => {
    const { session } = use({
      portal_connections: [
        { data: { id: "conn-1", settings: {}, feed_token_sha256: "b".repeat(64) }, error: null },
        { data: [{ id: "conn-1" }], error: null },
      ],
      events: [UNSETTLED[0]![1]],
    });
    const res = await setPortalEnabled("jamesedition", false);
    expect(res.error).toBeNull();
    expect(res.token ?? null).toBeNull();
    expect(res.notice).toBe(NOT_CONFIRMED_NOTICE);
    expect(revalidatePath).toHaveBeenCalledWith(PORTAL_PATH);
    expect(linesWritten(session)).toEqual(["portal_disabled"]);
  });

  it("control: the line lands — the token, no notice", async () => {
    use({
      portal_connections: [
        { data: null, error: null },
        { data: [{ id: "conn-1" }], error: null },
      ],
    });
    const res = await setPortalEnabled("jamesedition", true);
    expect(res.error).toBeNull();
    expect(res.token).toMatch(/^[0-9a-f]{64}$/);
    expect(res.notice ?? null).toBeNull();
  });

  it("the write that would store the digest is REFUSED — before the secret is committed, it refuses as today", async () => {
    const { session } = use({
      portal_connections: [
        { data: null, error: null },
        { data: null, error: { message: "new row violates row-level security policy", code: "42501" } },
      ],
    });
    const res = await setPortalEnabled("jamesedition", true);
    expect(res.error).toBe("new row violates row-level security policy");
    expect(res.token ?? null).toBeNull();
    expect(res.notice ?? null).toBeNull();
    expect(linesWritten(session)).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("regeneratePortalToken — the new feed URL", () => {
  it.each(EVERY_EVENT_FAILURE)(
    "a `portal_token_regenerated` line that fails (%s) still hands the new token back WITH the notice",
    async (_label, answer, notice) => {
      const { session } = use({
        portal_connections: [{ data: [{ id: "conn-1" }], error: null }],
        events: [answer],
      });
      const res = await regeneratePortalToken("jamesedition");
      expect(res.error).toBeNull();
      const payload = session.argsOf("portal_connections", "update")[0]![0] as { feed_token_sha256: string };
      expect(sha256(res.token!), "the old URL is dead; this is the only live one").toBe(payload.feed_token_sha256);
      expect(res.notice).toBe(notice);
      expect(revalidatePath).toHaveBeenCalledWith(PORTAL_PATH);
      expect(portalWrites(session), "never rotated back or again").toHaveLength(1);
    },
  );

  it("a refused rotation refuses as today, with no token and no line", async () => {
    const { session } = use({
      portal_connections: [{ data: null, error: { message: "permission denied for table portal_connections", code: "42501" } }],
    });
    const res = await regeneratePortalToken("jamesedition");
    expect(res.error).toBe("permission denied for table portal_connections");
    expect(res.token ?? null).toBeNull();
    expect(linesWritten(session)).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* share links                                                         */
/* ------------------------------------------------------------------ */

const LINK_ACTIONS = [
  {
    name: "createShareLink",
    run: () => createShareLink({ property_ids: [PROPERTY_1, PROPERTY_2] }),
    reads: { properties: [{ data: [{ id: PROPERTY_1 }, { id: PROPERTY_2 }], error: null }] } as Record<string, FakePage[]>,
    curated: [{ property_id: PROPERTY_1 }, { property_id: PROPERTY_2 }],
    paths: ["/share-links"],
  },
  {
    name: "createAvailabilityLink",
    run: () => createAvailabilityLink({ project_id: PROJECT_ID }),
    reads: {
      properties: [{ data: { id: PROJECT_ID, kind: "project", reference: "PRJ0001" }, error: null }],
    } as Record<string, FakePage[]>,
    curated: [{ property_id: PROJECT_ID }],
    paths: ["/share-links", `/properties/${PROJECT_ID}/units`],
  },
] as const;

const linkWrites = (fake: ReturnType<typeof fakeClient>) =>
  fake.calls.filter((c) => c.table === "share_links" && ["update", "delete", "upsert"].includes(c.method));
/** the token's digest the share_links INSERT stored */
const storedDigest = (fake: ReturnType<typeof fakeClient>) =>
  (fake.argsOf("share_links", "insert")[0]![0] as { token_sha256: string }).token_sha256;
const tokenOf = (path: string | null) => (path ?? "").replace(/^\/p\//, "");

describe.each(LINK_ACTIONS)("$name — the link's only plaintext token", (action) => {
  it.each(EVERY_EVENT_FAILURE)(
    "a `created` line that fails (%s) still hands the link back WITH the notice, revalidated, never revoked",
    async (_label, answer, notice) => {
      const { session } = use({
        ...action.reads,
        share_links: [{ data: { id: LINK_ID }, error: null }],
        share_link_properties: [{ data: null, error: null }],
        events: [answer],
      });
      const res = await action.run();
      expect(res.error).toBeNull();
      expect(res.path).toMatch(/^\/p\/[A-Za-z0-9_-]{43}$/);
      expect(sha256(tokenOf(res.path)), "the token whose digest the row holds").toBe(storedDigest(session));
      expect(res.notice).toBe(notice);
      for (const p of action.paths) expect(revalidatePath).toHaveBeenCalledWith(p);
      expect(linkWrites(session), "the link is never revoked or deleted").toEqual([]);
      expect(linesWritten(session)).toEqual(["created"]);
    },
  );

  it("control: the line lands — the link, no notice", async () => {
    use({
      ...action.reads,
      share_links: [{ data: { id: LINK_ID }, error: null }],
      share_link_properties: [{ data: null, error: null }],
    });
    const res = await action.run();
    expect(res.error).toBeNull();
    expect(res.path).toMatch(/^\/p\//);
    expect(res.notice ?? null).toBeNull();
  });

  it("the link insert is REFUSED — before the secret is committed, it refuses as today", async () => {
    const { session } = use({
      ...action.reads,
      share_links: [{ data: null, error: { message: "new row violates row-level security policy", code: "42501" } }],
    });
    const res = await action.run();
    expect(res.error).toBe("new row violates row-level security policy");
    expect(res.path).toBeNull();
    expect(session.argsOf("share_link_properties", "insert"), "nothing curated").toHaveLength(0);
    expect(linesWritten(session)).toEqual([]);
  });

  it.each(["23503", "42501"])(
    "a REFUSED curation insert (%s) refuses as today: the husk's delete is attempted, no link and no line",
    async (code) => {
      const { session } = use({
        ...action.reads,
        share_links: [{ data: { id: LINK_ID }, error: null }],
        share_link_properties: [{ data: null, error: { message: `Fixture: refused ${code}`, code } }],
      });
      const res = await action.run();
      expect(res.error).toBe(`Fixture: refused ${code}`);
      expect(res.path).toBeNull();
      expect(session.argsOf("share_links", "delete"), "a refusal is the only failure that removes it").toHaveLength(1);
      expect(linesWritten(session)).toEqual([]);
    },
  );

  const UNKNOWN_CURATION: [string, FakePage][] = [
    ["XX000", { data: null, error: { message: "Fixture: internal error", code: "XX000" } }],
    ["a code-less 502", { data: null, error: { message: "" }, status: 502 }],
    ["a hollow 204", { data: null, error: null, status: 204 }],
  ];

  it.each(UNKNOWN_CURATION)(
    "a curation insert answered %s is read back, never deleted — found, the link comes back clean",
    async (_label, answer) => {
      const { session } = use({
        ...action.reads,
        share_links: [{ data: { id: LINK_ID }, error: null }],
        share_link_properties: [answer, { data: [...action.curated], error: null }],
      });
      const res = await action.run();
      expect(linkWrites(session), "an unknown answer never removes the link").toEqual([]);
      expect(session.argsOf("share_link_properties", "eq"), "read back by this link").toContainEqual(["share_link_id", LINK_ID]);
      expect(res.error).toBeNull();
      expect(res.path).toMatch(/^\/p\//);
      expect(res.notice ?? null).toBeNull();
      expect(linesWritten(session)).toEqual(["created"]);
    },
  );

  it.each([
    ["finds nothing", { data: [], error: null }],
    ["fails", { data: null, error: { message: "Fixture: read failed" } }],
  ] as [string, FakePage][])(
    "a curation insert answered XX000 whose read-back %s keeps the link and hands it back WITH a notice to check it",
    async (_label, readBack) => {
      const { session } = use({
        ...action.reads,
        share_links: [{ data: { id: LINK_ID }, error: null }],
        share_link_properties: [{ data: null, error: { message: "Fixture: internal error", code: "XX000" } }, readBack],
      });
      const res = await action.run();
      expect(linkWrites(session)).toEqual([]);
      expect(res.error).toBeNull();
      expect(sha256(tokenOf(res.path))).toBe(storedDigest(session));
      expect(res.notice).toMatch(/could not be confirmed/i);
      expect(res.notice).toMatch(/revoke it/i);
      for (const p of action.paths) expect(revalidatePath).toHaveBeenCalledWith(p);
    },
  );

  it("an unconfirmed curation AND a refused line: the link, with BOTH said", async () => {
    use({
      ...action.reads,
      share_links: [{ data: { id: LINK_ID }, error: null }],
      share_link_properties: [{ data: null, error: null, status: 204 }, { data: [], error: null }],
      events: [REFUSED],
    });
    const res = await action.run();
    expect(res.path).toMatch(/^\/p\//);
    expect(res.notice).toMatch(/revoke it/i);
    expect(res.notice, "neither notice hides the other").toContain(NOT_RECORDED_NOTICE);
  });
});

it("createShareLink: a read-back that finds only SOME of the curation is not a confirmation", async () => {
  use({
    properties: [{ data: [{ id: PROPERTY_1 }, { id: PROPERTY_2 }], error: null }],
    share_links: [{ data: { id: LINK_ID }, error: null }],
    share_link_properties: [
      { data: null, error: { message: "Fixture: internal error", code: "XX000" } },
      { data: [{ property_id: PROPERTY_1 }], error: null },
    ],
  });
  const res = await createShareLink({ property_ids: [PROPERTY_1, PROPERTY_2] });
  expect(res.path).toMatch(/^\/p\//);
  expect(res.notice).toMatch(/what it shows could not be confirmed/i);
});
