# ENGINEERING NOTES

Hard-won gotchas for working on this codebase — things that cost hours and are
not discoverable by reading the code.

**Scope.** Code- and framework-level traps live here. *Operational* traps
(Vercel, Supabase connector, migrations, CI) live in `HANDOFF.md` §3/§4/§7 — go
there first for anything about deploying or applying schema. Decisions and their
reasoning are in `docs/DECISIONS.md`.

**Every entry is dated. Verify before relying on one** — framework versions move,
and a fixed bug may have been refixed differently since.

---

## 1. Four bugs that only exist in production

All four shipped undetected because local dev is more forgiving than a
production build. **Any change to upload, server-action or client/server
boundary plumbing should be verified against `next build && next start`, not
`next dev`.** Since 2026-08-04 the `e2e` CI job does exactly that on every push
— it found the third one on its first run.

**The fourth is worse than the others and worth reading first**, because
`next build && next start` does NOT catch it: it reproduces only on Vercel, and
the local run is what makes it look fixed.

**A `Content-Security-Policy` key in `next.config.ts` `headers()` silently
disables Next's nonce — on Vercel, and not locally** (2026-08-10, `929055e`).
Next reads the per-request nonce off the REQUEST header of that exact name
(`app-render.js` → `getScriptNonceFromHeader`). A header declared in
`next.config.ts` lands under the same name, and **on Vercel it wins**: Next read
`frame-ancestors 'none'`, found no nonce, emitted `"nonce":"$undefined"` into the
RSC payload and stamped **0 of 22** script tags on every production page.
Locally the middleware value wins and everything looks perfect.

*Why it cost four days:* every symptom pointed outward. The policy was
report-only so nothing broke visibly; the response header correctly advertised a
nonce; the build output was right; the cache was `MISS`/`no-store`; and
`next start` on the same build stamped 22 of 22. Three separate rounds concluded
Vercel was *dropping* a header it was in fact delivering.

*The diagnosis that worked, and the transferable lesson:* **stop asking why
something is missing and measure what actually ARRIVED.** A temporary route that
reported which request headers reached the handler answered it in one deploy —
both headers arrived, and the CSP one simply wasn't ours. Every round that
reasoned about the absence got it wrong.

*Guard:* three E2E assertions now require that **no enforcing
`Content-Security-Policy` response header exists**, with the reason in the
failure message. `npm run check:csp-nonce <url>` measures any deployment and
exits 1 when the header promises a nonce the scripts do not carry — the check
that was missing while every local run stayed honest and blind.

*Related trap, same family:* **a response header set through
`NextResponse.next()` comes back round as a REQUEST header.** So "just set it in
middleware instead" reproduces the collision, and a diagnostic routed through a
branch that sets response headers will read its own output.

**Binary uploads must be wrapped in a `Blob`** (2026-07-15, `3a546e2`).
`@supabase/storage-js` sends a raw Node `Buffer`/`Uint8Array` as a *direct* fetch
body, and **Vercel's serverless runtime UTF-8-stringifies it** — every byte
≥ 0x80 becomes `EF BF BD` (U+FFFD), destroying the file while it still looks like
a successful upload. Every property photo on the live site was corrupt from day
one. It **never reproduces locally** (Node 18–24 send the Buffer as-is), so the
pipeline test passes. `lib/services/storage-upload.ts` `binaryBody()` wraps bytes
in a `Blob`, which storage-js routes as multipart/form-data — binary-safe
everywhere. Applies to *all* uploads: media renditions, documents, slip PNG/PDF,
evidence PDF, branding. `File` objects can be passed directly.
*Diagnosis that worked:* `curl` the public URL → HTTP 200, `content-type
image/webp`, but `sharp().metadata()` throws; first bytes read
`52494646 78EFBFBD…` (RIFF, then replacement chars). **Already-corrupt files
cannot be repaired — delete and re-upload.**

**A client component importing a `node:*` module poisons the browser bundle**
(2026-08-04, `8f614a6`). `share-links-client.tsx` is a client component and
imported constants and pure helpers from `lib/services/share-links.ts`, whose
first line was `import { createHash, randomBytes } from "node:crypto"`. That one
import dragged Node crypto into the browser bundle, where the bundler polyfills
it — `vm-browserify`, `function-bind`, `is-generator-function` — and those shims
call the `Function` constructor. Result: a real
`script-src / blockedURI: "eval"` violation, i.e. `/share-links` **would have
broken the day the CSP was enforced**.
*Fix:* split the module. Node-dependent functions moved to
`share-links-token.ts` behind `import "server-only"`, which makes a repeat a
**build error** rather than a silent regression — the guard `admin.ts` uses.
Pure constants and helpers stayed put, with a header saying the file must remain
free of `node:*` imports.
*Two traps in one:* it is invisible under `next dev` (which ships
`'unsafe-eval'`), **and** the symptom exactly matched a documented Zod 4 JIT
issue that had been fixed weeks earlier — inspecting the actual chunk showed
zero Zod fingerprints. **When a symptom matches a known cause, still check the
bytes.**

**A `"use server"` file may only export async functions** (2026-07-16, `c824b83`).
Exporting a runtime const (an options array, say) works in dev, but the
production bundle throws `A "use server" file can only export async functions,
found object` at module evaluation — which kills **every** server action on that
route, not just the one nearby. `export type` / `export interface` are fine
(erased at compile time). Constants shared with client components belong in
`lib/validators/*`.

---

## 2. Framework traps

**`pg_policies.qual` is deparsed against the CALLER's `search_path`, so a
policy-inspecting function can silently invert.** (2026-08-11, migration 0030.)
`pg_policies.qual`/`with_check` are produced by `pg_get_expr()`, which
schema-qualifies any object not reachable through the current `search_path`. A
`security definer` helper that pins `set search_path = pg_catalog` — which is the
right thing to do, see §4.3 — therefore reads `public.current_org_id()`, while
the same query run in a normal session reads `current_org_id()`. **A guard that
text-matches an unqualified literal then matches nothing and reports the exact
opposite of the truth**: 0030's first guard called all 24 rewritten policies
un-hoisted while `EXPLAIN` proved the hoist was working.

*Fix:* normalise the qualification away before matching
(`replace(…, 'public.current_org_id()', 'current_org_id()')`) rather than
depending on any particular path, and verify the function returns the same answer
under at least two different `search_path` settings. *Related:* if you compare a
before/after snapshot, normalise **both** sides identically — normalising only
one makes a re-run report that everything changed when nothing did.

**Radix `TabsTrigger` ignores `element.click()`.** Dispatch
`new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })`.
Buttons and dialogs respond to `.click()` normally. (2026-07-11)

**`DndContext` needs an explicit `id`.** Without it, `aria-describedby` derives
from a module-level counter that desyncs between SSR and the StrictMode
double-rendered client mount — a real hydration mismatch. Pinned on the pipeline
kanban 2026-07-16.

**Radix renders a 1×1 `aria-hidden` native `<select>` per Select** so forms
submit. It is not in the accessibility tree — a11y tests must skip `aria-hidden`
/ out-of-tab-order elements or they will flag false positives. (2026-07-23)

**Anything rendering `now()`-relative text hydrates mismatched.** Elapsed-time and
relative-date badges differ between SSR request-time and client hydration-time.
Use `suppressHydrationWarning` on the element (React's sanctioned path — the SSR
value still paints and the client value is accepted). Prefer this to a
mounted-gate that blanks the first paint. (2026-07-15)

**A `loading.tsx` boundary can freeze a page interactively** — SSR HTML looks
right, nothing responds, zero console errors (Next 16.2.10 queued-suspense-reveal
bug). Symptom check: `<!--$~-->` comment markers, and fiber keys via
`Object.getOwnPropertyNames(el).some(k => k.startsWith("__react"))`. Removed for
`/properties`; see DECISIONS 2026-07-12. Re-test interactivity if a new
`loading.tsx` is added.

**next-intl swallows ICU format errors** and silently falls back to the key path,
so a malformed message still "renders". `lib/services/messages.test.ts` needs an
`onError` that rethrows — the first version of that test passed against a
deliberately broken message. (2026-07-21)

**`getTranslations({ locale: "en" })` does not honour the requested locale here.**
`i18n/request.ts`'s `getRequestConfig` hardcodes `defaultLocale` and ignores it,
so it follows the live request locale — which once rendered the *evidence
preview* in Greek. Use `createTranslator` over the imported `en` messages when
output must be locale-independent (the evidence PDF is deliberately English).
(2026-07-22)

**Next.js strips thrown Server Action messages in production.** Guard text
surfaces as a generic digest error. **Result objects (`{ error }`) are the repo
convention** for anything called from a client component. (2026-07-16)

---

## 3. Data and correctness rules

**Never change production state with raw SQL when an action would write an
event.** `archiveProperty` writes an `archived` event; a direct `UPDATE` leaves
the retire unlogged and the event log lies. The exception is a column that is not
itself evented (e.g. `deals.last_activity_at`).

**Code and schema land out of order.** Vercel deploys on push; migrations are
applied by hand. **A deploy must never hard-depend on a new enum value** — a push
once briefly shipped an insert of `doc_type='evidence_report'` to a prod DB that
did not have it yet. Ship a fallback, then relabel in the migration.

**`psql -c` with multiple statements is one implicit transaction.** An error in
the last statement silently rolls back the earlier "INSERT ok" ones. Use one
`docker exec … psql -c` per statement when seeding fixtures.

**Postgres reorders `jsonb` keys**, so naive diffing logs phantom changes on
multilang fields. Use `lib/utils/diff.ts` (stable-key stringify).

**RLS filters silently.** An `UPDATE` a policy rejects returns 0 rows, not an
error — which historically produced fake "Saved" toasts and phantom events. The
repo convention is `.update(...).select("id")` and a row-count check *before*
logging anything.

---

## 4. Testing discipline

> **See also §7, "Instruments that lie".** Before trusting a test's verdict, check the test could report the OTHER answer. On 2026-08-18 the property-map tile assertion was, within eight hours, both a test that could not fail and a test that could not pass — and the second one's red CI was read as proof a working feature was broken.

**A test that only passes on a RERUN is depending on residue.** The RLS suite must
pass on the FIRST run against a fresh database. CI runs `supabase start` +
`test:rls` once on an empty DB, so residue-dependent assertions are green locally
and red in CI.

**A test that ignores an action's returned error can hide a permission regression
for months** — TEST-2 did exactly that.

**Assert on the creation event, not the final row, when a job both creates and
repairs in one pass.** 0024's nightly sweep re-homes stranded tasks in the same
invocation that mints them, so asserting on `tasks.assignee_id` passed even with
the buggy code restored.

**A guard keyed to a credential's *content* dies when the format changes.**
`security.spec.ts` asserted `not.toContain("service_role")`; a modern
`sb_secret_…` key contains no such string, so the key rotation would have left
that test passing and blind.

**Playwright's `request` fixture is authenticated.** It reported 200 for
`/manifest.webmanifest` while real browsers got a 307 to `/login`. Test public
surfaces with an anonymous context.

**Running the E2E suite against a deployed environment needs
`--project=desktop --no-deps`** — the `setup` project logs in with *local* seed
credentials and correctly fails otherwise. Do not put production credentials in
`E2E_EMAIL`/`E2E_PASSWORD` to work around this.

**Local green ≠ CI green.** CI was red for five consecutive commits without anyone
noticing, because only the `rls` job failed while `checks` stayed green. Check the
Actions API for the SHA after pushing.

**`playwright.config.ts` sets `reuseExistingServer: true`, so a local run can
test a DIFFERENT BUILD than the one you just compiled.** A `next start` left on
the port by an earlier run is silently reused — Playwright reports nothing, and
the only tell is `EADDRINUSE` in the server log you redirected to a file. On
2026-08-10 this cost three invalid runs: a "31 passed" that was measuring the
previous build, and worse, a CSP negative control that "passed" because the
breakage under test was never served. **Verify a served response header that the
change would alter BEFORE trusting any local result** — that gate is what caught
it. Two follow-ons: `pkill -f "next start"` does NOT kill the process on Windows
(use `taskkill //PID <pid> //F`, found via `netstat -ano | grep :PORT`), and a
port that `netstat` reports free can be re-bound during the ~2 min build, so
check the log rather than the port. Running on a unique port via `E2E_BASE_URL`
sidesteps the whole class.

**A `test.skip()` on missing data is a test that reports success by not
running (2026-08-10).** Four did, and they were skipping in CI on the very run
that ENFORCED the CSP — the worst possible day. One was actively *unfalsifiable*: `property
images … satisfy img-src` skipped when `storageHits === 0`, but a CSP that blocks
the image produces no response event, so breaking `img-src` made it skip rather
than fail. Proven by negative control, not argued. **Seed the data, then assert
the seeded thing is actually present** (`storageHits > 0`, the canvas is visible,
the Next link exists) — otherwise a real break lands back in the same silent
skip. `csp.spec.ts` and `performance.spec.ts` show the pattern; the suite went
174/3-skipped to 177/0.

---

## 5. Local stack recovery (Windows / Docker)

**Local seed login:** `admin@gnk.local` / `admin1234` (from `docs/07_SEED_DATA.sql`).
`agent@gnk.local` is **not** in seed.sql and vanishes on `supabase db reset` —
recreate via the GoTrue admin API (`POST {url}/auth/v1/admin/users`,
`email_confirm: true`) then insert the `profiles` row.

**If those passwords stop working**, re-canonicalize directly — GoTrue accepts the
bcrypt hash immediately:

```sql
update auth.users
   set encrypted_password = crypt('admin1234', gen_salt('bf'))
 where email = 'admin@gnk.local';
```

**Containers "healthy" but unreachable.** Started from Docker Desktop directly they
can come up with **no host port bindings** (`docker ps` shows `8000/tcp`, not
`0.0.0.0:54321->8000`), so `127.0.0.1:54321` is connection-refused while
everything looks green — and the app's login then shows a misleading "Invalid
email or password". Fix: `npx supabase stop && npx supabase start`.

**If start then fails with "ports are not available … access permissions"** on
54321/54322, Windows has reserved the range. Check
`netsh interface ipv4 show excludedportrange protocol=tcp`, then, elevated:
`net stop winnat && net start winnat`. DB volume data survives all of this.

**A stale `.next` serves 404 for routes whose files exist**, and can also corrupt
`.next/dev/types/validator.ts` and break `npm run typecheck`. When a route 404s
but the page file is on disk, delete `.next` before debugging the code. Stop the
dev server first.

**Never rebuild while a server is serving — `next start` counts, not just
`next dev`** (2026-08-04). Rebuilding under a running `next start` leaves it
serving a half-replaced `.next`: the second server fails to bind
(`EADDRINUSE`, easy to miss if backgrounded) and the stale one renders the error
boundary on pages that are actually fine. It cost a false "my fix broke the
page" during the share-links investigation. Kill the listener first:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen |
  Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
```

Then expect `npm run build` to fail once with `EPERM: unlink .next/static/…`
(the OneDrive handle lock) — clear it with
`Remove-Item -LiteralPath .next -Recurse -Force` in PowerShell and rebuild.

**Docker/WSL dies when the machine sleeps or the disk fills.** Recovery:
`wsl --shutdown`, start Docker Desktop, `npx supabase start` (retry once if the
storage container reports unhealthy).

**Disk runs tight on this machine.** `.next` and `tests/.playwright-report` are
the reclaimable bulk.

---

## 6. Multiple agents share this working tree

Sessions have run concurrently in the same checkout. Consequences seen in
practice:

- **Another session switched the branch mid-task**, so a commit intended for
  `main` landed on a feature branch — and `git push origin main` reported
  "everything up-to-date", which was the only clue. **Always
  `git rev-parse --abbrev-ref HEAD` before committing.**
- **Stage explicit paths, never `git add -A`,** when another session's work may be
  in flight.
- Duplicate commits dedupe by patch-id on `git rebase origin/main`
  ("skipped previously applied commit").
- Unit-test counts and `tests/screenshots/` churn between runs for reasons that
  are not your change.

---

## 7. Instruments that lie (2026-08-18)

§1 collects bugs that only exist in production. This section is a nastier class:
**measurements that are wrong only when a machine takes them.** They do not
error. They return a confident number, and the number is garbage.

They cost a full day on the property map, which was declared broken, had its link
hidden from users and two of its tests disabled — while working perfectly the
whole time.

### 7.1 A hidden tab never runs `requestAnimationFrame`

MapLibre requests tiles from inside its rAF render loop and fires `load` from
there. In a backgrounded tab the loop never runs, so the map:

- requests **zero** tiles, and never fires `load`
- draws nothing at all — not even layers fed from local GeoJSON
- reports a correctly sized canvas, working WebGL2, a live worker
- logs **no error**, and trips **no CSP violation**

That is indistinguishable from a broken map, and it is what every browser
automation tool produces by default — including checks against production.
`tabs_select` does not fix it: the pane still is not the OS-foreground window.

**Before believing anything about a canvas, WebGL, animation or a map:**

```js
document.visibilityState  // "hidden" ⇒ nothing you observe about rendering is evidence
document.hasFocus()
```

Playwright pages report `visible`, **headless included**, so a Playwright run is
valid evidence where a driven browser tab is not.

### 7.2 A worker's fetches never reach the window's resource timeline

`performance.getEntriesByType("resource")` is per-global. Vector tiles are fetched
by MapLibre's worker, so they appear in the worker's timeline and **never** in the
window's. Measured on one working page at one moment:

| instrument | tiles seen |
|---|---|
| `page.on("request")` (network level) | **9** |
| `performance.getEntriesByType("resource")` in the page | **0** |
| any `.pbf` in the window timeline | 11 — all font glyphs, main thread |

An in-page tile count therefore **cannot pass, ever**. Count network activity from
outside the page: `page.on("request")` in Playwright, or the DevTools/CDP log.

### 7.3 The rule this generalises to

Both failures share a shape, and so did `pg_stat_user_functions` in §4: **a
measurement that is structurally incapable of observing the thing it is asked
about, returning a plausible zero.**

A test that cannot fail and a test that cannot pass are the same defect — the
outcome does not depend on the behaviour under test. The property-map assertion
was both within eight hours: first counting any `.pbf` (passed on glyphs, would
have passed with the map blank), then counting `/planet/` tiles in the page
(could never pass at all, and its red CI was read as proof the feature was
broken).

**So: prove the instrument can produce BOTH answers before trusting either.**
Point it at a case known to be working and confirm it says so. That single check
would have cost minutes and saved the day.

---

## 8. The functions ran in Virginia while the database sat in Frankfurt (2026-08-18)

Roadmap item A9 asked for a performance baseline on live `/dashboard`. The
baseline turned out to have a single dominant cause, and it was not query
complexity.

**Measured on production, warm, three fetches per route:**

| route | ms |
|---|---|
| `/properties` | 608 – 830 |
| `/contacts` | 628 – 694 |
| `/dashboard` | 1052 – 1324 |
| `/tasks` | 1105 – 1426 |
| **`/login`** | **1255 – 1441** |

**`/login` is the tell.** It renders a form and fetches no business data, and it
is as slow as the dashboard. So the floor is not what a page queries — it is a
fixed cost every request pays.

**The cause, from one header:**

```
X-Vercel-Id: fra1::iad1::…
              ^edge  ^function
```

The request reaches Vercel's edge in Frankfurt and is then executed in **iad1
(Washington DC)**, while Supabase runs in **eu-central-1 (Frankfurt)**. Every
Supabase call therefore crosses the Atlantic and comes back.

And every request makes at least one, before any page code runs: `proxy.ts` calls
`supabase.auth.getUser()` in middleware on **every** request — which is correct
for auth, and is exactly why `/login` pays too. Pages then make several more
sequential calls, each paying the same round trip.

**Fix: `vercel.json` pins `"regions": ["fra1"]`,** putting the function in the
same city as the database. Cold starts (~4s first hit, measured) are a separate
serverless characteristic and are NOT addressed by this.

**The lesson worth keeping is the diagnostic, not the config.** A slow dashboard
invites you to optimise the dashboard's queries. Measuring the CHEAPEST page in
the app is what proved the cost was structural — no amount of query tuning would
have moved it, because `/login` has no queries to tune.
