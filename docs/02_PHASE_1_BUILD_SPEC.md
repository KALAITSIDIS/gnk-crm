# 02 — PHASE 1 BUILD SPEC (Internal CRM MVP)

Functional specification for everything Phase 1 ships. Read with docs 03 (schema), 04 (RLS), 05 (routes), 06 (UI), 07 (seed), 08 (playbook).

---

## A. Architecture decisions (made — override only by editing this file)

| # | Decision | Choice |
|---|---|---|
| A1 | App topology | **One repo, one Next.js app** = the internal CRM, deployed at `crm.kalaitsidis.com`. The public website (Phase 2) will be a **separate repo/app** sharing the same Supabase project. Nothing public in this app. |
| A2 | Auth | Supabase Auth, email+password, **invite-only** (no self-signup; admin creates users). 2FA (TOTP) enabled for admin role. |
| A3 | Org model | Single organization row seeded (`GN Kalaitsidis Capital`). All tables carry `org_id`; helper `current_org_id()` resolves from `profiles`. |
| A4 | Roles Phase 1 | `admin`, `agent`, `listing_manager`. Portal roles exist in the enum but are unused until Phase 4. |
| A5 | UI language | Interface in **English** for Phase 1 (internal team). i18n scaffolding (next-intl, `messages/en|el|ru.json`) present from day one. All content fields (titles, descriptions) are jsonb `{en, el, ru}`. |
| A6 | Reference numbers | `GNK-{DISTRICT_CODE}-{4-digit seq}` per district (e.g. `GNK-PAF-0001`); units append `-U{n}` or unit number (`GNK-PAF-0007-B203`). Generated server-side on property creation, immutable afterwards. |
| A7 | Media processing | In Next.js server actions with Sharp (no separate service): strip EXIF → renditions thumb 400px / card 800px / full 1600px WebP → optional watermark on `full` when property visibility ∈ {public, partner} → upload renditions to `media` bucket, original to `documents` bucket (private). |
| A8 | Quality Score | Computed in app code on every property save; stored in `properties.quality_score`. Weights in §C1. Publishing to visibility `public` blocked below 70 unless admin override (logged as event). |
| A9 | Search | `pg_trgm` ILIKE-based fuzzy search on properties (reference, title, address) and contacts (name, phone, email). PostGIS for map/radius later; store coordinates now. |
| A10 | Testing | Vitest. RLS suite: run against local Supabase using anon + per-role JWTs; assert allowed/denied per matrix row. Unit tests for calculators, quality score, phone normalization, reference generator. |
| A11 | Timezone / locale | Store UTC; display Asia/Nicosia. Currency EUR, format `€1.234.567`. Area m², distances m. |
| A12 | Phone normalization | `libphonenumber-js`, default region CY, store E.164 in `phone_e164`; raw kept in `phone_raw`. Unique per org (partial index where not null). |

## B. Repo structure (scaffold target)

```
app/
  (auth)/login/
  (app)/dashboard/  properties/  contacts/  leads/  pipeline/  deals/
        viewings/  keys/  reports/  calculators/  settings/
components/ui/            # shadcn
components/features/<domain>/
lib/supabase/{client,server,admin}.ts
lib/actions/<domain>.ts   # server actions ('use server'), zod-validated
lib/services/{media,quality-score,reference,events,calculators}.ts
lib/validators/<domain>.ts
lib/utils/
supabase/migrations/  supabase/tests/
scripts/import/{properties,contacts}.ts
messages/{en,el,ru}.json
docs/
```

Rules: server components by default; mutations via server actions only; every action = zod parse → auth/role check → mutation → `logEvent()` → revalidate.

---

## C. Module specs & acceptance criteria

### C1 — M1 Property Inventory & Media

Hierarchy via `parent_id` + `kind`: `standalone` (default), `project` → `phase` (optional) → `unit`. Units inherit district/area/address from parent unless overridden. Project detail page shows a **units matrix** (unit no · type · beds · area · list price · status) with inline status change.

Quality Score weights (total 100): cover photo 10, ≥6 photos 15, title EN 5, public description EN ≥300 chars 10, price 10, covered/plot area 10, bedrooms+bathrooms (non-land) 5, exact location coords 10, title-deed status set 10, permit status set 5, mandate active 10. Land: bedrooms weight moves to planning-zone+density fields.

Price changes: editing `asking_price` writes `price_history` + event automatically (DB trigger).

**Accept:** create standalone property → reference auto `GNK-PAF-XXXX`; create project + 3 units → matrix renders, unit status change writes event; upload 3 photos → EXIF gone (verify with exiftool/sharp metadata), 3 renditions exist, cover selectable; score updates live and blocks public publish < 70; price edit produces history row + event.

### C2 — M2 Mandates & Keys

Mandates: type (exclusive/open/verbal), owner contact, commission %, start/expiry, signed doc upload, status auto-`expired` past expiry (pg_cron daily). Property card shows mandate badge (green exclusive / amber open / red expired / grey none). Expiry alerts: task auto-created for assigned agent at `expiry - renewal_reminder_days`.

Keys: register per property (code, description, status); checkout/return movements with holder + timestamp; all movements are events.

**Accept:** expired mandate flips status via cron job (test by manual function call); key checkout shows holder on property page; commission % visible only to admin+assigned agent (RLS row tested).

### C3 — M3 Contact CRM

Create/edit with phone normalization; duplicate check on save (same `phone_e164` or same email) → block with link to existing + **Merge** option. Merge: keep primary, move leads/deals/viewings/events references, archive duplicate (event logged). Tabs: Profile · Preferences (areas[], budget range, beds, types, purpose) · Psychology profile (investor / relocation / luxury / retirement / holiday) · KYC checklist · Banking-readiness checklist · Activity (event timeline) · Deals.

KYC checklist items (boolean + note + doc link): passport/ID, proof of address, source-of-funds declaration, source-of-funds evidence, sanctions self-declaration, PEP declaration. Banking readiness: nationality risk note, funds origin country, bank pre-check done, account feasibility (yes/maybe/no).

**Accept:** entering `99 123456` stores `+35799123456`; duplicate phone blocked with merge path; merge preserves full event timeline; consent checkbox stores timestamp; checklists persist and render completion %.

### C4 — M4 Lead Management

Lead inbox (newest first) with colour-coded response clock: green <5 min, amber <60 min, red >60 min unanswered. Actions per lead: assign agent, link/create contact (dedup applies), **Mark contacted** (stamps `first_response_at`), **Mark called** (stamps `first_call_at`), convert → creates deal at first stage, or mark lost/spam. Manual "Log conversation" (channel WA/TG/phone/email + note) writes event. Click-to-chat buttons: `wa.me/<E164>` and `t.me/<username>` — opening one logs an event.

**Accept:** clock colours correct at boundaries; convert creates deal + links contact + events; speed stats appear on admin dashboard (avg first response today/week).

### C5 — M5 Pipeline & Deals

Kanban per deal type (tab switcher: Sale / Rental / Antiparoxi / Advisory), stages from `deal_stages` seed, drag-and-drop = stage change event. Deal drawer: property, buyer, seller, agent, expected value, **commission_split_notes (plain text)**, health panel, offers list, activity.

Health score (0–100): budget confirmed 25 · KYC checklist ≥50% 15 · title deed status known 15 · mandate active 15 · activity within 7 days 30 (decays: ≤7d full, ≤14d 15, else 0). Recomputed on any deal/related event.

**Accept:** drag writes event with from/to stages; health recomputes after logging activity; won stage requires an accepted offer or admin override (logged); manual split text saved and printed on evidence report.

### C6 — M6 Event Log & Commission Evidence

`logEvent()` service used by every mutation. Evidence report generator: pick contact (+ optional property/deal) → PDF: company header, contact identity, chronological table (timestamp · event · property ref · actor · details) covering first contact, properties shared, link opens (Phase 2), viewings **with signed-slip thumbnails + hash**, offers, stage changes; footer with generation timestamp + report hash. Stored in `documents` bucket + event.

**Accept:** attempted UPDATE on events as any role fails in RLS test; report for a seeded scenario contains all expected rows in order; hash chain verifies (`verify_events_chain()` returns true; returns false after manual tamper in test).

### C7 — M7 Viewings & Signed Slip

Calendar (week/day) + list; create viewing: property, contact, agent, datetime, duration; optional multi-stop route for a day (drag order). Reminders Phase 1 = in-app tasks only (email Phase 2–3). Feedback form after completion: rating 1–5, liked, disliked, comment → visible on property activity.

**Slip flow (mobile):** `/viewings/[id]/sign` → shows agency name, agent, buyer name, property reference + address, datetime, GDPR line → buyer signs on canvas → save: PNG to `signatures` bucket, SHA-256 into `viewing_slips`, optional geolocation, event `viewing_slip_signed` → slip PDF downloadable.

**Accept:** slip stores hash matching file; slip renders in evidence report; completed viewing without feedback shows nudge on agent dashboard; cancelled/no-show statuses write events.

### C8 — M8 Compliance core: title-deed tracker + calculators

Per property legal panel: title deed status, permit status, share of land, encumbrances notes — changes are events. Calculators page + embedded on property/deal:

- **Transfer fees:** DLS bands from `cyprus_config` (3% ≤ €85k, 5% ≤ €170k, 8% above), apply 50% relief toggle (default on), and **zero when VAT was paid** toggle. Show band breakdown.
- **Stamp duty:** 0 ≤ €5k, 0.15% ≤ €170k, 0.20% above, cap €20,000.
- Output: on-screen breakdown + "copy summary" text (EN/RU/GR strings from messages).
Every calculator displays: *"Rates from config, last verified {verified_at} — verify current legislation."*

**Accept:** unit tests hit documented boundary values exactly (e.g. €85,000 / €170,000 / €300,000 with and without relief); config edit in Settings changes results without deploy.

### C9 — M17 Visibility + M18 Dashboards + Settings

Visibility select on property: public · private · vip · partner · off_market · coming_soon · archived (public gated by score, §C1). Phase 1 note: "public" only marks readiness — no public site yet.

**Admin dashboard:** pipeline value by stage, deals won this month, new leads today/week + avg first-response, listings by status, mandates expiring ≤30 days, top agents by activity events.
**Agent dashboard (mobile-first):** today's viewings, overdue tasks, hot buyers (temperature=hot with no activity 3+ days), my new leads with clocks, quick actions.

**Settings:** org profile, users (invite, role, deactivate), deal stages editor (rename/reorder/add per type), districts & areas, Cyprus config editor (admin only, edits are events), watermark upload.

**Accept:** each dashboard number reproducible by a SQL query documented in code comments; settings edits write events; non-admin cannot open Cyprus config (RLS + UI).

---

## D. Explicitly OUT of Phase 1

Public website · proposal/reservation generators · magic-link pages · investment calculator · VAT wizard · AI matching/drafting · WhatsApp/Telegram APIs · KYC API · email/calendar sync · owner/developer/partner portals · comparables · aftercare automation · portal feeds. (Phases per doc 01 §9.)
