import { readFileSync } from "node:fs";
import vm from "node:vm";

/**
 * Runs an UNMODIFIED service-worker source file (public/sw.js, or the frozen v1
 * worker in tests/fixtures) inside node:vm, with a fake worker scope, an
 * in-memory Cache Storage and a network the test controls — so a unit test can
 * ask what the worker STORES and what it SERVES, rather than what its source
 * text contains (T-sw-no-private-cache: pwa.spec.ts once "proved" the sign-out
 * purge by finding the word PURGE in a comment).
 *
 * SIMULATION, NOT A BROWSER. What it models: Cache Storage keeps caches in
 * creation order and `caches.match()` without `cacheName` searches all of
 * them; `caches.open()` creates; a deleted cache's handle becomes an orphan
 * whose writes nobody sees; `Cache.put` refuses non-GET and 206. Navigations
 * fetch with `redirect: "manual"` (a 3xx comes back as an `opaqueredirect`,
 * status 0); subresources follow redirects and come back `redirected` with the
 * final url; `redirect: "error"` rejects. A fetch event's `respondWith` must be
 * called synchronously, otherwise the "browser" fetches the request itself.
 * What it does not model: Vary, HTTP caching, worker termination, timing.
 * `tests/e2e/pwa-offline-privacy.spec.ts` runs the same worker in Chromium.
 *
 * Several workers can share one {@link World} — that is how an upgrade from
 * the v1 worker is replayed against the Cache Storage it left behind.
 */

export const ORIGIN = "https://crm.test";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
/**
 * Writes and deletes take real time, as on disk. Without it a fire-and-forget
 * write finishes inside the same tick as the event, and a test cannot tell it
 * from one the worker awaited — the difference the lifetime snapshots exist for.
 */
const io = () => new Promise<void>((resolve) => setTimeout(resolve, 3));

type ResponseMeta = { url?: string; redirected?: boolean; type?: ResponseType };

/** Response fields a real Response will not let a constructor set; clone() keeps them. */
function withMeta(response: Response, meta: ResponseMeta): Response {
  const merged: ResponseMeta = { ...((response as { __meta?: ResponseMeta }).__meta ?? {}) };
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  for (const [key, value] of Object.entries(merged)) {
    Object.defineProperty(response, key, { value, configurable: true });
  }
  Object.defineProperty(response, "__meta", { value: merged, configurable: true });
  Object.defineProperty(response, "clone", {
    configurable: true,
    value(this: Response) {
      return withMeta(Response.prototype.clone.call(this), merged);
    },
  });
  return response;
}

export function respond(
  body: string,
  { status = 200, headers = {} }: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return withMeta(new Response(body, { status, headers }), { type: "basic" });
}

export const html = (body: string, headers: Record<string, string> = {}, status = 200) =>
  respond(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

export interface Redirect {
  redirectTo: string;
  status: number;
}
export const redirectTo = (location: string, status = 307): Redirect => ({
  redirectTo: location,
  status,
});

type RouteResult = Response | Redirect;
type Route = (request: Request) => RouteResult | Promise<RouteResult>;

export interface NetworkLogEntry {
  url: string;
  mode: string;
  credentials: string;
  redirect: string;
  online: boolean;
  outcome: string;
}

/** A Request whose mode/destination a test may set ("navigate" is refused by the constructor). */
export function makeRequest(
  path: string,
  {
    mode = "cors",
    method = "GET",
    headers = {},
    destination = "",
  }: { mode?: string; method?: string; headers?: Record<string, string>; destination?: string } = {},
): Request {
  const request = new Request(new URL(path, ORIGIN).href, {
    method,
    headers,
    body: method === "GET" ? undefined : "",
  });
  const redirect = mode === "navigate" ? "manual" : "follow";
  for (const [key, value] of Object.entries({ mode, destination, redirect })) {
    Object.defineProperty(request, key, { value, configurable: true });
  }
  return request;
}

export class FakeNetwork {
  online = true;
  readonly log: NetworkLogEntry[] = [];
  private readonly routes = new Map<string, Route>();

  /** Answer `path` (query included) with `route`; anything unrouted is a 404 page. */
  route(path: string, route: Route): void {
    this.routes.set(new URL(path, ORIGIN).href, route);
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request =
      input instanceof Request ? input : new Request(new URL(String(input), ORIGIN).href, init);
    const entry: NetworkLogEntry = {
      url: request.url,
      mode: request.mode,
      credentials: request.credentials,
      redirect: request.redirect,
      online: this.online,
      outcome: "",
    };
    this.log.push(entry);
    await tick();
    if (!this.online) {
      entry.outcome = "network error (offline)";
      throw new TypeError("Failed to fetch");
    }
    let current = request.url;
    let redirected = false;
    for (let hops = 0; ; hops++) {
      const route = this.routes.get(current);
      const result: RouteResult = route
        ? await route(request)
        : html(`synthetic 404 for ${current}`, {}, 404);
      if (!("redirectTo" in result)) {
        entry.outcome = `${result.status}${redirected ? ` after redirect to ${current}` : ""}`;
        return withMeta(result, { url: current, redirected: redirected || undefined });
      }
      const target = new URL(result.redirectTo, current).href;
      if (request.redirect === "manual") {
        entry.outcome = `opaqueredirect to ${target}`;
        return withMeta(Response.error(), { type: "opaqueredirect", url: request.url });
      }
      if (request.redirect === "error" || hops > 20) {
        entry.outcome = "network error (redirect refused)";
        throw new TypeError("Failed to fetch: redirect");
      }
      redirected = true;
      current = target;
    }
  }
}

interface StoredEntry {
  url: string;
  status: number;
  headers: [string, string][];
  type: ResponseType;
  responseUrl: string;
  redirected: boolean;
  body: Uint8Array<ArrayBuffer>;
}

function keyOf(input: RequestInfo | URL, ignoreSearch = false): string {
  const href = input instanceof Request ? input.url : new URL(String(input), ORIGIN).href;
  const url = new URL(href);
  url.hash = "";
  if (ignoreSearch) url.search = "";
  return url.href;
}

export class FakeCache {
  readonly entries: StoredEntry[] = [];
  orphan = false;

  constructor(
    readonly name: string,
    private readonly storage: FakeCacheStorage,
  ) {}

  private find(input: RequestInfo | URL, options: CacheQueryOptions = {}) {
    const want = keyOf(input, options.ignoreSearch);
    return this.entries.find((entry) => keyOf(entry.url, options.ignoreSearch) === want);
  }

  match(input: RequestInfo | URL, options?: CacheQueryOptions): Promise<Response | undefined> {
    return this.storage.track(async () => {
      await tick();
      const entry = this.find(input, options);
      if (!entry) return undefined;
      return withMeta(
        new Response(entry.body.byteLength ? entry.body : null, {
          status: entry.status,
          headers: entry.headers,
        }),
        { url: entry.responseUrl, redirected: entry.redirected || undefined, type: entry.type },
      );
    });
  }

  keys(): Promise<Request[]> {
    return this.storage.track(async () => {
      await tick();
      return this.entries.map((entry) => new Request(entry.url));
    });
  }

  put(input: RequestInfo | URL, response: Response): Promise<void> {
    return this.storage.track(async () => {
      const method = input instanceof Request ? input.method : "GET";
      if (method !== "GET") throw new TypeError("Cache.put: only GET can be stored");
      if (response.status === 206) throw new TypeError("Cache.put: partial response");
      const body = new Uint8Array(await response.arrayBuffer());
      await io();
      if (this.storage.failPuts) throw new DOMException("synthetic quota", "QuotaExceededError");
      const url = keyOf(input);
      const at = this.entries.findIndex((entry) => entry.url === url);
      if (at >= 0) this.entries.splice(at, 1);
      this.entries.push({
        url,
        status: response.status,
        headers: [...response.headers.entries()],
        type: response.type,
        responseUrl: response.url,
        redirected: response.redirected,
        body,
      });
    });
  }

  /** Fetch with the browser defaults (credentials same-origin, redirects followed), store if ok. */
  add(input: RequestInfo | URL): Promise<void> {
    return this.storage.track(async () => {
      const request = input instanceof Request ? input : new Request(keyOf(input));
      const response = await this.storage.network.fetch(request);
      if (!response.ok) throw new TypeError(`Cache.add: ${response.status} for ${request.url}`);
      await this.put(request, response);
    });
  }

  delete(input: RequestInfo | URL): Promise<boolean> {
    return this.storage.track(async () => {
      await tick();
      const at = this.entries.findIndex((entry) => entry.url === keyOf(input));
      if (at < 0) return false;
      this.entries.splice(at, 1);
      return true;
    });
  }
}

export class FakeCacheStorage {
  /** Insertion-ordered, like the browser's name-to-cache map. */
  readonly caches = new Map<string, FakeCache>();
  failPuts = false;
  private readonly pending = new Set<Promise<unknown>>();

  /** `Cache.add` fetches through the same network as the worker. */
  constructor(readonly network: FakeNetwork) {}

  /** Every operation is tracked so {@link settle} can wait out fire-and-forget writes. */
  track<T>(operation: () => Promise<T>): Promise<T> {
    const promise = operation();
    this.pending.add(promise);
    const done = () => this.pending.delete(promise);
    promise.then(done, done);
    return promise;
  }

  open(name: string): Promise<FakeCache> {
    return this.track(async () => {
      await tick();
      if (!this.caches.has(name)) this.caches.set(name, new FakeCache(name, this));
      return this.caches.get(name)!;
    });
  }

  has(name: string): Promise<boolean> {
    return this.track(async () => (await tick(), this.caches.has(name)));
  }

  keys(): Promise<string[]> {
    return this.track(async () => (await tick(), [...this.caches.keys()]));
  }

  delete(name: string): Promise<boolean> {
    return this.track(async () => {
      await io();
      const cache = this.caches.get(name);
      if (!cache) return false;
      cache.orphan = true;
      this.caches.delete(name);
      return true;
    });
  }

  match(
    input: RequestInfo | URL,
    options: MultiCacheQueryOptions = {},
  ): Promise<Response | undefined> {
    return this.track(async () => {
      await tick();
      if (options.cacheName) return this.caches.get(options.cacheName)?.match(input, options);
      for (const cache of this.caches.values()) {
        const hit = await cache.match(input, options);
        if (hit) return hit;
      }
      return undefined;
    });
  }

  /** Wait until no cache operation — including ones started from detached `.then`s — is running. */
  async settle(): Promise<void> {
    for (let quiet = 0; quiet < 3; ) {
      if (this.pending.size) {
        quiet = 0;
        await Promise.allSettled([...this.pending]);
      } else {
        quiet++;
      }
      await tick();
    }
  }

  /** Cache names and entries right now — without waiting for pending operations. */
  snapshot(): { cachesAtLifetimeEnd: string[]; storedAtLifetimeEnd: string[] } {
    return {
      cachesAtLifetimeEnd: [...this.caches.keys()],
      storedAtLifetimeEnd: [...this.caches.values()].flatMap((cache) =>
        cache.entries.map((entry) => `${cache.name} ${entry.url.replace(ORIGIN, "")}`),
      ),
    };
  }

  /** Put an entry straight into Cache Storage: state a device already holds. */
  seed(name: string, path: string, body: string, headers: Record<string, string> = {}): void {
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache(name, this));
    const url = new URL(path, ORIGIN).href;
    this.caches.get(name)!.entries.push({
      url,
      status: 200,
      headers: Object.entries({ "content-type": "text/html", ...headers }),
      type: "basic",
      responseUrl: url,
      redirected: false,
      body: new TextEncoder().encode(body),
    });
  }

  /** Every stored entry with its body as text — what a thief reading the device would find. */
  async contents(): Promise<{ cache: string; url: string; body: string }[]> {
    await this.settle();
    return [...this.caches.values()].flatMap((cache) =>
      cache.entries.map((entry) => ({
        cache: cache.name,
        url: entry.url.replace(ORIGIN, ""),
        body: new TextDecoder().decode(entry.body),
      })),
    );
  }
}

/** The network and Cache Storage of one origin on one device. */
export interface World {
  network: FakeNetwork;
  storage: FakeCacheStorage;
}

export function createWorld(): World {
  const network = new FakeNetwork();
  return { network, storage: new FakeCacheStorage(network) };
}

export interface Served {
  /** "worker" when the worker called respondWith; "browser" when it let the request through. */
  handledBy: "worker" | "browser";
  /** null when the page would see a network error. */
  status: number | null;
  type: ResponseType | null;
  body: string | null;
  error: string | null;
  /**
   * Cache names when the event's lifetime (respondWith + waitUntil) settled,
   * BEFORE fire-and-forget work drains — what the worker actually awaited.
   */
  cachesAtLifetimeEnd: string[];
  /** Entries ("<cache> <path>") at the same moment. */
  storedAtLifetimeEnd: string[];
}

/** What an install/activate/message event awaited; see {@link Served.cachesAtLifetimeEnd}. */
export interface Dispatched {
  cachesAtLifetimeEnd: string[];
  storedAtLifetimeEnd: string[];
}

interface ExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}

type Listener = (event: unknown) => void;

/** Load a worker script into `world` and return handles to drive its events. */
export function loadWorker(workerPath: string, world: World) {
  const listeners = new Map<string, Listener[]>();
  const unhandled: string[] = [];

  /** Relative URLs resolve against the worker's location, as in a browser. */
  class WorkerRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, ORIGIN).href : input, init);
    }
  }

  const scope: Record<string, unknown> = {
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    URL,
    Request: WorkerRequest,
    Response,
    Headers,
    Promise,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    caches: world.storage,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => world.network.fetch(input, init),
    location: new URL("/sw.js", ORIGIN),
    clients: { claim: async () => undefined, matchAll: async () => [] },
    skipWaiting: async () => undefined,
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  scope.self = scope;
  vm.createContext(scope);
  vm.runInContext(readFileSync(workerPath, "utf8"), scope, { filename: workerPath });

  const onUnhandled = (reason: unknown) => unhandled.push(String(reason));
  process.on("unhandledRejection", onUnhandled);

  /** Wait for every lifetime promise, including ones added while waiting. */
  async function lifetime(extend: Promise<unknown>[]) {
    for (let seen = -1; seen !== extend.length; ) {
      seen = extend.length;
      await Promise.allSettled(extend);
      await tick();
    }
  }

  async function dispatchExtendable(type: string, extra: Record<string, unknown> = {}) {
    const extend: Promise<unknown>[] = [];
    const event: ExtendableEvent & Record<string, unknown> = {
      ...extra,
      waitUntil: (promise: Promise<unknown>) => void extend.push(Promise.resolve(promise)),
    };
    for (const listener of listeners.get(type) ?? []) listener(event);
    await lifetime(extend);
    const atLifetimeEnd = world.storage.snapshot();
    await world.storage.settle();
    const failed = (await Promise.allSettled(extend)).filter((r) => r.status === "rejected");
    if (failed.length) throw new Error(`${type} lifetime rejected: ${String(failed[0])}`);
    return atLifetimeEnd;
  }

  async function dispatchFetch(request: Request): Promise<Served> {
    const extend: Promise<unknown>[] = [];
    let responded: Promise<Response> | null = null;
    let dispatching = true;
    const event = {
      request,
      waitUntil: (promise: Promise<unknown>) => void extend.push(Promise.resolve(promise)),
      respondWith(promise: Promise<Response> | Response) {
        if (!dispatching) throw new Error("respondWith called after dispatch");
        responded = Promise.resolve(promise);
        extend.push(responded);
      },
    };
    for (const listener of listeners.get("fetch") ?? []) listener(event);
    dispatching = false;

    const handledBy = responded ? "worker" : "browser";
    let response: Response | null = null;
    let error: string | null = null;
    try {
      response = responded ? await responded : await world.network.fetch(request);
    } catch (err) {
      error = String(err);
    }
    await lifetime(extend);
    const atLifetimeEnd = world.storage.snapshot();
    await world.storage.settle();
    return {
      ...atLifetimeEnd,
      handledBy,
      status: response ? response.status : null,
      type: response ? response.type : null,
      body: response && response.type !== "opaqueredirect" ? await response.text() : null,
      error,
    };
  }

  return {
    /** Install then activate, as a browser does for a worker with skipWaiting(). */
    async start(): Promise<Dispatched> {
      await dispatchExtendable("install");
      return dispatchExtendable("activate");
    },
    install: () => dispatchExtendable("install"),
    activate: () => dispatchExtendable("activate"),
    message: (data: unknown) => dispatchExtendable("message", { data }),
    /** A top-level page load (typed URL, reload, new tab, a link without `download`). */
    navigate: (path: string) => dispatchFetch(makeRequest(path, { mode: "navigate", destination: "document" })),
    /** A subresource or fetch() request. */
    request: (path: string, options: Parameters<typeof makeRequest>[1] = {}) =>
      dispatchFetch(makeRequest(path, options)),
    unhandled,
    dispose: () => process.off("unhandledRejection", onUnhandled),
  };
}

export type LoadedWorker = ReturnType<typeof loadWorker>;
