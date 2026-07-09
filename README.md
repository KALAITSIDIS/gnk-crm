# GN Real Estate OS — gnk-crm

Custom real-estate CRM & property operating system for **GN Kalaitsidis Capital** (Paphos, Cyprus). Standalone build — no external tool integrations. This repository starts as **documentation + build instructions**; Claude Code scaffolds and builds the application from it, step by step.

## What's in this repo (before any code exists)

```
CLAUDE.md                      ← Claude Code reads this automatically every session
.env.example                   ← copy to .env.local and fill
docs/
  01_PROJECT_CONTEXT.md        ← vision, scope, modules, guardrails (the constitution)
  02_PHASE_1_BUILD_SPEC.md     ← architecture decisions + functional specs + acceptance criteria
  03_DATABASE_SCHEMA.sql       ← authoritative Phase 1 DDL
  04_RLS_POLICY_MATRIX.md      ← security matrix + mandatory tests
  05_ROUTES_AND_SCREENS.md     ← every page and what's on it
  06_UI_DESIGN_SYSTEM.md       ← brand tokens, components, layout rules
  07_SEED_DATA.sql             ← org, districts, deal stages, Cyprus rate config
  08_BUILD_PLAYBOOK.md         ← ★ step-by-step task list (Sprint 0 → 5)
  09_DATA_IMPORT_TEMPLATES.md  ← CSV formats for migrating your real data
```

## Before starting Claude Code — do these once (10–15 minutes)

1. **Supabase**: create a project at supabase.com → **region: EU (Frankfurt `eu-central-1` recommended)** for GDPR. Copy Project URL, anon key, service_role key.
2. **Vercel**: create a project (connect this GitHub repo). Add the same env vars there later.
3. **Resend** (email, can wait until Phase 2) and **Sentry** (error tracking): create accounts, copy keys — or leave blank for now; only Supabase vars are required for Sprint 0.
4. Copy `.env.example` → `.env.local` and fill the Supabase values.
5. Have your current data ready to export later per `docs/09` (contacts first, then properties). Not needed until Sprint 5.

## Kickoff — paste this as your first Claude Code prompt

> Read CLAUDE.md and all files in docs/ in order (01→09). Confirm in one short summary that you understand the scope, the guardrails, and the Do-Not-Build list. Then execute docs/08_BUILD_PLAYBOOK.md starting at task T0.1. Work one task at a time: implement, run the verification commands, show me the output, commit with the task ID, then continue to the next task. Do not skip tasks, do not add scope, record any decisions in docs/DECISIONS.md.

For later sessions:

> Continue the playbook from the last committed task. Check git log for the last T-number.

## Decisions already made (change only by editing docs/02 §A)

Single internal app first at `crm.kalaitsidis.com` (public site is a separate Phase 2 app on the same Supabase) · Supabase EU · invite-only auth, no self-signup · UI in English for Phase 1, all content fields trilingual EN/EL/RU · reference scheme `GNK-PAF-0001` · shadcn/ui with replaceable brand tokens · Cyprus rates in a config table, **verify against current legislation before go-live**.

## Hard rules (full list in CLAUDE.md)

Append-only event log behind everything · RLS tested not trusted · no buyer/lawyer logins ever · manual commission splits · three fixed dashboards · the Do-Not-Build list in docs/01 §10 is binding.

## Phase 1 outcome

Working internal CRM: properties (incl. developer project→unit matrices), mandates & keys, contacts with dedup + KYC/banking checklists, lead inbox with response clocks, kanban pipeline with deal health, viewings with **signed digital viewing slips**, commission evidence PDF reports, transfer-fee & stamp-duty calculators, admin/agent dashboards, settings — deployed on Vercel + Supabase EU with your real data imported.
