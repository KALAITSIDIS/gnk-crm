# 06 — UI DESIGN SYSTEM

Professional, calm, high-density-capable interface for daily internal use. shadcn/ui + Tailwind. **Brand tokens are centralized — changing the palette must be a one-file edit** (`app/globals.css` CSS variables + `tailwind.config.ts` mapping).

## Brand tokens (v1 defaults — replace with final Kalaitsidis Capital brand when supplied)

```css
:root {
  --brand-950: #0B1F33;  /* deep navy — sidebar, headers */
  --brand-900: #10293F;
  --brand-700: #1F4E79;  /* primary actions, links */
  --brand-500: #2E6DA4;
  --brand-100: #D9E2F3;  /* selected states, soft fills */
  --accent-500: #B08D57; /* bronze/gold — sparing: KPIs, VIP, score ring */
  --success: #1E7F4F; --warning: #B7791F; --danger: #B42318;
  --surface: #FFFFFF; --surface-2: #F6F8FB; --border: #E4E9F0;
  --text-1: #101828; --text-2: #475467; --text-3: #98A2B3;
  --radius: 10px;
}
```

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
- Keyboard: ⌘K global search; `n` on list pages = new record.
- All timestamps display Asia/Nicosia with tooltip UTC.

## Tone

No decorative illustrations. Empty states: one sentence + one button. The product should feel like a private-bank back office: quiet, precise, fast.
