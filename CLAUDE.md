# CLAUDE.md — GN Real Estate OS (gnk-crm)

Internal real-estate CRM & property operating system for GN Kalaitsidis Capital, Paphos, Cyprus.
**Standalone build. No integrations with any external company tools.**

## Read these before writing any code

| Order | Document | Purpose |
|---|---|---|
| 1 | `docs/01_PROJECT_CONTEXT.md` | Vision, scope, modules, guardrails — the constitution |
| 2 | `docs/02_PHASE_1_BUILD_SPEC.md` | Architecture decisions + functional spec per module with acceptance criteria |
| 3 | `docs/03_DATABASE_SCHEMA.sql` | Authoritative Phase 1 DDL (copy into migrations, verify, fix, never redesign silently) |
| 4 | `docs/04_RLS_POLICY_MATRIX.md` | Role × table × operation matrix — implement exactly, test every row |
| 5 | `docs/05_ROUTES_AND_SCREENS.md` | Full route map and screen contents |
| 6 | `docs/06_UI_DESIGN_SYSTEM.md` | Brand tokens, layout, component rules |
| 7 | `docs/07_SEED_DATA.sql` | Districts, deal stages, Cyprus rate config |
| 8 | `docs/08_BUILD_PLAYBOOK.md` | **The step-by-step task list. Execute in order, one task at a time.** |
| 9 | `docs/09_DATA_IMPORT_TEMPLATES.md` | CSV import formats for real data |

## Stack (fixed — do not substitute)

- Next.js 14+ App Router, TypeScript **strict**, Tailwind CSS, shadcn/ui
- Supabase: Postgres (EU region), Auth, Storage, RLS; extensions: `postgis`, `pg_trgm`, `pgcrypto`, `pg_cron`
- next-intl with locales `en`, `el`, `ru` (Phase 1 UI ships English; structure must be i18n-ready; all property/marketing text fields are multilingual jsonb `{en,el,ru}`)
- Zod validation on every server action input
- Supabase generated types (`npm run db:types`) — never hand-write DB types
- Vercel deployment, GitHub CI (typecheck + lint + tests on every push)
- Media: Sharp in server actions (EXIF strip → renditions → optional watermark) → Supabase Storage buckets `media` (public renditions), `documents` (private), `signatures` (private)
- PDF: `@react-pdf/renderer` for commission evidence reports

## Commands

```bash
npm run dev              # local dev
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm run test             # vitest (unit + RLS tests)
npm run test:rls         # RLS suite only (requires local supabase running)
supabase start           # local stack
supabase db reset        # re-run all migrations + seed
npm run db:types         # regenerate types from local DB
```

## Non-negotiable guardrails

1. **Event log first.** Every create/update of properties, contacts, leads, deals, viewings, offers, mandates, keys, share links writes a row to `events`. A feature without its events is NOT done. `events` has no UPDATE/DELETE — never grant them, never work around it.
2. **`org_id` on every table**, every query scoped by RLS. No other multi-tenant complexity in Phase 1.
3. **RLS is tested, not trusted.** Every row of the matrix in doc 04 has an automated test. A migration touching policies without updated tests is incomplete.
4. **No buyer logins. No lawyer/bank logins.** Ever. External access = tokenized expiring links only (Phase 2+).
5. **Cyprus rates live in `cyprus_config`**, never hardcoded. Calculators read config.
6. **Three fixed dashboards** (Admin, Agent, Owner/Developer-later). Do not build dashboard customization.
7. **Do-Not-Build list in doc 01 §10 is binding.** No WhatsApp API, no KYC API, no portal feeds, no automated commission splits in Phase 1.
8. **Manual commission splits** = plain text fields on deals.
9. **Complete files only.** When modifying, output/write the entire file — no fragments, no "rest unchanged".
10. **Verify before claiming done.** Run typecheck, lint, tests, and the task's acceptance checklist from the playbook before marking any task complete. Paste actual command output in your summary.

## Working method

- Follow `docs/08_BUILD_PLAYBOOK.md` strictly: **one task → implement → verify → commit → next task.** Commit message format: `T1.3: property media pipeline (exif strip + renditions)`.
- If the schema in doc 03 has an error, fix it in the migration AND update doc 03 in the same commit, noting the fix.
- If a real ambiguity blocks you, choose the option most consistent with docs 01–02, implement it, and record the decision in `docs/DECISIONS.md` (create it on first use). Do not stop to ask for trivial choices.
- Never invent scope. If a nice-to-have occurs to you, add a line to `docs/BACKLOG.md` instead of building it.
- Mobile-first for: viewing slip signing screen, agent daily dashboard, lead inbox. Desktop-first for everything else.

## Definition of Done (every task)

- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] `npm run test` green (including RLS suite when policies touched)
- [ ] Events written for all new mutations
- [ ] Acceptance checks from the playbook task pass (state each one explicitly)
- [ ] Committed with task-ID message
