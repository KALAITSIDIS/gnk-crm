# 05 — ROUTES & SCREENS (Phase 1, internal app)

App Router. `(auth)` = public auth pages; `(app)` = authenticated shell (sidebar + topbar). Mobile-first screens marked 📱.

## Route map

| Route | Screen | Roles |
|---|---|---|
| `/login` | Email+password, forgot password. No signup. | public |
| `/dashboard` | Role-aware: admin variant / agent variant 📱 | all |
| `/properties` | List: table + card toggle; filters (district, area, type, transaction, status, visibility, beds, price range, mandate status); fuzzy search box; "Add property" | all |
| `/properties/new` | Create wizard: Step 1 kind+type+district → generates reference; Step 2 core details | A, LM, AG |
| `/properties/[id]` | Detail with tabs: **Overview** (score ring, mandate badge, key status, price + history sparkline) · **Media** (upload, reorder, cover) · **Details** (areas, rooms, features; land panel when type=land) · **Legal** (deed/permit/share/encumbrances) · **Mandate & Keys** · **Marketing** (title/descriptions EN-EL-RU tabs) · **Documents** · **Activity** (event timeline) | all (edit per RLS) |
| `/properties/[id]/units` | Project only: units matrix, inline status, price list versions, payment plans, "Add unit" | A, LM |
| `/contacts` | List: search (name/phone/email), filters (type, temperature, source, agent, nationality, language); "Add contact" | all |
| `/contacts/new` | Form with live dedup check on phone/email | all |
| `/contacts/[id]` | Tabs per spec C3: Profile · Preferences · KYC & Banking (checklists with %) · Activity · Deals · Documents; Merge action (admin) | all |
| `/leads` | Inbox 📱: rows with response-clock chip, source icon, property/criteria summary; actions: claim, contacted, called, log conversation, convert, lost/spam | all |
| `/leads/[id]` | Lead detail + conversation log + convert panel | all |
| `/pipeline` | Kanban 📱-usable: deal-type tabs; drag between stages; deal cards (title, value, health dot, agent avatar, days-in-stage) | all |
| `/deals/[id]` | Deal drawer/page: parties, property, expected value, commission_split_notes (textarea), health panel with checklist, offers table + "Add offer", activity | per RLS |
| `/viewings` | Calendar (week/day) + list toggle; day route builder (drag order) | all |
| `/viewings/[id]` | Detail: parties, status actions, feedback form after completion | all |
| `/viewings/[id]/sign` | 📱 Slip signing: summary card → signature canvas → confirm → success + PDF link | AG (own), A |
| `/keys` | Key register: filter by status/holder; checkout/return dialogs | all |
| `/reports/commission-evidence` | Builder: pick contact (+ optional property/deal, date range) → preview event rows → Generate PDF → stored + downloadable | A, AG (own contacts/deals) |
| `/calculators` | Transfer fees + Stamp duty side by side; copy-summary button; config freshness line | all |
| `/settings` | Admin area, sub-nav: | A |
| `/settings/organization` | Name, logo, watermark upload | A |
| `/settings/users` | Invite (email+role), list, deactivate, reset 2FA | A |
| `/settings/stages` | Per deal type: rename/reorder/add; won/lost flags locked | A |
| `/settings/locations` | Districts & areas CRUD | A |
| `/settings/cyprus-config` | JSON-schema-driven editors for each config key; shows verified_at; save = event | A |
| `/tasks` | My tasks list 📱; done toggle; quick-add | all |

## Shell

- Sidebar: Dashboard, Leads, Pipeline, Properties, Contacts, Viewings, Tasks, Keys, Reports, Calculators, Settings(A). Collapsible; icons from lucide.
- Topbar: global fuzzy search (properties+contacts, ⌘K), quick-add menu (Property / Contact / Lead / Viewing), user menu.
- Mobile: bottom nav with Dashboard, Leads, Pipeline, Viewings, More.

## Dashboard contents

**Admin:** KPI row (open pipeline €, won this month €, new leads 7d, avg first-response 7d) · pipeline-by-stage bar · leads-by-source 30d · mandates expiring ≤30d table · latest events feed.
**Agent 📱:** today's viewings (tap→navigate/sign) · overdue tasks · my new leads with clocks · hot buyers idle ≥3d · quick actions.

## Empty/error states

Every list has: empty state with primary action, loading skeletons, error boundary with retry. Forms: zod messages inline; server errors as toast + field mapping.
