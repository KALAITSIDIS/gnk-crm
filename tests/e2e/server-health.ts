import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Is the server answering the base URL actually serving the build on disk?
 *
 * WHY THIS EXISTS. On 2026-08-11 `tests/e2e/mfa.spec.ts:58` was reported as a
 * broken 2FA enrolment flow. Enrolment was fine. `:3000` was held by a
 * `next start` left running from a production check the previous evening.
 * `next start` caches its build manifests at boot; the next morning's
 * `npm run build` replaced `.next` and rewrote the content-hashed chunk
 * filenames, so the old process went on emitting HTML that referenced chunks no
 * longer on disk. **6 of 22 answered `500` with `content-type: text/plain`,
 * including the Turbopack runtime.** Every page server-rendered perfectly and
 * NOTHING hydrated: clicks reached no handler, `enrollment` stayed `null`, the
 * QR dialog never appeared, and no application error existed anywhere to explain
 * it. It was A/B bisected across two branches and wrongly blamed on migration
 * `0029` before anyone asked what was on the port. Full mechanism in
 * `docs/DECISIONS.md` `T-e2e-cold-server`; operational version in HANDOFF §7
 * under **Machine**.
 *
 * `playwright.config.ts` sets `reuseExistingServer: true` and Playwright only
 * checks that *something* answers the base URL, so the suite adopted that server
 * and `npm run dev` never started. **The option is correct and must stay** —
 * `.github/workflows/ci.yml` starts `npx next start -p 3000` itself and depends
 * on Playwright reusing it. So this checks WHAT is being reused, not whether
 * reuse is allowed.
 *
 * WHAT IT CHECKS. Fetch one public page, take the `<script src>` values that
 * page asks for itself, and request every one. A server serving its own build
 * answers all of them with a JavaScript content-type. A server whose build moved
 * underneath it cannot: the filenames it is emitting are not on disk. Measured
 * against both, same machine, 2026-08-11:
 *
 *   healthy `next start` :3000    16 of 16  → 200 application/javascript
 *   healthy `next dev`   :3400    28 of 28  → 200 application/javascript
 *   stale   `next start` :3401     2 of 16  → 500 text/plain
 *                                            (one of the two was the Turbopack
 *                                             runtime, so nothing hydrates)
 *
 * Deliberately NOT a hydration check in a browser. This runs before login on
 * every local invocation, costs one page fetch plus N parallel static GETs
 * (~0.4s warm), and needs no session — a browser-side check would cost a context
 * and could only run after the thing it is protecting.
 */

/** Accepted for a JavaScript chunk. `text/plain` is the stale-server tell. */
const JS_CONTENT_TYPE = /\b(?:application|text)\/(?:javascript|ecmascript)\b/i;

/**
 * `/login` is the probe page: public, so this runs before `login()` and can
 * report a stale server instead of letting it surface as a login failure. It is
 * also the readiness endpoint `ci.yml` already polls, and one of the five routes
 * confirmed 500ing chunks in the incident.
 */
const PROBE_PATH = "/login";

export interface ChunkProbe {
  src: string;
  status: number;
  contentType: string;
  /** Set when the request never produced a response at all. */
  error?: string;
}

/**
 * The `src` of every `<script>` the page asks for, in document order.
 *
 * Attribute-order tolerant and quote-style tolerant, because Next emits `nonce`
 * and `crossorigin` before `src` on some tags. Values are left PERCENT-ENCODED
 * as served: `next dev` chunk names contain encoded characters
 * (`node_modules_%40sentry_…`, `%5Bturbopack%5D_…`) and re-encoding them turns a
 * working URL into a 404, which would make this guard cry wolf on a healthy dev
 * server. Only `&amp;` is decoded — HTML-escaped, not URL-escaped.
 */
export function extractScriptSrcs(html: string): string[] {
  const srcs: string[] = [];
  const re = /<script\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    srcs.push(match[1].replace(/&amp;/g, "&"));
  }
  return srcs;
}

/** `.next/BUILD_ID`, or null when there is no production build on disk. */
export function readBuildId(root = process.cwd()): string | null {
  try {
    const id = readFileSync(path.join(root, ".next", "BUILD_ID"), "utf8").trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * The failure text, assembled separately so it can be asserted by a unit test
 * (`tests/unit/e2e-server-health.test.ts`) without standing up a stale server.
 *
 * THE MESSAGE IS THE DELIVERABLE. Whoever hits this must not have to re-diagnose
 * it — the original cost an A/B bisect across two branches and a wrongly accused
 * migration. So it states the mechanism, names the likely process, gives the
 * commands to confirm and clear it, and closes the one wrong turn available
 * (deleting `reuseExistingServer`, which would break CI).
 */
export function staleServerReport(args: {
  baseURL: string;
  probePath: string;
  total: number;
  bad: ChunkProbe[];
  buildId: string | null;
  buildIdInHtml: boolean;
}): string {
  const { baseURL, probePath, total, bad, buildId, buildIdInHtml } = args;
  const port = (() => {
    try {
      const u = new URL(baseURL);
      return u.port || (u.protocol === "https:" ? "443" : "80");
    } catch {
      return "3000";
    }
  })();

  const lines: string[] = [];

  lines.push(
    `E2E ABORTED — the server on ${baseURL} is serving a build that is no longer on disk.`,
    "",
    `Nothing on any page will hydrate. Every click this suite makes would reach no`,
    `handler, and every page would still server-render perfectly, so the failures`,
    `would look like component bugs, a bad migration, or flakiness. They would be`,
    `none of those. Aborting here instead of reporting ~177 misleading results.`,
    "",
    `EVIDENCE — of the ${total} <script src> chunks ${probePath} asks for itself,`,
    `${bad.length} did not come back as JavaScript:`,
  );

  for (const probe of bad) {
    const what = probe.error
      ? `request failed: ${probe.error}`
      : `${probe.status} ${probe.contentType || "(no content-type)"}`;
    lines.push(`  ${what}  ${probe.src}`);
  }

  if (bad.some((p) => /turbopack/i.test(p.src))) {
    lines.push(
      "",
      `  The TURBOPACK RUNTIME is among them. That is the loader every other chunk`,
      `  waits for, which is why the symptom is total: not one handler is attached.`,
    );
  }

  /**
   * BUILD_ID is a DETAIL LINE, never a criterion — see the caveat it prints.
   * `T-e2e-cold-server` §1 offered "no path matching `.next/BUILD_ID` in the
   * served HTML" as confirmation, which held that day because the server was
   * `next start`. It does not generalise: `next dev` writes no BUILD_ID (dev
   * output lives in `.next/dev`), so a HEALTHY dev server has 0 occurrences too
   * — measured 2026-08-11 on :3400. Gating on it would fail every local run.
   */
  lines.push("");
  if (!buildId) {
    lines.push(`  No .next/BUILD_ID on disk, so there is no build to compare against.`);
  } else if (buildIdInHtml) {
    lines.push(
      `  .next/BUILD_ID on disk is "${buildId}" and the served HTML DOES mention it, so`,
      `  the drift is narrower than a whole build — rebuilding unchanged sources moves`,
      `  only the non-deterministic chunks (measured: 2 of 61). One of them being the`,
      `  runtime is enough, so do not read "only a few moved" as "mostly fine".`,
    );
  } else {
    lines.push(
      `  .next/BUILD_ID on disk is "${buildId}" and the served HTML never mentions it,`,
      `  which is the second tell from the incident. (Absence alone proves nothing: a`,
      `  healthy \`next dev\` server never mentions it either — dev writes no BUILD_ID.`,
      `  The chunk statuses above are the real finding.)`,
    );
  }

  lines.push(
    "",
    `WHAT THIS IS, almost always: a \`next start\` left over from a production check`,
    `is still holding the port. \`next start\` caches its build manifests at boot; a`,
    `later \`npm run build\` replaces \`.next\` and rewrites the content-hashed chunk`,
    `filenames, so the running process keeps emitting HTML pointing at files nobody`,
    `has any more. Same shape if anything else replaced the build underneath a live`,
    `server. Cost an A/B bisect across two branches on 2026-08-11 and wrongly`,
    `implicated migration 0029 — docs/DECISIONS.md \`T-e2e-cold-server\`, HANDOFF §7`,
    `under "Machine".`,
    "",
    `FIX — confirm what is on the port, then replace it:`,
    "",
    `  # Windows`,
    `  Get-NetTCPConnection -State Listen -LocalPort ${port} |`,
    `    ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" } |`,
    `    Select-Object ProcessId, CommandLine`,
    `  Stop-Process -Id <pid> -Force`,
    "",
    `  # Linux / CI`,
    `  lsof -i :${port} -sTCP:LISTEN -t | xargs -r ps -o pid=,args= -p`,
    `  kill <pid>`,
    "",
    `A command line reading \`next start\` is the culprit. Kill it and run`,
    `\`npm run dev\` — or just rerun the suite and let Playwright start it. If the`,
    `command line reads \`next dev\`, it is a half-orphaned dev server instead (also`,
    `documented in HANDOFF §7); same fix.`,
    "",
    `NOT THE FIX: removing \`reuseExistingServer: true\` from playwright.config.ts.`,
    `.github/workflows/ci.yml builds, starts \`npx next start -p 3000\` itself, waits`,
    `for readiness and expects Playwright to reuse it. Without the option CI would`,
    `try to launch \`npm run dev\` against an occupied port. This guard exists so`,
    `that option can stay.`,
  );

  return lines.join("\n");
}

/** Raised by {@link assertServingCurrentBuild}. Message is the report above. */
export class StaleServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleServerError";
  }
}

/**
 * Throws {@link StaleServerError} unless the server at `baseURL` can serve every
 * script its own probe page asks for.
 *
 * Returns a one-line summary on success so a passing run still says out loud
 * which server it decided to trust — the whole incident was a server nobody had
 * checked.
 *
 * Budgets: the page fetch gets 120s because a cold `next dev` compiles the route
 * on first request (`/login` measured at 5.7s warm; other routes reached 44s
 * cold, see auth.setup.ts). Chunk fetches get 30s and run in parallel — by the
 * time HTML references a chunk it is already built, in dev as much as in prod.
 */
export async function assertServingCurrentBuild(
  baseURL: string,
  probePath: string = PROBE_PATH,
): Promise<string> {
  const probeUrl = new URL(probePath, baseURL).toString();

  let html: string;
  let pageStatus: number;
  try {
    const res = await fetch(probeUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    pageStatus = res.status;
    html = await res.text();
  } catch (err) {
    throw new StaleServerError(
      `E2E ABORTED — could not fetch ${probeUrl} to check which build the server is serving.\n` +
        `  ${(err as Error).message}\n\n` +
        `Playwright had already accepted this base URL as "up" (webServer.url with\n` +
        `reuseExistingServer: true), so something is answering the port but cannot serve\n` +
        `a page. Check what is on it — see HANDOFF §7 "Machine".`,
    );
  }

  if (pageStatus !== 200) {
    throw new StaleServerError(
      `E2E ABORTED — ${probeUrl} answered HTTP ${pageStatus}, not 200.\n\n` +
        `This is the public login page and the same URL .github/workflows/ci.yml polls\n` +
        `for readiness, so a non-200 here means the server on ${baseURL} is not the app\n` +
        `this suite expects. Check what is holding the port — HANDOFF §7 "Machine".`,
    );
  }

  const srcs = extractScriptSrcs(html);
  const buildId = readBuildId();
  const buildIdInHtml = buildId !== null && html.includes(buildId);

  if (srcs.length === 0) {
    throw new StaleServerError(
      `E2E ABORTED — ${probeUrl} returned HTML with no <script src> at all.\n\n` +
        `A Next.js page always ships chunks; ${html.length} bytes arrived with none. So\n` +
        `either this is not the app (a proxy, a placeholder, another project on the\n` +
        `port), or the response is an error page dressed as a 200. Nothing this suite\n` +
        `asserts about interaction could pass. Check what is on the port — HANDOFF §7\n` +
        `"Machine" — and see docs/DECISIONS.md \`T-e2e-cold-server\`.`,
    );
  }

  /**
   * Same-origin only. Cross-origin scripts are somebody else's uptime, and a
   * CDN 500 is not evidence that OUR build moved. This app's CSP ships no
   * third-party scripts today, so in practice nothing is skipped.
   */
  const origin = new URL(baseURL).origin;
  const sameOrigin = srcs.filter((src) => new URL(src, baseURL).origin === origin);

  const probes: ChunkProbe[] = await Promise.all(
    sameOrigin.map(async (src): Promise<ChunkProbe> => {
      const url = new URL(src, baseURL).toString();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        // GET, not HEAD — a stale chunk must actually be requested the way the
        // browser requests it. Status and content-type are the whole verdict, so
        // discard the body rather than buffering a few MB of JavaScript; an
        // unconsumed undici body would hold its socket open instead.
        await res.body?.cancel();
        return { src, status: res.status, contentType: res.headers.get("content-type") ?? "" };
      } catch (err) {
        return { src, status: 0, contentType: "", error: (err as Error).message };
      }
    }),
  );

  const bad = probes.filter(
    (p) => p.error !== undefined || p.status !== 200 || !JS_CONTENT_TYPE.test(p.contentType),
  );

  if (bad.length > 0) {
    throw new StaleServerError(
      staleServerReport({
        baseURL,
        probePath,
        total: probes.length,
        bad,
        buildId,
        buildIdInHtml,
      }),
    );
  }

  const skipped = srcs.length - sameOrigin.length;
  return (
    `[server-health] ${baseURL} serves its own build: ${probes.length} of ${probes.length} ` +
    `${probePath} chunks are 200 JavaScript` +
    (skipped > 0 ? ` (${skipped} cross-origin skipped)` : "") +
    (buildId
      ? `; .next/BUILD_ID ${buildId}` +
        (buildIdInHtml ? " (in HTML)" : " (not in HTML — normal for `next dev`)")
      : "")
  );
}
