# 06 — UI DESIGN SYSTEM

Professional, calm, high-density-capable interface for daily internal use. shadcn/ui + Tailwind. **Brand tokens are centralized — changing the palette must be a one-file edit** (the CSS variables in `app/globals.css`, mapped to Tailwind colours by its `@theme inline` block — Tailwind v4 has no `tailwind.config.ts`) plus the matching line below.

## Brand tokens (v1 defaults — replace with final Kalaitsidis Capital brand when supplied)

```css
:root {
  --brand-950: #0B1F33;  /* deep navy — sidebar, headers */
  --brand-900: #10293F;
  --brand-700: #1F4E79;  /* primary actions, links */
  --brand-500: #2E6DA4;
  --brand-100: #D9E2F3;  /* selected states, soft fills */
  --accent-500: #B08D57; /* bronze/gold FILLS — sparing: KPIs, score ring; never body text */
  --accent-700: #7E6237; /* bronze TEXT — VIP */
  --success: #1E7F4F; --warning: #975A16; --danger: #B42318;
  --surface: #FFFFFF; --surface-2: #F6F8FB; --border: #E4E9F0;
  --text-1: #101828; --text-2: #475467; --text-3: #667085;
  --radius: 10px;
}
```

Every token that is set as text — `text-1/2/3`, `brand-700`, `brand-500`, `success`, `warning`, `danger`, `accent-700` — measures at least 4.5:1 on `--surface` and on `--surface-2` by the WCAG contrast formula, and `--warning` keeps 4.5:1 on its own 10% tint (the warning-notice idiom). These are formula measurements held by `tests/unit/palette-parity.test.ts`, not a claim of WCAG conformance. `--warning` was `#B7791F` until 2026-10-18 (3.64:1 as text, under the Reserved / Under offer / Contacted badges). `--accent-500` measures 3.09:1, so bronze text uses `--accent-700`; `--accent-500` stays for fills, rings and icons.

Dark mode: not in Phase 1 (backlog).

## Typography

- Font: **Inter** (next/font, subsets latin+greek+cyrillic — RU/EL data renders correctly).
- Scale: 12 caption · 13 table body · 14 body · 16 section title · 20 page title · 28 KPI numeric.
- Numbers in tables/KPIs: `tabular-nums`.

## Layout rules

- Sidebar 248px (`--brand-950`, white text), collapses to 64px icons; content max-width 1440 centered; page padding 24.
- Cards: white, 1px `--border`, radius 10, shadow-sm only.
- Tables: sticky header, row height 44, hover `--surface-2`, right-align numerics.
- Forms: 2-column grid ≥1024px, single column below; labels above fields; section dividers with 16px titles.

## Signature components (build once in `components/features/shared/`)

| Component | Spec |
|---|---|
| `StatusBadge` | Colored dot + label; maps every enum (property_status, mandate_status, lead_status, viewing_status, offer_status) from one config object |
| `QualityScoreRing` | 40px ring; <50 danger, 50–69 warning, ≥70 success; tooltip lists missing items from score service |
| `ResponseClock` | Chip: green <5m, amber <60m, red ≥60m, grey answered; live-updating |
| `MandateBadge` | exclusive=green, open=amber, expired=red outline, none=grey dashed |
| `HealthDot` | Deal health: ≥70 green, 40–69 amber, <40 red; tooltip shows factor breakdown |
| `EventTimeline` | Vertical timeline; icon per event_type; relative + absolute time; payload summary line |
| `MoneyInput` / `Money` | EUR formatting `€1.234.567`; parses pasted values |
| `PhoneInput` | libphonenumber live formatting; flag; stores E.164 |
| `MultilangTabs` | EN/EL/RU tab wrapper for jsonb text fields; per-tab filled indicator |
| `SignaturePad` | Canvas, thick stroke, clear/undo, exports PNG ≥ 600×240 |
| `EntityPicker` | Async combobox for contact/property (search by name/phone/reference); shows avatar/thumb + secondary line |

## Interaction rules

- Every mutation: optimistic where safe, toast on success (`"Saved"` bottom-right), inline errors otherwise.
- Destructive-ish actions (archive, terminate mandate, mark lost) → confirm dialog with reason field where schema stores one.
- Kanban drag uses `@dnd-kit`; drop animates card, stage counts update instantly.
- Keyboard: ⌘K global search; `n` on list pages = new record. On a phone (below `sm`) the header shows an icon-only "Search" button that opens the same dialog.
- Focus: every keyboard-focusable element shows a solid 2px `--ring` outline 2px out (white on the navy sidebar and drawer), from one rule in `app/globals.css` `@layer base`. The `components/ui` primitives keep their own `outline-none` + ring and are not double-ringed; tab triggers keep their own outline. A custom control needs no focus classes of its own.
- Navigation: the sidebar is `<nav aria-label="Main">` and the settings tabs `<nav aria-label="Settings sections">`; the current page's link carries `aria-current="page"` (a module link on one of its sub-pages carries `aria-current="true"`), so the state is not colour alone. Each settings section opens with an `<h2>` naming it, under the page's `<h1>Settings</h1>`.
- Filter bars without visible labels name every control with `aria-label` (the keys and leads filters are the pattern).
- All timestamps display Asia/Nicosia with tooltip UTC.

## Tone

No decorative illustrations. Empty states: one sentence + one button. The product should feel like a private-bank back office: quiet, precise, fast.

Business words first; the system's words behind a disclosure. A status, a banner or an error leads with a plain sentence an agent can act on — "Desk alert not sent — the mail service refused it", "This page could not load", "Background jobs: 1 of 12 needs attention — Mandate expiry". Result codes, job and key names, attempt counters, migration numbers and raw error messages go in `TechnicalDetails` (`components/features/shared/technical-details.tsx`, a native `<details>` "Technical details"), never in the sentence: they are what support needs quoted, not what the screen leads with. Error boundaries say "This page could not load" with the error's digest as the reference to quote (`PageLoadError`). Screen copy does not name the machinery — sweep, worker, outbox, row, migration, guardrail; it says what happens ("the nightly check", "closes automatically overnight").
