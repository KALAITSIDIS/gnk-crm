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

## 1. Three bugs that only exist in production

All three shipped undetected because local dev is more forgiving than a
production build. **Any change to upload, server-action or client/server
boundary plumbing should be verified against `next build && next start`, not
`next dev`.** Since 2026-08-04 the `e2e` CI job does exactly that on every push
— it found the third one on its first run.

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
