import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorld,
  html,
  loadWorker,
  redirectTo,
  respond,
  type LoadedWorker,
  type World,
} from "@/lib/testing/service-worker-harness";

/**
 * What the service worker STORES and SERVES (T-sw-no-private-cache).
 *
 * Runs the real public/sw.js — not a copy, not its source text — in a simulated
 * worker scope (lib/testing/service-worker-harness.ts), against synthetic
 * responses carrying distinctive markers, and then reads every entry in Cache
 * Storage. The browser half is tests/e2e/pwa-offline-privacy.spec.ts.
 *
 * Every page-level test runs three times: with the headers Next really sends
 * (private, no-store), with cacheable headers, and with none. The worker must
 * keep pages out of Cache Storage because it never stores a page — not because
 * today's server happens to say no-store.
 *
 * `SW_UNDER_TEST=tests/fixtures/sw-legacy-v1.js npx vitest run
 * tests/unit/service-worker.test.ts` points the suite at the frozen v1 worker,
 * which fails it — the check that these assertions can fail for the reason
 * they exist.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const CURRENT = path.resolve(ROOT, process.env.SW_UNDER_TEST ?? "public/sw.js");
const LEGACY = path.resolve(ROOT, "tests/fixtures/sw-legacy-v1.js");

// What Next sends on every dynamic page, /offline included.
const DYNAMIC = { "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate" };
const IMMUTABLE = { "cache-control": "public, max-age=31536000, immutable" };
const PAGE_HEADER_VARIANTS: [string, Record<string, string>][] = [
  ["Next's dynamic headers", DYNAMIC],
  ["cacheable headers", { "cache-control": "public, max-age=60" }],
  ["no cache headers", {}],
];

const GENERIC = "SYNTH-GENERIC-OFFLINE-PAGE";
const CONTACT = "SYNTH-PRIVATE-CONTACT-7f3a";
const SEARCH = "SYNTH-PRIVATE-SEARCH-alice-35799000001";
const PROPOSAL = "SYNTH-PROPOSAL-91c2 buyer=Synthetic Buyer price=EUR 250000";
const NEUTRAL = "This link is no longer available";
const CSV = "id,name,phone\nsyn-1,SYNTH-CSV-PERSON,+35700000000\n";
const RSC = "SYNTH-RSC-PAYLOAD-contact";
const PNG_PAGE = "SYNTH-PRIVATE-PAGE-AT-PNG-PATH";
const TOKEN = "SYNTHrevocableTOKEN0123456789abcdefghijklmn";
const PRIVATE_MARKERS = [CONTACT, SEARCH, PROPOSAL, CSV, RSC, PNG_PAGE, "signed in as"];

/** A synthetic CRM origin: who is signed in and whether the link is live are the test's to change. */
function serveApp(world: World, pageHeaders: Record<string, string> = DYNAMIC) {
  const state = { session: "alice" as string | null, revoked: false, pngVersion: 1 };
  const net = world.network;
  const page = (body: string, status = 200) => html(body, pageHeaders, status);
  const gated = (body: () => string) => () =>
    state.session ? page(`${body()} <header>signed in as ${state.session}</header>`) : redirectTo("/login");

  net.route("/offline", () => page(`<h1>You are offline</h1> ${GENERIC}`));
  net.route("/login", () => page("<h1>Sign in</h1>"));
  net.route("/dashboard", gated(() => "<h1>Today</h1>"));
  net.route("/contacts/c-1", gated(() => `<h1>${CONTACT}</h1>`));
  net.route("/contacts?q=alice", gated(() => SEARCH));
  net.route("/contacts/c-1.png", gated(() => `${PNG_PAGE} v${state.pngVersion}`));
  net.route("/deals/d-1", () => page("<h1>Forbidden</h1>", 403));
  net.route("/keys", () => page("<h1>Unauthorised</h1>", 401));
  net.route("/contacts/c-1?_rsc=1", () =>
    respond(RSC, { headers: { "content-type": "text/x-component", ...pageHeaders } }),
  );
  net.route("/contacts/export?x=1", () =>
    state.session
      ? respond(CSV, {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="contacts.csv"',
            ...pageHeaders,
          },
        })
      : redirectTo("/login"),
  );
  net.route(`/p/${TOKEN}`, () => page(state.revoked ? NEUTRAL : PROPOSAL));
  net.route("/some/private.ico", () =>
    respond("SYNTH-PRIVATE-ICO", { headers: { "content-type": "image/x-icon" } }),
  );
  net.route("/api/public/listings", () =>
    respond('{"listings":[]}', { headers: { "content-type": "application/json" } }),
  );
  net.route("/_next/static/chunks/app-1a2b.js", () =>
    respond("/* build output */", { headers: { "content-type": "text/javascript", ...IMMUTABLE } }),
  );
  net.route("/_next/static/media/inter.woff2", () => redirectTo("/login"));
  net.route("/_next/static/chunks/private.js", () =>
    respond("SYNTH-PRIVATE-JS", { headers: { "cache-control": "private, max-age=60" } }),
  );
  net.route("/_next/static/chunks/no-store.js", () =>
    respond("SYNTH-NOSTORE-JS", { headers: { "cache-control": "no-store" } }),
  );
  return state;
}

async function expectNothingPrivateStored(world: World) {
  const stored = await world.storage.contents();
  for (const entry of stored) {
    for (const marker of PRIVATE_MARKERS) {
      expect(entry.body, `${entry.cache} ${entry.url} holds private content`).not.toContain(marker);
    }
    // Only the approved shapes, whatever their content.
    expect(
      entry.url === "/offline" || entry.url.startsWith("/_next/static/"),
      `${entry.cache} ${entry.url} is outside the allowlist`,
    ).toBe(true);
  }
}

const cacheNames = (world: World) => [...world.storage.caches.keys()];

describe.each(PAGE_HEADER_VARIANTS)("public/sw.js — pages sent with %s", (_, pageHeaders) => {
  let world: World;
  let app: ReturnType<typeof serveApp>;
  let sw: LoadedWorker;

  beforeEach(async () => {
    world = createWorld();
    app = serveApp(world, pageHeaders);
    sw = loadWorker(CURRENT, world);
    await sw.start();
  });
  afterEach(() => sw.dispose());

  it("serves a private page live and stores nothing of it", async () => {
    const served = await sw.navigate("/contacts/c-1");
    expect(served.handledBy).toBe("worker");
    expect(served.body).toContain(CONTACT);
    await expectNothingPrivateStored(world);
  });

  it("offline, a page visited a moment ago is replaced by the generic page", async () => {
    await sw.navigate("/contacts/c-1");
    await sw.navigate("/dashboard");
    world.network.online = false;

    for (const target of ["/contacts/c-1", "/dashboard", "/never-visited"]) {
      const served = await sw.navigate(target);
      expect(served.body, target).toContain(GENERIC);
      expect(served.body, target).not.toContain(CONTACT);
      expect(served.body, target).not.toContain("signed in as");
    }
  });

  it("after the session ends the server's redirect passes through, and offline shows nothing of it", async () => {
    await sw.navigate("/contacts/c-1");
    app.session = null; // expired, signed out elsewhere, or banned

    const online = await sw.navigate("/contacts/c-1");
    expect(online.type).toBe("opaqueredirect"); // the browser follows it to /login
    expect(online.body).toBeNull();

    world.network.online = false;
    const offline = await sw.navigate("/contacts/c-1");
    expect(offline.body).toContain(GENERIC);
    expect(offline.body).not.toContain(CONTACT);
  });

  it("the next account on the device gets nothing of the previous one's, online or off", async () => {
    await sw.navigate("/contacts/c-1"); // alice
    app.session = "bob";
    await sw.navigate("/dashboard");

    world.network.online = false;
    const offline = await sw.navigate("/contacts/c-1");
    expect(offline.body).toContain(GENERIC);
    expect(offline.body).not.toContain("alice");
    await expectNothingPrivateStored(world);
  });

  it("passes 401, 403 and a withdrawn link's neutral page through untouched", async () => {
    expect((await sw.navigate("/deals/d-1")).status).toBe(403);
    expect((await sw.navigate("/keys")).status).toBe(401);

    expect((await sw.navigate(`/p/${TOKEN}`)).body).toContain(PROPOSAL);
    app.revoked = true;
    const revoked = await sw.navigate(`/p/${TOKEN}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toContain(NEUTRAL);
    expect(revoked.body).not.toContain(PROPOSAL);
  });

  it("never stores a proposal: once withdrawn it cannot be replayed offline", async () => {
    await sw.navigate(`/p/${TOKEN}`);
    await sw.navigate(`/p/${TOKEN}`);
    await expectNothingPrivateStored(world);

    app.revoked = true; // withdrawn while the buyer's phone is in a car park
    world.network.online = false;
    const offline = await sw.navigate(`/p/${TOKEN}`);
    expect(offline.body).toContain(GENERIC);
    expect(offline.body).not.toContain(PROPOSAL);
  });

  it("stores no query-string variant of a page", async () => {
    expect((await sw.navigate("/contacts?q=alice")).body).toContain(SEARCH);
    await expectNothingPrivateStored(world);
    world.network.online = false;
    expect((await sw.navigate("/contacts?q=alice")).body).not.toContain(SEARCH);
  });

  it("a file extension qualifies nothing: an image-like page path is fetched live every time", async () => {
    expect((await sw.navigate("/contacts/c-1.png")).body).toContain(`${PNG_PAGE} v1`);
    app.pngVersion = 2;
    expect((await sw.navigate("/contacts/c-1.png")).body).toContain(`${PNG_PAGE} v2`);

    const icon = await sw.request("/some/private.ico", { mode: "no-cors", destination: "image" });
    expect(icon.handledBy).toBe("browser");
    await expectNothingPrivateStored(world);
  });

  it("a download reached by navigation (a plain link to an export) is not stored, and offline is not replayed", async () => {
    const download = await sw.navigate("/contacts/export?x=1");
    expect(download.body).toBe(CSV);
    await expectNothingPrivateStored(world);

    world.network.online = false;
    const offline = await sw.navigate("/contacts/export?x=1");
    expect(offline.body).toContain(GENERIC);
    expect(offline.body).not.toContain("SYNTH-CSV-PERSON");
  });

  it("does not intercept RSC or API requests: offline they fail as network errors, never as offline HTML", async () => {
    const rsc = await sw.request("/contacts/c-1?_rsc=1", { headers: { RSC: "1" } });
    expect(rsc.handledBy).toBe("browser");
    expect(rsc.body).toBe(RSC);
    const api = await sw.request("/api/public/listings");
    expect(api.handledBy).toBe("browser");
    expect((await sw.navigate("/api/public/listings")).handledBy).toBe("browser");
    await expectNothingPrivateStored(world);

    world.network.online = false;
    for (const served of [
      await sw.request("/contacts/c-1?_rsc=1", { headers: { RSC: "1" } }),
      await sw.request("/api/public/listings"),
    ]) {
      expect(served.handledBy).toBe("browser");
      expect(served.body).toBeNull();
      expect(served.error).toMatch(/Failed to fetch/);
    }
  });

  it("does not intercept writes — not even a form posted as a page load", async () => {
    const posts = () => [
      sw.request("/contacts/c-1", { method: "POST" }),
      // A server-action form submitted before hydration is a POST navigation.
      sw.request("/contacts/c-1", { method: "POST", mode: "navigate", destination: "document" }),
      sw.request("/_next/static/chunks/app-1a2b.js", { method: "POST" }),
    ];
    for (const served of await Promise.all(posts())) expect(served.handledBy).toBe("browser");

    world.network.online = false;
    for (const served of await Promise.all(posts())) {
      expect(served.handledBy).toBe("browser");
      expect(served.body).toBeNull();
      expect(served.error).toMatch(/Failed to fetch/);
    }
  });

  it("stores a public build asset and serves it from cache — the positive control", async () => {
    const first = await sw.request("/_next/static/chunks/app-1a2b.js", { destination: "script" });
    expect(first.body).toBe("/* build output */");
    // Written within the request's lifetime (waitUntil), not left to chance.
    expect(first.storedAtLifetimeEnd).toContain("gnk-static-v2 /_next/static/chunks/app-1a2b.js");

    const fetchesBefore = world.network.log.length;
    world.network.online = false;
    const second = await sw.request("/_next/static/chunks/app-1a2b.js", { destination: "script" });
    expect(second.body).toBe("/* build output */");
    expect(world.network.log.length - fetchesBefore).toBe(0);
  });

  it("never stores a build-asset request whose answer was redirected, private, no-store or an error", async () => {
    const font = await sw.request("/_next/static/media/inter.woff2", { destination: "font" });
    expect(font.body).toContain("Sign in"); // what the browser got — but not kept under the font's name
    // Redirected without leaving the prefix: still not the response that was asked for.
    world.network.route("/_next/static/chunks/moved.js", () => redirectTo("/_next/static/chunks/app-1a2b.js"));
    expect((await sw.request("/_next/static/chunks/moved.js")).body).toBe("/* build output */");
    await sw.request("/_next/static/chunks/private.js", { destination: "script" });
    await sw.request("/_next/static/chunks/no-store.js", { destination: "script" });
    expect((await sw.request("/_next/static/chunks/gone.js")).status).toBe(404);

    const stored = (await world.storage.contents()).map((entry) => entry.url);
    expect(stored).toEqual(["/offline"]);
  });

  it("reads build assets from its own cache only, never from another cache on the origin", async () => {
    // A v1 write landing after activation, and a cache that is not this app's.
    world.storage.seed("gnk-static-v1", "/_next/static/media/inter.woff2", "SYNTH-V1-LOGIN-PAGE-AS-FONT");
    world.storage.seed("third-party", "/_next/static/chunks/evil.js", "SYNTH-FOREIGN-ASSET");
    for (const asset of ["/_next/static/media/inter.woff2", "/_next/static/chunks/evil.js"]) {
      const served = await sw.request(asset);
      expect(served.body ?? "", asset).not.toMatch(/SYNTH-(V1|FOREIGN)/);
    }
  });

  it("offline, an uncached build asset fails as a network error — never the offline page", async () => {
    world.network.online = false;
    const served = await sw.request("/_next/static/chunks/uncached-9z.js", { destination: "script" });
    expect(served.handledBy).toBe("worker");
    expect(served.status).toBeNull();
    expect(served.body).toBeNull();
    expect(served.error).toMatch(/Failed to fetch/);
  });

  it("stores the offline page anonymously, and only the page itself", async () => {
    const precache = world.network.log.filter((entry) => entry.url.endsWith("/offline"));
    expect(precache.length).toBeGreaterThan(0);
    for (const entry of precache) {
      expect(entry.credentials).toBe("omit");
      expect(entry.redirect).toBe("error");
    }
    const stored = await world.storage.contents();
    expect(stored).toEqual([expect.objectContaining({ cache: "gnk-shell-v2", url: "/offline" })]);
    expect(stored[0].body).toContain(GENERIC);
  });

  it.each([
    ["the gate redirected it", () => redirectTo("/login")],
    ["the server failed", () => html("<h1>Internal error</h1>", DYNAMIC, 500)],
  ])("refuses to store an offline page when %s, and the install still succeeds", async (_, answer) => {
    const broken = createWorld();
    serveApp(broken, pageHeaders);
    broken.network.route("/offline", answer);
    const worker = loadWorker(CURRENT, broken);
    try {
      await worker.start(); // throws if install's lifetime rejected
      expect(await broken.storage.contents()).toEqual([]);

      broken.network.online = false;
      const offline = await worker.navigate("/contacts/c-1");
      expect(offline.status).toBe(503);
      expect(offline.body).toBe("Offline");
    } finally {
      worker.dispose();
    }
  });

  it("serves the fallback only from its own cache, never from another one on the origin", async () => {
    const seeded = createWorld();
    serveApp(seeded, pageHeaders);
    // Created before the worker's own caches, so an unscoped caches.match() would find it first.
    seeded.storage.seed("third-party", "/contacts/c-1", "SYNTH-FOREIGN-COPY");
    seeded.storage.seed("third-party", "/offline", "SYNTH-FOREIGN-OFFLINE");
    const worker = loadWorker(CURRENT, seeded);
    try {
      await worker.start();
      seeded.network.online = false;
      const offline = await worker.navigate("/contacts/c-1");
      expect(offline.body).toContain(GENERIC);
      expect(offline.body).not.toContain("SYNTH-FOREIGN");
      // Not this app's cache, so not this app's to delete.
      expect(cacheNames(seeded)).toContain("third-party");
    } finally {
      worker.dispose();
    }
  });

  it("the sign-out purge clears build assets but keeps the offline page — no page load needed to get it back", async () => {
    await sw.request("/_next/static/chunks/app-1a2b.js");
    await sw.message({ type: "PURGE" });
    expect(cacheNames(world)).toEqual(["gnk-shell-v2"]);
    expect((await world.storage.contents()).map((entry) => entry.url)).toEqual(["/offline"]);

    // Sign-out and the next sign-in are client-side navigations: no page load in between.
    world.network.online = false;
    expect((await sw.navigate("/contacts/c-1")).body).toContain(GENERIC);
  });

  it("a removed offline page is stored again, anonymously, by the next page load", async () => {
    await world.storage.delete("gnk-shell-v2"); // storage pressure, a v1 purge, anything
    await sw.navigate("/login");
    expect(await world.storage.contents()).toEqual([
      expect.objectContaining({ cache: "gnk-shell-v2", url: "/offline" }),
    ]);
    const refetch = world.network.log.filter((entry) => entry.url.endsWith("/offline")).at(-1);
    expect(refetch).toMatchObject({ credentials: "omit", redirect: "error" });
  });

  it("a newer version's caches survive this version's page loads", async () => {
    // A successor installing alongside: until it activates, this version still serves.
    world.storage.seed("gnk-shell-v3", "/offline", "the next version's offline page");
    await sw.navigate("/dashboard");
    expect(cacheNames(world)).toContain("gnk-shell-v3");
  });

  it("a failing cache write costs the cache, never the response", async () => {
    world.storage.failPuts = true;
    const served = await sw.request("/_next/static/chunks/app-1a2b.js");
    expect(served.body).toBe("/* build output */");
    expect(sw.unhandled).toEqual([]);
  });
});

describe("upgrading a device from the v1 worker", () => {
  let world: World;
  let app: ReturnType<typeof serveApp>;
  let legacy: LoadedWorker;
  let current: LoadedWorker;

  beforeEach(async () => {
    world = createWorld();
    app = serveApp(world);
    legacy = loadWorker(LEGACY, world);
    await legacy.start();
    // Seeded AFTER v1 activated: v1's own activation deletes every cache whose
    // name does not end in "v1", other apps' included.
    world.storage.seed("third-party", "/elsewhere", "not this app's");

    // What a v1 device accumulates in ordinary use.
    await legacy.navigate("/contacts/c-1");
    await legacy.navigate("/contacts?q=alice");
    await legacy.navigate(`/p/${TOKEN}`);
    await legacy.navigate("/contacts/export?x=1");
    await legacy.navigate("/contacts/c-1.png");
    await legacy.request("/_next/static/media/inter.woff2", { destination: "font" });
  });
  afterEach(() => {
    legacy.dispose();
    current?.dispose();
  });

  it("positive control: the v1 worker stores private pages and replays them offline after sign-out", async () => {
    const stored = await world.storage.contents();
    expect(stored).toContainEqual(expect.objectContaining({ cache: "gnk-pages-v1", url: "/contacts/c-1" }));
    expect(stored.some((entry) => entry.body.includes(PROPOSAL))).toBe(true);
    expect(stored.some((entry) => entry.body.includes("SYNTH-CSV-PERSON"))).toBe(true);
    // Stored under a font's name: the login page the redirect landed on.
    expect(stored).toContainEqual(
      expect.objectContaining({ cache: "gnk-static-v1", url: "/_next/static/media/inter.woff2" }),
    );

    app.session = null;
    app.revoked = true;
    world.network.online = false;
    expect((await legacy.navigate("/contacts/c-1")).body).toContain(CONTACT);
    expect((await legacy.navigate(`/p/${TOKEN}`)).body).toContain(PROPOSAL);
  });

  it("activation itself deletes every v1 cache — awaited, before the new worker serves anything — and leaves other caches alone", async () => {
    current = loadWorker(CURRENT, world);
    await current.install();
    const { cachesAtLifetimeEnd } = await current.activate();

    // Read at the end of activate's lifetime: what was awaited, not what drained later.
    expect([...cachesAtLifetimeEnd].sort()).toEqual(["gnk-shell-v2", "third-party"]);
    const ours = (await world.storage.contents()).filter((entry) => entry.cache !== "third-party");
    for (const entry of ours) {
      for (const marker of PRIVATE_MARKERS) expect(entry.body, entry.url).not.toContain(marker);
    }

    app.session = null;
    app.revoked = true;
    world.network.online = false;
    for (const target of ["/contacts/c-1", "/contacts?q=alice", `/p/${TOKEN}`, "/contacts/export?x=1", "/contacts/c-1.png"]) {
      const served = await current.navigate(target);
      expect(served.body, target).toContain(GENERIC);
      for (const marker of PRIVATE_MARKERS) expect(served.body, target).not.toContain(marker);
    }
  });

  it("a v1 write that lands after activation is never served, and the next page load deletes it", async () => {
    current = loadWorker(CURRENT, world);
    await current.start();
    // An old worker's request still in flight when the new one took over.
    world.storage.seed("gnk-pages-v1", "/contacts/c-1", `<h1>${CONTACT}</h1>`);

    world.network.online = false;
    const offline = await current.navigate("/contacts/c-1");
    expect(offline.body).toContain(GENERIC);
    expect(offline.body).not.toContain(CONTACT);
    expect(offline.cachesAtLifetimeEnd).not.toContain("gnk-pages-v1"); // awaited within the page load
  });
});
