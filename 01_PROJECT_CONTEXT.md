# PROJECT_CONTEXT_v2.md
# GN Kalaitsidis Capital — Real Estate CRM & Property Operating System

**Revised Project Context (v2) — STANDALONE BUILD**

| | |
|---|---|
| Company | GN Kalaitsidis Capital / Kalaitsidis Capital, Paphos, Cyprus |
| Document status | v2 — supersedes v1 project context in full |
| Scope rule | This platform is **fully standalone**. No integrations with any external internal company tools (travel/logistics apps, transfer marketplaces, external investment modellers). Everything the CRM needs is built natively inside it. |
| Intended reader | Claude Code (autonomous implementation) + founder |

---

## 0. WHAT CHANGED — v1 → v2

### 0.1 REMOVED from v1

| Removed item | Reason |
|---|---|
| Integrated hospitality/transfer logistics (airport transfers, itinerary tracking for buyers/guests) | Out of scope. Platform is standalone real estate software. Travel arrangements are handled entirely outside the CRM. |
| Any dependency on external investment modelling tools | The Investment Calculator (Module 9) is built **natively** inside the CRM. No external engines. |
| Buyer/Investor portal logins | Buyers do not create accounts. Replaced with **no-login magic-link proposal pages** (tokenized URL, expiry date, per-open view tracking). |
| Marketing & Social Media Engine as a maintained module (v1 Module 16) | Replaced by lightweight auto-generated share/OG image cards from listing data + export of text/images for use in external design tools. Not a module to build and maintain. |
| Customizable dashboards (v1 Module 19) | Replaced by exactly **3 fixed dashboards**: Admin, Agent, Owner/Developer. No dashboard-builder. |
| Hotel/hospital-specific deal features | These are bespoke advisory mandates. Track them as generic pipeline deals with documents attached. Build nothing specific. |
| SumSub/Onfido KYC API in MVP | Deferred to Phase 3. MVP = structured **manual KYC checklist** per contact. Per-check API cost (~€1–2+) only justified at volume. |
| WhatsApp Business API in MVP | Deferred to Phase 3 (Meta template approval friction + per-conversation cost). MVP = click-to-chat links + manual conversation logging. |
| Lead-source ROI reporting | Deferred to Phase 3+. Requires marketing-spend tracking that will not exist at launch. Lead-source **counting** stays in MVP; ROI does not. |
| AI voice-note transcription | Confirmed removed (was already deprioritized in v1). |
| External portal XML/CSV feeds in early phases | Confirmed deferred to Phase 5 (was already deprioritized in v1). |
| Lawyer/bank platform logins | Confirmed removed. Replaced by secure expiring download links (v1 got this right — kept). |

### 0.2 ADDED in v2

| Added item | Why it matters | Phase |
|---|---|---|
| **Project → Phase → Unit hierarchy** in the property data model | Developer inventory is parent-child, not flat listings. Unit status matrix, versioned price lists, payment plan templates per project. Retrofitting later is extremely painful — this is a day-one schema decision. | 0–1 |
| **Append-only Event Log** as core architecture (not a bolt-on module) | The foundation of commission protection. Every contact touch, property share, viewing, offer, and status change writes an immutable event. Records only have evidentiary value if the log exists from the first line of code. | 0–1 |
| **Listing Mandate & Key Management** | Exclusive vs open mandate, commission %, agreement expiry, renewal alerts, physical key log (who holds key, key ID). Mandate discipline is a competitive advantage in the open-listing chaos of the Cyprus market and feeds directly into commission protection. | 1 |
| **Signed Digital Viewing Slip** | Buyer e-signs on the agent's phone: "viewed property X with agent Y on date Z." The single strongest commission-dispute weapon in Cyprus ("the buyer came to us directly"). | 1 (MVP) |
| **Reservation Agreement Generator** | Bilingual reservation agreements (deposit, terms, expiry) generated as DOCX + PDF via the established Node.js/docx pipeline. | 3 |
| **Reduced-VAT Eligibility Wizard** | Guided checker for 5% VAT primary-residence eligibility (area/value caps under post-2023 rules) producing a branded one-pager. Confuses every foreign buyer; genuine differentiator. Verify current legislation at implementation. | 3 |
| **Buyer Banking-Readiness Checklist** | For non-EU buyers: source-of-funds document status, sanctions screening result, bank account feasibility. Banking failures kill more deals than pricing. | 1 (checklist) / 3 (API) |
| **Antiparoxi (land-for-units exchange) deal type** | No commercial CRM models land-for-apartments exchanges. Simple deal template first (land value ↔ unit allocation), richer later. Moat feature. | 4 |
| **Land-specific property fields** | Planning zone code (e.g., Κα6, Τ1β), building density coefficient, coverage ratio, max allowed floors/height, road frontage, utilities availability, constraint notes (archaeology/forestry). Generic "plot size" is insufficient. | 1 |
| **Price history log per property** | Every asking-price change stored with date. Free negotiation intelligence. | 1 |
| **Comparables & Market Intelligence database** | Own closed deals + DLS transaction data + internal cost benchmarks → internal comps engine feeding pricing advice and proposals. Long-term the most defensible module in the system. | 4 |
| **Phone-first contact deduplication** | E.164 normalization (+357…), unique index on normalized phone, merge tool that preserves event history. Multi-source lead flow rots without it. | 1 |
| **Telegram alongside WhatsApp** | Russian-speaking clients live on Telegram. MVP: click-to-chat + manual logging for both channels. APIs later. | 1 (links) / 3 (API/bot) |
| **Email + calendar sync** | Viewings to calendar; correspondence logging. Basic and missing from v1. | 2–3 |
| **EXIF stripping + optional watermarking** in the media pipeline | Photo GPS metadata can expose an off-market owner's address — a real GDPR and confidentiality issue. Strip on upload, watermark on public renditions. | 1 |
| **Aftercare & lifecycle automation** | Completion anniversaries, annual "your property's market value" updates to past buyers → resales, rental-management leads, referrals at near-zero cost. v1's journey ended at "future resale opportunity" but nothing implemented it. | 3–4 |
| **Phase 0: data migration & numbering** | Audit current data (Excel, phone contacts, WhatsApp threads), import tooling, and a reference numbering scheme (e.g., `GNK-PAF-0001`) defined **before** Phase 1 build starts. | 0 |
| **PostGIS + pg_trgm** | Geo queries (sea distance, radius/amenity search) and fuzzy full-text search on properties/contacts. | 0–1 |
| **`org_id` column on every table** | Makes Stage 4 SaaS a migration instead of a rewrite. Costs nothing now. Nothing else about SaaS may influence v1 design. | 0 |
| **RLS policy test suite** | Supabase row-level security is easy to get subtly wrong; a mistake here means Owner A sees Owner B's offers. Automated tests per role. | 1 |
| **Background job runner** | pg_cron / Supabase scheduled Edge Functions (or Trigger.dev/Inngest if needed). v1 promised "automated follow-up" but nothing in the stack executed it. | 1 (basic) / 3 (full) |

### 0.3 CONFIRMED CORRECT in v1 (kept unchanged)

- Expiring secure links for lawyers/banks instead of logins.
- Manual text-entry commission splits in early phases (no dynamic accounting logic).
- Deferring external portal feeds until database hygiene and owned SEO are solid.
- Property Quality Score (0–100 completeness gate before publication).
- Lead Speed Monitor (first response < 5 min target).
- Buyer Psychology Profile segmentation.
- Build order: Internal CRM → Website engine → Automation → Portals → Feeds.
- Stack direction: Next.js + Supabase + Vercel.

---

## 1. Executive Summary

Build a **standalone** custom real-estate CRM and property operating system for GN Kalaitsidis Capital — the **GN Real Estate OS**. Not a generic CRM: a complete Cyprus-focused business operating system covering:

- Property inventory with developer Project → Unit hierarchy
- Buyer / seller / owner / developer / partner CRM
- Listing mandates and key management
- Lead capture, speed monitoring, and follow-up automation
- Visual sales pipeline with deal health scoring
- Viewing management with signed digital viewing slips
- Cyprus-specific legal/compliance workflow (title deeds, VAT, transfer fees, KYC/AML)
- Native investment analysis and proposal generation (EN/RU/GR)
- Owner/developer transparency dashboards
- Deal room with expiring third-party document links
- Commission protection built on an immutable event log
- Closed-circuit invite-only partner agent network
- AI-assisted matching, descriptions, and multilingual drafting (human-approved)
- Website + SEO listing engine powered directly by the CRM

Everything is designed around the practical reality of Cyprus deals: foreign buyers, multilingual communication, open-listing chaos, title-deed complexity, and banking friction for non-EU clients.

---

## 2. Company Context

GN Kalaitsidis Capital / Kalaitsidis Capital is a Cyprus-based real-assets and real-estate advisory company active in: real estate advisory, development, investment/wealth-related property strategy, property management (including short- and long-term rentals), development project support, deal structuring, buyer and seller representation, and Cyprus-focused opportunities for local and international clients (residential, luxury, commercial, land, and investment assets).

The platform must support **both** the agency side and the investment/development side.

### Core business needs

| Area | Business need |
|---|---|
| Property listings | Sales, rentals, land, developments, shops, luxury villas, investment assets |
| Buyers | Local, foreign, investor, relocation, family, retirement, luxury, non-EU clients |
| Owners | Individual owners, landlords, sellers, developers |
| Developers | Project units, availability, price lists, construction progress |
| Leads | Website, social media, referrals, partners, WhatsApp, Telegram, walk-in |
| Transactions | Offer → reservation → lawyers → bank → transfer → commission |
| Compliance | Title deeds, VAT status, transfer fees, KYC/AML (manual first, API later) |
| Communication | English, Russian, Greek |
| Reporting | Owner reports, agent performance, lead-source counts |
| Marketing | Website listings, SEO pages, share-image generation, email campaigns |
| Partnerships | Closed-circuit invite-only B2B network, manual commission splits |

---

## 3. Product Vision

Manage the full property journey inside one system:

**Property intake → mandate → listing preparation → publication → lead capture → buyer matching → viewing (signed slip) → offer → reservation → legal/bank process → completion → commission report → aftercare → future resale/rental.**

The system makes the company visibly more professional than standard agencies: faster lead response, cleaner owner reporting, stronger multilingual proposals, instant investment calculations, transaction transparency, evidentiary commission protection, and Cyprus-specific compliance logic.

---

## 4. Strategic Goal

- **Stage 1 — Internal Platform.** Team manages listings, mandates, leads, contacts, viewings, deals.
- **Stage 2 — Public Website + Owner/Developer Portals.** The CRM powers the company website, property search, inquiry forms, and owner/developer dashboards. Buyers get magic-link pages, not accounts.
- **Stage 3 — Automation + AI.** AI listing descriptions, buyer matching, proposal PDFs, lead scoring, automated follow-up, KYC API, messaging APIs.
- **Stage 4 — SaaS potential.** If successful, productize for other Cyprus agencies/developers/property managers. Until then, SaaS influences **only one thing**: the `org_id` column on every table.

---

## 5. Main User Types

| User type | Needs | Access |
|---|---|---|
| Admin / Business owner | Full control, reporting, financials, permissions, strategy dashboard | Full login |
| Sales agent | Leads, buyers, viewings, follow-up, matching, viewing slips | Login (role-limited) |
| Listing manager | Property uploads, media, documents, descriptions, publishing | Login (role-limited) |
| Property owner | Enquiries, viewings, marketing activity, offers, reports | Portal login (Phase 4) |
| Developer | Unit availability matrix, sales progress, buyer interest, project performance | Portal login (Phase 4) |
| Buyer / investor | Proposals, comparisons, cost/ROI breakdowns, document checklist | **No login** — magic-link pages |
| Partner agent | Selected listings without owner data, buyer submission, cooperation tracking | Invite-only portal (Phase 4) |
| Lawyer / bank contact | Transaction documents | **No login** — secure expiring download links |

---

## 6. Core Data Architecture (NEW in v2 — read before building)

### 6.1 Primary entities

`organizations` → `users` (roles) → everything below carries `org_id`.

- **properties** — the central table (all types). Self-referencing hierarchy: a property row can be a **Project**, a **Phase/Block** (parent = project), or a **Unit** (parent = phase/project). Standalone resale listings are simply rows without a parent.
- **projects extras** — price list versions, payment plan templates, construction progress milestones (linked to project rows).
- **mandates** — listing agreements: type (exclusive/open), commission %, start/expiry, renewal reminder, signed document, status. One property → many mandates over time.
- **keys** — physical key register: key ID, holder, checkout/return log (writes events).
- **contacts** — people and companies. Normalized E.164 phone (unique per org), language, nationality, type(s), preferences, psychology profile, source, consent, KYC checklist status, banking-readiness checklist.
- **leads** — inbound enquiries linked to contact + property/criteria; source, channel, first-response timestamps (Lead Speed Monitor).
- **deals** — pipeline records: type (`sale`, `rental`, `antiparoxi`, `advisory`), stage, health score, participants, manual commission-split text fields.
- **viewings** — schedule, attendees, route order, feedback form, **signed slip** (signature image + SHA-256 hash + timestamp + optional geolocation).
- **offers** — amount, terms, status history.
- **documents** — typed files (title deed, permits, contracts, IDs, valuations, plans) with visibility level and share-link support.
- **share_links** — tokenized expiring links (proposal pages, lawyer/bank document links) with per-open tracking events.
- **events** — see 6.2.
- **price_history** — property_id, old/new asking price, date, author.
- **comparables** — (Phase 4) own closed deals + DLS records + cost benchmarks.

### 6.2 The Event Log (architectural spine)

Append-only table `events`: `id, org_id, occurred_at, actor_id, entity_type, entity_id, event_type, payload jsonb`.

Rules:
1. No `UPDATE` or `DELETE` grants on this table for any role. Ever.
2. Every module writes to it: contact created, property shared, link opened, viewing held, slip signed, offer made, stage changed, price changed, key checked out.
3. Commission-protection reports (Module 6) are **generated from this log**, never hand-assembled.
4. Optional hardening: hash-chain each row (`hash = sha256(prev_hash + row)`) for tamper evidence.

### 6.3 Reference numbering (defined in Phase 0)

Pattern: `GNK-{DISTRICT}-{SEQ}` (e.g., `GNK-PAF-0001`, `GNK-LIM-0042`); units: `GNK-PAF-0007-B203`. Immutable once assigned; used on website, documents, and in conversation.

### 6.4 Cyprus-specific property fields

All types: title deed status (separate / pending / shared / none), permit status, share of land, encumbrance notes, VAT status (new/resale, eligible for reduced rate), sea distance, map coordinates (PostGIS point).

**Land additions:** planning zone code, building density coefficient, coverage ratio, max floors/height, road frontage (m), water/electricity availability, constraint notes.

---

## 7. Platform Modules (v2, renumbered)

| # | Module | Summary | Phase |
|---|---|---|---|
| M1 | **Property Inventory & Media** | Central database, Project→Unit hierarchy, land fields, price history, Property Quality Score (0–100 publication gate), media pipeline (upload → EXIF strip → resize/WebP → optional watermark → CDN). | 1 |
| M2 | **Mandates & Keys** | Exclusive/open mandates, commission %, expiry + renewal alerts, signed agreement storage, physical key register. | 1 |
| M3 | **Contact CRM** | Dedup (phone-first, merge tool), identity/type/preferences/source, Buyer Psychology Profile (Investor = ROI/resale · Relocation = schools/safety · Luxury = privacy/design), consent tracking, KYC checklist, banking-readiness checklist. | 1 |
| M4 | **Lead Management** | Multi-channel capture (website, referral, partner, WhatsApp/Telegram click-to-chat logging, walk-in), Lead Speed Monitor (first response < 5 min / first call same day), assignment rules. | 1 |
| M5 | **Visual Sales Pipeline** | Drag-and-drop stages per deal type (incl. `antiparoxi` template in Phase 4), Deal Health Score (budget confirmed · legal status · recent activity), manual commission-split fields. | 1 |
| M6 | **Event Log & Commission Protection** | Architecture per §6.2 + exportable PDF evidence reports: first contact, properties sent, link opens, viewings + signed slips, offers. | 1 |
| M7 | **Viewing Management** | Calendar, agent route planner, client/owner reminders, feedback forms, **Signed Digital Viewing Slip** (canvas signature on agent phone, hashed + timestamped, written to event log, PDF export). | 1 |
| M8 | **Cyprus Compliance Engine** | Title deed tracker per property; transfer fee calculator; stamp duty calculator; **Reduced-VAT Eligibility Wizard** with branded one-pager; CGT estimate for sellers; manual KYC/AML checklist (→ SumSub/Onfido API in Phase 3). All rates stored in a config table, verified against current legislation at implementation. | 1 core / 3 wizard+API |
| M9 | **Investment Calculator (native)** | Buyer-side: full acquisition cost breakdown (price, VAT **or** transfer fees, stamp duty, legal), gross/net rental yield, ROI, payback, simple financing scenario. Branded multilingual PDF output. Built natively — no external engines. | 3 |
| M10 | **Proposal & Document Generator** | Multilingual (EN/RU/GR) buyer proposals by profile (Investment/Luxury/Relocation), reservation agreements, viewing confirmations — DOCX + PDF via the established Node.js/docx pipeline. Delivered as **magic-link pages** with open tracking + expiry. | 2 basic / 3 full |
| M11 | **AI Property Matching** | Buyer ↔ property match score (0–100%) on budget, area, type, features, legal status; ranked suggestions with human review. | 3 |
| M12 | **Multilingual AI Communication Assistant** | Drafts WhatsApp/Telegram replies, descriptions, emails in EN/RU/GR. **Human approval required before anything is sent.** | 3 |
| M13 | **Owner / Developer Dashboards** | Owner: listing status, views, link opens, viewing feedback, offers. Developer: unit availability matrix, sales velocity, buyer interest. Read-mostly portals. | 4 |
| M14 | **Deal Room / Transactions** | Secure internal transaction space (admins, agents, buyer/seller records). Lawyers/banks receive **secure, trackable, expiring download links** — no logins. | 2–3 |
| M15 | **Partner Network (Closed-Circuit B2B)** | Strict invite-only. Partners see shared listings **without owner data**, submit buyers, track cooperation. Splits = manual text fields. | 4 |
| M16 | **Website & SEO Listing Engine** | Public Next.js site fully powered by the CRM: listing pages, area intelligence pages, schema.org markup, hreflang EN/RU/GR, sitemap, anti-spam inquiry forms, auto-generated OG/share image cards. | 2 |
| M17 | **Listing Visibility System** | Levels: Public · Private · VIP-only · Partner-only · Off-market · Coming soon · Sold/Rented. Enforced by RLS + website queries. | 1 |
| M18 | **Reports & 3 Fixed Dashboards** | Admin (revenue, pipeline, productivity, lead-source counts) · Agent (today's workflow, hot buyers, overdue follow-ups) · Owner/Developer (per M13). No dashboard builder. | 1 basic / 4 full |
| M19 | **Comparables & Market Intelligence** | Own closed transactions + DLS data + cost benchmarks; €/m² comps by area/type feeding pricing advice and proposals. | 4 |
| M20 | **Aftercare & Lifecycle** | Completion anniversaries, annual market-value updates to past buyers, rental-management upsell prompts, referral asks. Runs on the job runner. | 3–4 |
| M21 | **Security, GDPR & Permissions** | Role-based access, RLS **with automated policy tests**, 2FA, audit via event log, GDPR consent + erasure workflow (anonymize contact, preserve non-personal event skeleton), EU-hosted encrypted data. | Cross-cutting from Phase 0 |

---

## 8. Technology Stack (v2)

| Layer | Choice | Notes |
|---|---|---|
| Frontend | **Next.js (App Router) + TypeScript + Tailwind CSS** | Matches existing conventions. |
| i18n | **next-intl** — locales `en`, `el`, `ru` | UI + generated documents. |
| Backend & DB | **Supabase** (PostgreSQL, Auth, RLS, Realtime, Storage) | Realtime for pipeline/dashboards; RLS for portals + GDPR. |
| Geo & search | **PostGIS** (sea distance, radius/amenity queries) + **pg_trgm** (fuzzy search on properties/contacts) | Enable extensions in Phase 0. |
| Hosting | **Vercel** | Edge network; GitHub (hugelifecy-arch) CI/CD. |
| Media pipeline | Supabase Storage + **Sharp on upload**: EXIF strip → resize → WebP/AVIF renditions → optional watermark → CDN delivery | Confidentiality + performance. |
| Email | **Resend** | Transactional + owner reports. |
| Messaging | Phase 1: WhatsApp/Telegram click-to-chat + manual logging. Phase 3: WhatsApp Business API + Telegram Bot API | Telegram is first-class, not an afterthought. |
| Documents | Existing **Node.js/docx** pipeline (build → validate → convert → preview → deliver) for DOCX; **HTML→PDF (Puppeteer serverless) or @react-pdf** for proposals/reports | Reuse proven pipeline. |
| E-signature (viewing slips) | Native canvas signature capture + SHA-256 hash + timestamp stored in event log | Simple e-signature is adequate as commission evidence; formal contracts remain wet-ink/qualified. |
| Jobs & automation | **pg_cron / Supabase scheduled Edge Functions**; upgrade to Trigger.dev or Inngest if workflows outgrow cron | Executes follow-ups, mandate expiry alerts, aftercare. |
| KYC/AML | Phase 1: manual checklist. Phase 3: **SumSub or Onfido API** | Cost-gated. |
| Monitoring & analytics | **Sentry** + privacy-friendly analytics (Plausible/Umami) | GDPR-clean. |

---

## 9. Build Phases

**Phase 0 — Foundations (before any feature code)**
Data audit (current Excel/phone/WhatsApp sources) + import tooling plan · reference numbering scheme · full schema design (Project→Unit, events, mandates, `org_id` everywhere) · PostGIS/pg_trgm enabled · RLS strategy + test harness · repo/CI setup.

**Phase 1 — Internal CRM MVP (target 8–10 weeks)**
M1 (inventory + hierarchy + media pipeline + quality score) · M2 (mandates + keys) · M3 (contacts + dedup + consent + checklists) · M4 (leads + speed monitor) · M5 (pipeline on event log) · M6 (event log + evidence reports) · M7 (viewings + signed slip) · M17 (visibility levels) · M18 (basic Admin/Agent dashboards) · M21 (RLS + tests, 2FA).

**Phase 2 — Public Website + Listing Engine**
M16 (site powered by CRM, SEO routing, area pages, inquiry capture) · basic magic-link proposal pages · M14 expiring document links · email/calendar sync (basic).

**Phase 3 — Documents, Compliance & Automation**
M10 full generators (proposals, reservation agreements) · M9 investment calculator + PDFs · M8 VAT wizard + KYC API · M11 matching · M12 AI assistant (human-approved) · WhatsApp API + Telegram bot · follow-up automation · M20 aftercare (start).

**Phase 4 — Portals, Partners & Intelligence**
M13 owner/developer portals · M15 closed-circuit partner network · M19 comparables engine · antiparoxi deal templates · full M18 reporting.

**Phase 5 — Feeds & Scaling**
External portal XML/CSV feeds · advanced accounting/commission automation · SaaS multi-tenancy activation (org onboarding, billing).

---

## 10. MVP Definition

### Essential (Phase 1 ships with all of these)

| Feature | Module |
|---|---|
| Property database with Project→Unit hierarchy + CDN media pipeline (EXIF strip) | M1 |
| Property Quality Score publication gate | M1 |
| Mandates (type, %, expiry, alerts) + key register | M2 |
| Contact CRM with phone-first dedup, consent, KYC + banking checklists | M3 |
| Lead inbox + Lead Speed Monitor + click-to-chat logging (WA/TG) | M4 |
| Drag-and-drop pipeline + Deal Health Score + manual split fields | M5 |
| Append-only event log + commission evidence PDF export | M6 |
| Viewing scheduler + **signed digital viewing slip** | M7 |
| Title deed tracker + transfer fee/stamp duty calculators | M8 |
| Visibility levels incl. off-market | M17 |
| Admin + Agent fixed dashboards (basic) | M18 |
| RLS with automated tests, 2FA, GDPR consent | M21 |

### Important (Phase 2–3)

Website listing engine + SEO · magic-link proposal pages · document generators (proposals, reservation agreements) · investment calculator PDFs · VAT wizard · buyer matching · AI drafting (human-approved) · expiring lawyer/bank links · aftercare automation.

### DO NOT BUILD FIRST

| Item | Instead |
|---|---|
| Complex automated commission splits | Manual text fields until Phase 5 |
| AI voice-note transcription | Out of scope |
| External portal XML feeds | Phase 5 |
| Lawyer/bank logins | Expiring links only |
| Buyer/investor logins | Magic-link pages only |
| KYC API | Manual checklist until Phase 3 |
| WhatsApp Business API | Click-to-chat until Phase 3 |
| Dashboard builder | 3 fixed dashboards |
| Social media content module | Auto OG cards + export only |
| Lead-source ROI (spend-based) | Source counting only until Phase 3+ |

---

## 11. Unique Selling Points (v2)

1. **Cyprus-native compliance** — title deeds, VAT (incl. reduced-rate wizard), transfer fees, stamp duty, local legal workflow.
2. **Evidentiary commission protection** — immutable event log + signed digital viewing slips + one-click dispute PDF. Nobody else in the market has this.
3. **Non-EU buyer readiness** — KYC + banking-readiness checklists that prove buyer validity to developers and pre-empt bank failures.
4. **Developer-grade inventory** — true Project→Unit hierarchy with availability matrix and versioned price lists.
5. **Closed-circuit B2B network** — off-market assets traded among vetted professionals without exposing owner data.
6. **Multilingual, investment-focused output** — instant ROI/yield/cost-breakdown proposals in EN/RU/GR.
7. **Owner transparency** — real dashboards showing views, link opens, feedback, offers.
8. **Antiparoxi support** — the only system that models land-for-units deals.
9. **Comparables intelligence** — proprietary €/m² comps from own deals + DLS data.

---

## 12. Guardrails & Principles

1. **Standalone.** No external internal-tool integrations of any kind. Everything native.
2. **Internal first, ruthlessly.** Build for the company's own operation; the product story comes later.
3. **Event log before features.** Nothing ships in Phase 1 that doesn't write its actions to `events`.
4. **`org_id` everywhere, SaaS nowhere else.** No other multi-tenant complexity in v1.
5. **No buyer logins. No lawyer logins.** Links, not accounts, for anyone outside the team/owners/partners.
6. **Human approval on all AI output.** Nothing AI-drafted is sent or published automatically.
7. **All Cyprus rates/thresholds in a config table** (VAT %, transfer fee bands, stamp duty, CGT) — verified against current legislation at implementation, changeable without code deploys.
8. **RLS is tested, not trusted.** Every role/visibility combination has an automated test.
9. **Three fixed dashboards.** Resist dashboard-builder scope creep.
10. **Do-Not-Build list is binding** until its listed phase.

---

## 13. Implementation Notes for Claude Code

- Repo: Next.js App Router · TypeScript strict · Tailwind · next-intl (`en`/`el`/`ru`) · Supabase client with generated types · Vercel deploy from GitHub (hugelifecy-arch).
- Migrations: SQL migration files in-repo; enable `postgis`, `pg_trgm`, `pg_cron` in the first migration; `events` table created in the first migration with no UPDATE/DELETE grants.
- Every table: `org_id uuid not null`, `created_at`, `created_by`; RLS enabled by default.
- Seed data: districts (Paphos, Limassol, Larnaca, Nicosia, Famagusta), property types, deal stages per deal type, document types, Cyprus rate config table.
- Deliverables per phase: complete replacement files, migration + rollback, RLS tests, and a short verification checklist — no partial diffs.
