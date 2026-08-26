# BACKLOG

Nice-to-haves and deferred items noticed during the build. Nothing here gets
built without explicit direction.

> ## ⚠️ AN ENTRY HERE IS A CLAIM, AND CLAIMS GO STALE SILENTLY
>
> **Three entries in this file described work that had already shipped.** One had
> said so for **18 days** and sent a session on 2026-08-11 to rebuild the CSV
> exports — six routes, five query modules and seven E2E specs that had existed
> since 2026-07-24. It was caught by a `ls` before any code was written, not by
> reading. The others: database-level 2FA (shipped that morning) and the
> Settings → Users 2FA column (shipped two days earlier).
>
> **So: RUN THE `VERIFY:` LINE BEFORE YOU START ANYTHING.** Every entry that
> describes buildable work carries one — a single command whose output settles
> whether the work exists. If an entry has no `VERIFY:`, treat it as unverified
> and check by hand before believing it.
>
> **When you ADD an entry, add its `VERIFY:` line, and run it first.** A check
> you have not executed is a guess. Writing these on 2026-08-11, the naive dark
> mode check (`grep next-themes`) reported a hit — from shadcn's toast
> boilerplate, not from any dark mode. The command has to distinguish the thing
> from things that merely mention it.
>
> **When you FINISH an entry, strike it through and say what shipped**, with the
> commit. Do not delete it: a struck-through entry is what stops the next person
> re-proposing the same work.

## How to read this file

**Five different things live here and they look alike.** The warning above
counts three entries that described already-shipped work; on 2026-08-25 a fourth
was found, and it failed differently. Nothing was stale — the *state* was simply
not mechanically distinguishable. A preserved pre-fix entry read as outstanding
work and a session rebuilt the contact portfolio tab, which had shipped four
days earlier.

**`VERIFY:` did not save that one, because a preserved original does not carry
one.** Hence this table and the `(original)` markers: the check above tells you
whether an entry is DONE, and this tells you whether it is an entry at all.

| Looks like | Means |
|---|---|
| `- ~~**Title**~~ **SHIPPED …**` | Done. The text after the strikethrough says when, and usually what it cost. |
| `  - **Title (original).**` — indented, under a struck entry | The pre-fix text, kept deliberately as a cautionary record. **Not work.** |
| `- **Title, S/M.**` | Genuinely outstanding. |
| `- **Title — NEEDS AN OPERATOR DECISION**` | Blocked on a person, not on effort. |
| `- **NOTE — …**` | A standing gotcha, rule or known flake. **Never work.** Kept because forgetting it costs a cycle. |

**The recipe that returns only outstanding work** — it excludes struck items,
preserved originals, and anything indented under a parent:

```bash
grep -n '^- \*\*' docs/BACKLOG.md | grep -v '(original)' | grep -v 'HISTORICAL' | grep -v 'NOTE —'
```

Drop the last filter to see the standing notes too — they are worth reading
before starting anything, just never worth building.

**When an item appears in two sections, close BOTH.** That is how the duplicate
survived: the numbered finding was struck through and the one-line proposal in
"Proposals that came out of the same read" was not.

**Audited 2026-08-25** by running every `VERIFY:` command in the file. Every one
still reported "not built", so no entry that CARRIED a check was wrong — the
backlog's verifiable claims were accurate. The two closed below had no `VERIFY:`
of their own, which is the pattern: what goes stale is what nothing checks. The
other problem was that the file's STATES were not mechanically distinguishable,
which is what this section and the `(original)` markers fix. At that date the genuinely outstanding BUILD items
were three: owner net ↔ asking ↔ commission, construction progress + delivery
date, and the rest of the property-map shortlist. Everything else open is an
operator decision or a standing note.

**Two entries were closed by that audit, and one of them matters.** The RLS
helper hoist was resolved in its body but never struck at the title. The dormant
admin was worse: it warned of an admin with no second factor and no recent
sign-in, and production now shows BOTH admins carrying a verified factor and
signing in within the week. That entry was stale in the dangerous direction —
describing an exposure that had already closed itself. **Re-measure a security
claim before acting on it; this file records what was true when it was
written.**

## Properties module audit — 2026-08-21

Fifteen findings from a full read of M1 (properties, mandates, units, media,
export) against the code, not against this file. **Ranked by cost to the desk.**
Every VERIFY line below was RUN before it was written down.

Two things are worth saying before the list. **The schema already models what
the desk needs and the application does not use it** — `owner_contact_id` and
`developer_contact_id` have existed since `0001` and no screen writes or reads
either. And **finding 1 is a defect, not a nice-to-have**: it locks agents out
of properties they are supposed to work, and the standing "build nothing new"
decision (HANDOFF §5) does not cover it.

- ~~**1. A property can never be assigned to an agent — DEFECT.**~~ **SHIPPED
  2026-08-21 (`cf15794`)** — a Parties panel on the property Overview, admin +
  listing manager only. **Proven against the local stack, not reasoned about:**
  an agent got the read-only fieldset on an unassigned property, could edit and
  save once assigned (event attributed to her), and a forced submit of the
  parties section as that agent was refused server-side with nothing written and
  no phantom event. E2E in `tests/e2e/property-parties.spec.ts`.
  The original entry follows.

  - **1. A property can never be assigned to an agent — DEFECT. (original).**
  `assigned_agent_id` is written in exactly one place, `lib/actions/properties.ts:67`,
  and only when the creator is an *agent* (self-assign, because the insert policy
  demands it). Nothing else in the app ever sets it: no picker, no bulk action,
  no import column. That column is load-bearing for RLS —
  `0002_rls_policies.sql:164` (properties_update) and `:173` (property_media_insert)
  both admit an agent only when `assigned_agent_id = auth.uid()`. **So every
  property created by an admin or a listing manager is permanently uneditable by
  every agent, and no agent can add a photo to it.** The save even returns
  "Nothing was saved — this property isn't assigned to you", an error whose cure
  does not exist in the product. Fix: an assignment control (admin + LM only —
  an agent must not be able to hand their own property away and lock themselves
  out, since the UPDATE with-check only tests `org_id`).
  **VERIFY:** `grep -rn "assigned_agent" components/features/properties` — any
  write means shipped. *(0 hits on 2026-08-21; one read at `app/(app)/properties/[id]/page.tsx:136`.)*

- ~~**2. Owner and developer are unreachable from the UI.**~~ **SHIPPED
  2026-08-21 (`cf15794` + `cf962fb`)** — both columns are written by the Parties
  panel; migration `0034` backfills `owner_contact_id` from each property's
  newest ACTIVE mandate; `saveMandate` keeps them in step going forward but only
  ever fills a BLANK, so a hand-set owner is never overwritten. `0034` writes one
  system event per row changed and `verify_events_chain()` still returns true
  after it. **Applied to LOCAL only — hosted is still on 0033** and would
  backfill exactly 1 property (measured 2026-08-21). The original entry follows.

  - **2. Owner and developer are unreachable from the UI. (original).**
  `properties.owner_contact_id` is written only by `scripts/import/properties.mts:213`.
  `properties.developer_contact_id` is written by nothing — its only hit outside
  the generated types is `lib/actions/merge-contacts.ts:128` repointing a column
  no screen fills. Neither is displayed on the detail page, the list, the map or
  the export. The only owner the app knows is `mandates.owner_contact_id`, so a
  property with no mandate has no owner anywhere, and "everything this developer
  has" is unanswerable. Fix: a Parties section on the detail page, both columns
  in the create wizard, and a backfill of `owner_contact_id` from the active
  mandate's owner where null.
  **VERIFY:** `grep -rn "developer_contact_id" app components lib/actions | grep -v merge-contacts`
  — any hit means shipped. *(0 on 2026-08-21.)*

- ~~**3. Units flood the properties list.**~~ **SHIPPED 2026-08-21** — a `kind`
  filter in `propertyFiltersSchema` plus `resolvePropertyKindScope`, applied in
  `applyPropertyListFilters`, so the list, the CSV export AND the map inherit it
  from one place. **Units are hidden by default and the select SAYS SO** — it
  reads "Standalone & projects", not "All kinds", because a default that
  silently removes rows is a trap and one the user can see is a choice. An
  explicit `kind=unit` wins, same escape hatch as the retired scope: a filter
  that returns nothing when you pick it is a broken filter. Measured against a
  project with 5 real units — default list 3 rows, `?kind=unit` 5 rows, and the
  CSV agrees with both. The original entry follows.

  - **3. Units flood the properties list. (original).**
  `propertyFiltersSchema` (`lib/validators/properties.ts:132`) has no `kind`
  field, so units, phases, projects and standalone listings share one list,
  ordered `created_at desc`, 25 per page. One 60-unit project buries two and a
  half pages of real listings, and does the same to the CSV export and the map.
  Fix is one enum in the schema, one `Select` in the filter bar, and a default
  scope of standalone + project so units are reached through their project.
  **VERIFY:** `grep -c "kind:" lib/validators/properties.ts` — `1` = only the
  create schema has it, so the filter is missing. *(1 on 2026-08-21.)*

- ~~**4. Versioned price lists are write-only.**~~ **DONE 2026-08-21, both
  halves.** A version expands to the prices it holds, with the delta against the version
  before it. `list_price` had been written by every snapshot since `0001` and
  selected by nothing.

  The collapsed row already answers the two questions worth asking — "66 units ·
  61 repriced · €19.058.000 · +€313.000" — and expanding gives Unit / Price /
  Was / Change per unit.

  **A first version gets null deltas, not zeroes.** A fabricated 0 reads as "we
  held the price", which is a different statement from "there was no previous
  price". **Dropped units are COUNTED and called out**, because a unit in the old
  version and not the new one means the two totals no longer cover the same
  inventory and are not comparable. Collapsed by default: six versions of sixty
  units is 360 rows nobody asked for on page load.

  **Still open, and the other half of the original entry: APPLYING an uplift.**
  Reading a version is done; minting the next one by applying a % or fixed
  change to a selection is not — today you edit unit prices and snapshot.
  **VERIFY:** `grep -rn "list_price" app components lib/services` — 0 hits means
  the read half was reverted. The original entry follows.

  - **4. Versioned price lists are write-only (original).**
  `createPriceListVersion` snapshots every unit price into
  `price_list_items.list_price` (`lib/actions/units.ts:200`). **That column is
  never selected again.** `app/(app)/properties/[id]/units/page.tsx:52` reads
  `price_list_items(unit_id)` purely for a count, so the UI can say version 3
  covers 40 units and cannot show one price in it. A snapshot nobody can read is
  storage, not a record — and "what did we quote in March" is the entire point of
  versioning for a developer. Fix: read a version, diff it against the previous
  one per unit, and apply a % or fixed uplift to a selection to mint the next.
  **VERIFY:** `grep -rn "list_price" app components` — 0 hits means still
  write-only. *(0 on 2026-08-21.)*

- ~~**5. A unit inherits five fields from its project.**~~ **DONE 2026-08-21 —
  both halves.**
  `createUnit` now copies **19** columns via `resolveInheritedUnitFields`
  (`lib/services/unit-inheritance.ts`), including the developer, owner, agent,
  VAT, deed and permit status, energy class, delivery date, construction status,
  coordinates, features and amenities. The `created` event lists what was
  inherited, so "where did this come from" has an answer in the timeline.

  **`visibility` is deliberately NOT inherited and that is the load-bearing
  part.** A `public` project would otherwise mint already-published units with
  no photos, no price and no description — straight past the quality gate every
  other publish goes through. Proven in the app, not assumed: project flipped to
  `public`, new unit came out `private` with score 0.

  **The drift half shipped too.** Migration `0035` adds
  `properties.inherited_fields text[]`; a unit edit removes the changed column
  from it (only CHANGED ones — the details form posts twenty-odd columns per
  save, so dropping everything it touched would sever a unit's whole inheritance
  the first time anyone pressed Save); and the units page carries a panel
  computed fresh on every render — no stored "pending sync" state to go stale —
  offering ONE BUTTON PER FIELD. "Sync everything" reads as one decision but is
  several, and the one nobody meant to make is the one that hurts.

  Measured on a 67-unit block: the panel read "Vat status — 66 units behind",
  correctly invisible for the one unit given its own value; the sync updated
  exactly those 66, left the 67th alone, wrote 66 events and the chain verified.

  **The backfill needed three attempts and the reason is worth keeping.** The
  first rule was "inherited if the value equals the parent's" — which left every
  unit created by the old five-column `createUnit` permanently opted out, since
  their columns are blank where the parent has values. Blank means nobody had an
  opinion, not that somebody chose "unknown". Widening it to null caught most of
  them; the last miss was that `vat_status`, `title_deed_status` and
  `permit_status` are NOT NULL and say "nobody has said" with a literal
  `'unknown'`, and `features` with an empty array. `currency` ('EUR') and
  `transaction_type` ('sale') are deliberately NOT in that group — those
  defaults are real answers.

  **VERIFY:** `grep -rl "inherited_fields" supabase/migrations lib` — no hit
  means it was reverted. The original entry follows.

  - **5. A unit inherits five fields from its project; everything else is retyped (original).**
  `createUnit` copies `transaction_type`, `district_id`, `area_id`, `address`,
  `postal_code` (`lib/actions/units.ts:63-68`). Not copied, and therefore blank
  on every unit forever unless typed 60 times: developer, owner, VAT status,
  currency, title-deed status, permit status, energy class, delivery date,
  construction status, features, amenities, coordinates, assigned agent,
  visibility, description. Doc 02 §C1 says units inherit "unless overridden";
  the implementation inherits five columns and has no override concept.
  Fix: widen the inherited set, and record which columns are still project-derived
  in a `properties.inherited_fields text[]` so a later project edit can offer
  "update the N units that still inherit this" without touching the ones somebody
  deliberately changed.
  **VERIFY:** `grep -c "project\." lib/actions/units.ts` — `16` on 2026-08-21
  (5 inherited columns plus the guard and event reads). A larger number means it was widened.

- ~~**6. Mandates can only be retyped, never renewed.**~~ **SHIPPED 2026-08-21**
  — migration `0036` adds `mandates.renewed_from_id`, and a Renew button copies
  the owner, type, commission, reminder and notes forward with the dates shifted
  by the SAME NUMBER OF DAYS. Days, not calendar months, on purpose: "six
  months" is not a fixed length and month arithmetic has its own judgement calls
  (Jan 31 plus one month). The successor **starts when the old one ends**, so an
  early renewal never overlaps — unless the old one already lapsed, in which case
  it starts today, because back-dating a contract over a gap nobody was under
  mandate for would be inventing history.

  **The successor is a DRAFT, never active**, so activating it is a separate
  deliberate step and finding 7's index forces the predecessor to be terminated
  first. That sequence is now enforced rather than described. The signed document
  is deliberately not copied — a renewal is a new agreement and needs its own
  signature; pointing at the old PDF would make the evidence chain assert
  something false. Both cards show the chain: "Renews an earlier mandate" and
  "Replaced by …", and a mandate already renewed loses its Renew button.
  The original entry follows.

  - **6. Mandates can only be retyped, never renewed (original).**
  `MANDATE_TRANSITIONS` (`lib/validators/mandates.ts:10-15`) is a dead end:
  `expired: []`, `terminated: []`. Renewing means a blank dialog and re-entering
  owner, type, commission, reminder days and notes, and the new row carries no
  link to the one it replaces. For a business whose commission evidence is a hash
  chain, an unlinked mandate history is a real loss. Fix: `renewed_from_id` plus
  a Renew action that copies the terms forward and shifts the dates by the same
  duration.
  **VERIFY:** `grep -rl "renewed_from" supabase/migrations lib` — any hit means
  shipped. *(none on 2026-08-21.)*

- ~~**7. Nothing stops two active exclusive mandates on one property.**~~
  **SHIPPED 2026-08-21** — `mandates_one_active_per_property`, a PARTIAL unique
  index (`where status = 'active'`) so history and renewal chains are untouched.
  A database guarantee rather than a convention, because this is the number the
  business gets paid on. `setMandateStatus` turns the 23505 into a sentence that
  says what to do: "This property already has an active mandate. Terminate it
  first." The migration CHECKS FOR EXISTING VIOLATIONS BEFORE creating the index,
  so a pre-existing conflict names the property instead of failing as a bare
  index-build error — and it refuses to choose which of the two is real.

  **`mandates_safe` had to be replaced too**, since it lists its columns
  explicitly and every read path goes through it. Grants and masking were
  captured before and compared after — byte-identical `relacl` — and the
  migration's own check refuses to finish if `authenticated` lost SELECT.
  The original entry follows.

  - **7. Nothing stops two active exclusive mandates on one property (original).**
  `saveMandate` inserts at `lib/actions/mandates.ts:151` with no pre-check, and
  every reader ("active wins the badge") just takes the first active row it
  finds. Two exclusives with different commission rates can coexist and the UI
  will show one of them arbitrarily. Fix: a partial unique index — one active
  mandate per property — so it is a database guarantee rather than a convention.
  It protects the number the business gets paid on.
  **VERIFY:** `grep -rn "unique.*mandates\|mandates.*unique" supabase/migrations`
  — *(0 on 2026-08-21.)*

- ~~**8. An active mandate can have no owner.**~~ **SHIPPED 2026-08-21** —
  checked on the `draft → active` transition rather than at insert, so a
  half-entered draft can still be saved and finished later. "Add the owner
  contact before activating this mandate." The original entry follows.

  - **8. An active mandate can have no owner (original).**
  `owner_contact_id` is `optionalUuid` in `saveMandateSchema`
  (`lib/validators/mandates.ts:48`) and `setMandateStatus` does not check it.
  A mandate is a contract with a person; one that names nobody is worth 10 points
  on the quality score and nothing in a dispute. Fix: require it on the
  `draft → active` transition, not at insert, so a half-entered draft still saves.
  **VERIFY:** `grep -n "owner_contact_id" lib/actions/mandates.ts` — a check
  inside `setMandateStatus` means shipped. *(only the two writes on 2026-08-21.)*

- ~~**9. A contact record never shows its properties.**~~ **SHIPPED 2026-08-21**
  — a Properties tab on the contact page, one query on both party columns.
  It only became possible once finding 2 filled them.

  **Units are rolled up into their project, never listed** — the same call the
  properties list makes by default. A developer with a 60-unit block gets ONE
  row plus "62 units · 62 available", because sixty rows would bury the three
  things the reader opened the page for. A unit whose project is NOT in the
  portfolio (sold on, owner changed) stands on its own instead of vanishing.

  Owner and developer are not exclusive — a developer owns everything it has not
  sold — so a property where the contact is both reads "Owns & Built" and is
  counted once.

  **It caught a real gap in its own right.** Leptos showed 62 units against a
  67-unit project: the missing 5 were the ones created before the inheritance
  widening, which never got a `developer_contact_id`. All 5 still listed it as
  inherited, so finding 5's drift panel offered "Developer contact — 5 units
  behind", and after one click the tab read 67 units and €18.745.000. The two
  features check each other.
  **VERIFY:** `grep -c 'from("properties")' "app/(app)/contacts/[id]/page.tsx"` —
  0 means reverted. The original entry follows.

  - **9. A contact record never shows its properties (original).**
  `app/(app)/contacts/[id]/page.tsx` has six tabs (Profile · Preferences · KYC ·
  Activity · Deals · Documents, lines 236-245) and queries `properties` in none
  of them. Open a developer and you get their phone number, not their inventory.
  This is the other half of finding 2 — once the two party columns are filled it
  is a single query and one tab.
  **VERIFY:** `grep -c 'from("properties")' "app/(app)/contacts/[id]/page.tsx"` —
  *(0 on 2026-08-21.)*

- ~~**10. Three project columns are dead in the UI.**~~ **TWO SHIPPED, ONE
  DECIDED AGAINST, 2026-08-21.**

  `construction_status` and `delivery_date` are now a "Build & handover" section
  on the Details tab and a fact on the Overview — delivery date being the first
  question anybody asks about an off-plan unit. Both are in
  `INHERITED_UNIT_FIELDS`, so a project's units get them and the drift panel
  keeps them in step.

  `construction_status` is `text` in the schema, not an enum, and older rows may
  hold anything. The select offers a standard list AND KEEPS WHATEVER IS ALREADY
  STORED as an extra "(as recorded)" option — dropping it would show a different
  status than the record holds, and the next save would write that difference.
  Verified against a real free-text value.

  **`currency` was deliberately NOT made editable.** Making the column writable
  without currency-aware formatting would be worse than leaving it: `formatMoney`
  and the evidence-report formatter both hardcode EUR, so a property in GBP would
  display and PRINT as euros — a wrong number on a commission document. This desk
  is Cyprus and EUR-only; the column is vestigial. If multi-currency is ever
  wanted it is a formatting project, not a form field.
  **VERIFY:** `grep -rn "delivery_date" components/features/properties` — 0 means
  reverted. The original entry follows.

  - **10. Three project columns are dead in the UI (original).**
  `construction_status` and `delivery_date` have zero references anywhere outside
  the schema and `database.types.ts`. `currency` is read once
  (`app/(app)/share-links/page.tsx:33`) and written by nothing, so every listing
  is silently EUR. Delivery date is the most-asked question about an off-plan
  unit and it is already a column.
  **VERIFY:** `grep -rn "delivery_date\|construction_status" app components lib/actions`
  — *(0 on 2026-08-21.)*

- ~~**11. `phase` is a kind that cannot be created.**~~ **SHIPPED 2026-08-21 —
  BUILT, not deleted.** Operator confirmed the desk does sell in phases, so the
  three read paths were always right and it was the way in that was missing.

  **No migration.** `phase` has been in the enum with a `phase_has_parent`
  constraint since `0001`, and `createUnit` already accepted a phase as parent —
  the schema described this hierarchy from day one.

  A phase is created from its project's units page and gets its own units page,
  because the matrix, the generator and the price lists all key off `parent_id`
  and work unchanged. The reference composes without touching that code:
  `PAF0002-P1`, and a unit under it lands at `PAF0002-P1-A101`.

  **The delivery date is the point.** A phase inherits from its project exactly
  as a unit does, `inherited_fields` included — except an entered delivery date
  is the phase's OWN and is severed on creation, so a project-side sync cannot
  overwrite it. Staged handover is why phases exist. Measured: project 2028-03-31,
  phase 2029-09-30, and the eight units generated under the phase all took
  **2029-09-30 from the phase**, not 2028 from the grandparent.

  **A phase cannot contain a phase** — one level, per doc 01 §C1. Nesting would
  make the reference unbounded (`PAF0002-P1-P2-B203`) and leave the units matrix
  with no single place to live. Refused in the action and the section is not
  rendered on a phase's own page.
  **VERIFY:** `grep -c "createPhase" lib/actions/units.ts` — 0 means reverted.
  The original entry follows.

  - **11. `phase` is a kind that cannot be created (original).**
  The enum has four kinds. `CREATABLE_KINDS` offers two
  (`lib/validators/properties.ts:174`) and `createUnit` hardcodes the third, so
  nothing can produce a `phase` — yet three read paths branch on it
  (`properties/[id]/page.tsx:293`, `units/page.tsx:33`, `units.ts:47`). Either
  build phase creation (a large project genuinely sells in phases, with separate
  price lists and delivery dates) or delete the branches. **A code path nobody can
  reach is a claim, and claims here go stale silently** — same rule as this file's
  own header.
  **VERIFY:** `grep -rn '"phase"' lib/validators lib/actions` — a creatable kind
  means shipped. *(only the `createUnit` guard on 2026-08-21.)*

- ~~**12. Every contact picker searches every contact — ENABLER.**~~ **SHIPPED
  2026-08-21 (`cf15794`)** — `searchEntities` takes an optional `contactTypes`.
  It uses `overlaps`, NOT `contains`: `contact_types` is an array on both sides
  and a contact tagged `{owner,buyer}` must still match an Owner picker. Every
  existing caller is unchanged. The original entry follows.

  - **12. Every contact picker searches every contact — ENABLER. (original).**
  `searchEntities("contact", …)` (`lib/actions/entity-search.ts:23-36`) has no
  type filter, so the "Owner contact" picker on a mandate offers buyers, lawyers
  and bankers. The query already exists one file away —
  `lib/queries/contacts-list.ts:78` filters with `.contains("contact_types", [type])`.
  Small alone, but it is the prerequisite for the party model in finding 2:
  "choose the developer" only works if the picker knows what a developer is.
  **VERIFY:** `grep -c "contact_types" lib/actions/entity-search.ts` — *(0 on 2026-08-21.)*

- ~~**13. No duplicate guard when creating a property.**~~ **SHIPPED 2026-08-21**
  — a live check on the create wizard: same district, same address once
  punctuation and street-type words are set aside.

  **IT WARNS AND DOES NOT BLOCK**, which is the whole point. Two genuinely
  different units share a building, and a guard that refuses them is a guard
  people learn to work around. The banner links the existing reference and the
  submit button stays enabled.

  **Normalised equality, deliberately NOT trigram similarity.** A similarity
  threshold is a number nobody can defend later ("why 0.6?"), and near-misses on
  a street name would flag neighbours as duplicates. "Same address once
  punctuation and street-type words are set aside" is explainable in one
  sentence. The house number is kept and is usually the whole signal — dropping
  it would make every address on a street match every other one, and an E2E pins
  that a different number does NOT warn.

  Scoped to one district (two identical addresses in different towns are
  different places) and bounded at 500 candidate rows, because `address` is
  unindexed by design and a bound that can be stated beats one that cannot.

  Coordinates were not used: the create wizard collects an address and a
  district, not a pin, so a 30 m radius check would have nothing to compare on
  the one screen where it matters.
  **VERIFY:** `grep -c "checkPropertyDuplicate" lib/actions/properties.ts` — 0
  means reverted. The original entry follows.

  - **13. No duplicate guard when creating a property (original).**
  Contacts block duplicates live on `phone_e164` and warn on email. Properties
  have no equivalent, so the same villa entered twice yields two references, two
  mandates and two photo sets — and both burn a `reference_counters` value that
  can never be reissued. The indexes for the check already exist:
  `properties_location_gix` (GiST on the point) makes "within 30 m" cheap and
  `properties_ref_trgm` covers fuzzy matching. Warn, never block: two genuinely
  different units do share a building.
  **VERIFY:** `grep -rci "duplicate" lib/actions/properties.ts` — *(0 on 2026-08-21.)*

- ~~**14. The CSV export omits every relationship.**~~ **DONE 2026-08-21.**
  `Kind` shipped with finding 3; owner, developer, assigned agent, title-deed
  status, permit status and coordinates followed.

  **Latitude and Longitude are two columns, not one string.** A "34.77, 32.42"
  cell makes somebody parse it back out before they can plot anything, and a
  spreadsheet is the whole reason this export exists. A property with no point
  gets two EMPTY cells — a 0 would put it in the Gulf of Guinea.

  Measured against real rows: a phase exported as
  `…,Andreas Georgiou,Leptos Estates,Maria Christodoulou,pending,full,…`.
  **VERIFY:** `grep -c "Developer" lib/services/property-export.ts` — 0 means
  reverted.

  - **14. The CSV export omits every relationship (original entry).**
  Seventeen columns (`lib/services/property-export.ts:52-72`), none of which say
  who owns it, who built it, who is responsible for it, whether it is a unit or a
  project, or where it is. An export that cannot be grouped by developer is not
  much use in a developer conversation. Add: kind, owner, developer, assigned
  agent, coordinates, deed + permit status.
  **VERIFY:** `grep -c "Owner\|Developer\|Kind" lib/services/property-export.ts` —
  *(0 on 2026-08-21.)*

- ~~**15. The quality score never asks who is responsible.**~~ **SHIPPED
  2026-08-21** — "Agent assigned" 5 and "Owner or developer linked" 5, added only
  now because both fields were unfillable until findings 1 and 2 shipped, and a
  score item for a field nobody can fill is a permanent deduction rather than a
  prompt.

  **PAID FOR, not added on top.** Cover photo 10→5 and ≥6 photos 15→10 funded
  them: imagery carried 25 of 100 across two items that overlap almost completely
  (no six photos without a cover), and still carries 15, joint-largest. Nothing
  about price, location or legal status was weakened. A test now asserts the
  weights total exactly 100 in both the land and non-land shapes — adding an item
  without paying for it inflates every score and quietly weakens the publish gate.
  Doc 02 §C1 updated in the same commit.

  **Changing a weight makes every stored score stale**, because the detail page
  computes fresh while the list and CSV read the column. `npm run
  recompute:scores` (with `--dry-run`) exists for that and was run: 106 rows,
  re-run a clean no-op.
  **VERIFY:** `grep -c "hasAssignedAgent" lib/services/quality-score.ts` — 0
  means reverted. The original entry follows.

  - **15. The quality score never asks who is responsible (original).**
  Eleven weighted items (`lib/services/quality-score.ts:49-89`) covering photos,
  copy, price, area, coordinates and legal status. None covers an assigned agent
  or a linked owner — reasonably, since neither is currently fillable. Once 1 and
  2 land they are the obvious additions, and the score is the mechanism that
  actually gets the desk to fill them in. **Do not do this before 1 and 2** — a
  score item for a field with no input is a permanent deduction.
  **VERIFY:** `grep -c "agent\|owner" lib/services/quality-score.ts` — *(0 on 2026-08-21.)*

### Proposals that came out of the same read

Not defects — features the audit argued for, all following one rule: **the
system already knows something, so stop asking a person for it.** Sizes are
relative (S = an afternoon, M = a few days). Nothing here gets built without
explicit direction.

- ~~**Party defaults, S→M.**~~ **SHIPPED 2026-08-21, migration `0038`** — the
  operator's opening request for this whole audit, and the last piece of it.

  `contacts.party_defaults jsonb` (the pattern the row already uses for
  `preferences`, `kyc`, `banking_readiness`) holds what a developer or owner
  always works on: commission, mandate type and length, reminder days, VAT,
  deed and permit status. The office fallback lives in `cyprus_config` under
  `default_mandate_terms`, which already carries `verified_at` and
  `source_note` — the right shape for "our standard is 3%", a number somebody
  has to stand behind. Resolution is party over office, most specific wins.

  **A STORED ZERO IS A REAL ANSWER.** Some referral arrangements genuinely are
  0%, so only `undefined` falls through — treating 0 as "no opinion" would
  quietly bill the office's 3% on a form somebody signs. Absent fields are
  stored ABSENT rather than null, or every field would pin itself to blank.

  **Each prefilled value says where it came from.** A number that does not
  explain itself is one people distrust and retype, which would defeat the
  point: "Terms filled from Leptos Estates's standard terms. Every field is
  editable."

  **Never on an EDIT.** The mandate on screen is what was signed, not what this
  owner usually signs — pinned by an E2E.

  Measured: a developer with 2.5% / exclusive / 12 months prefilled a new
  mandate at 2.5%, exclusive, expiry twelve months out, and reminder 30 days
  **from the office**, because they had no opinion on it.

  **The create-wizard half shipped 2026-08-22.** Step 1 opens with "Where is it
  from? — a private owner / a developer", which chooses the party picker, the
  party column that gets written, and the default kind. Picking the party sets
  the district from their terms (only if the user has not already chosen one —
  an explicit answer outranks a usual one) and states what else will be applied:
  "From Wizardev: VAT New vat · deed pending. Applied on create and editable
  afterwards."

  **The terms are RE-RESOLVED SERVER-SIDE before the write.** The wizard's copy
  is for the human; a form can post anything, and these set a VAT treatment and
  a legal status on a record the desk quotes from. **Only the party the SOURCE
  names is honoured** — a form posting both would otherwise attach a developer
  to a private owner's villa. The `created` event lists which defaults were
  applied, so the timeline explains values nobody typed.
  **VERIFY:** `grep -c "party_defaults" lib/actions/party-defaults.ts` — 0 means
  reverted. The original entry follows.

  - **Party defaults (original entry).** A developer's standard commission, mandate type and
  duration, usual VAT treatment, district, boilerplate and payment plan, stored
  on the contact as `party_defaults jsonb` (the same pattern the row already uses
  for `preferences`, `kyc`, `banking_readiness`), with an office-level fallback in
  `cyprus_config` — which already carries `verified_at` and `source_note`, the
  right shape for a number somebody has to stand behind. Resolution order:
  unit ← project ← party ← office. **Every prefill stays editable; a default is a
  suggestion, not a lock.**
- ~~**Bulk unit generator, M.**~~ **SHIPPED 2026-08-21.** `GenerateUnitsForm` on
  the units page: block, floor range, units per floor, shared layout, base price
  and a per-floor increment. Units inherit through the SAME
  `resolveInheritedUnitFields` a hand-added one uses — a second inheritance path
  that drifted would be worse than no generator.

  **The live preview is the feature, not decoration.** It shares `generateUnits`
  with the action, so what it shows is literally what gets written: exact count,
  first and last reference, price range. A generator that writes sixty rows on a
  guess is worse than typing them, because sixty plausible-looking wrong rows
  have to be found by hand.

  **ALL OR NOTHING on collision**, checked before writing rather than caught as a
  23505 — a partial block is the worst outcome, since you cannot tell by looking
  which half landed and the obvious retry collides with it. The error names the
  clashes. Ceiling of 200 per run so a floor-range typo cannot insert thousands.

  **One event per unit, in ONE statement** via the new `logEvents`. That the hash
  chain survives a multi-row insert was MEASURED before the code was written, not
  assumed: a 3-row probe gave `prev_hash[n] = hash[n-1]` throughout with the chain
  still verifying. Proven again end to end at 60 units.

  **VERIFY:** `grep -c "generateProjectUnits" lib/actions/units.ts` — 0 means gone.
- ~~**Unit type templates, M.**~~ **SHIPPED 2026-08-22, migration `0039`.** A
  `unit_types` table scoped to a project — layout codes are a project's own
  vocabulary and every developer has an "A1" that is not the same flat. Define
  beds, baths, covered area, veranda and a €/m² rate once, then stamp it onto
  all units or one block.

  **A STAMP, NOT A LINK.** Applying copies the values; the unit is not bound to
  the type afterwards and there is deliberately no drift panel for types. Beds,
  area and price are in `DELIBERATELY_NOT_INHERITED` for the same reason: two
  units of one layout legitimately diverge — one gets a bigger veranda, one is
  repriced for a view.

  **A stamp, not a MERGE either.** A field the type leaves blank is written as
  null: stamping A1 should make a unit an A1, not an A1 still carrying the
  previous layout's bathroom count. The one exception is price — a type with no
  €/m² rate leaves an existing price ALONE, because a layout template says what
  the flat IS, not what it is worth today, and wiping a price nobody asked to
  change would be destructive. Both pinned by E2E.

  **Price is covered area × rate. Veranda is recorded and NOT priced** — half
  rate, quarter, or not at all is a commercial decision that varies by project,
  and inventing a convention would put a wrong number on a quote. Rounded to the
  same €100 the bulk uplift uses.

  **The new table got `require_aal2`** (0029's restrictive policy) rather than
  becoming the one gap in 2FA enforcement — a table created after that migration
  does not inherit it. The migration asserts `rls_aal2_coverage()` is still empty
  before it will finish.

  Measured: type A1 (2 bed, 85 m², €3000/m²) stamped onto block A set bathrooms
  from NULL to 1, veranda from NULL to 20, price to €255.000, wrote 5 events and
  5 price_history rows, and left block C's 60 units untouched.
  **VERIFY:** `grep -c "applyUnitType" lib/actions/units.ts` — 0 means reverted.
- ~~**Create similar, S.**~~ ✅ **DONE 2026-08-25.** A *Create similar* button on
  standalone and project properties links to `/properties/new?similar=<id>`,
  which prefills the create wizard from that property. No migration.

  **IT PREFILLS, IT DOES NOT CREATE.** Making a draft copy on click would have
  been less code and would burn a REFERENCE every time somebody changed their
  mind — `reference_counters` never reuses one, so an abandoned draft leaves a
  permanent hole in the sequence the desk quotes from. Nothing exists until the
  user submits.

  **The banner is part of the feature, not decoration.** The real risk here is a
  copied PRICE accepted without being read, so the page names the source
  (`Prefilled from PAF0001`) and lists what did NOT come across. A silent copy
  would be the dangerous version.

  Not carried: `reference` (generated, immutable), `status` (inheriting `sold`
  would be absurd, inheriting `available` a claim nobody made), unit fields and
  the parent link, and map coordinates (an exact point is a claim about THIS
  building). Carried: party, kind, type, transaction, district, area, address,
  title, prices, areas, bed/bath, internal notes.

  **Not offered on units or phases** — `CREATABLE_KINDS` is standalone|project,
  so the button would promise something that quietly became a standalone. The
  hand-typed-URL path still degrades safely: it maps to standalone and says so
  in the drop list rather than producing an orphan unit with no parent.
- ~~**Area centroid as a coordinate fallback, S.**~~ ✅ **DONE 2026-08-25**
  (migration 0054). A *Use the area centre* button on the Details form takes the
  area's centroid, or the district's when the area has none, and stores it
  flagged as approximate.

  **THE FLAG IS THE FEATURE, not decoration, and "S" was wrong for that
  reason.** A button that merely wrote the centroid into `properties.location`
  would have broken two working things SILENTLY:

  1. **The quality score would start lying.** `computeQualityScore` awards 10
     points for "Exact map location" on `location !== null` — in TWO places,
     `quality-score.ts` and the recompute inside `saveProperty`, which must
     agree or a save and a recompute disagree about the same row. A centroid
     would earn every property ten points for a coordinate nobody surveyed.
  2. **The map would lose the distinction it was built with.**
     `resolvePosition` INFERRED precision from which source it fell back to.
     Once a centroid lives in `location` that inference says "exact", and
     0031's own comment — "approximate pins render differently from exact ones
     so nobody reads a centroid as a surveyed point" — stops being true.

  So `location_approx` is stored, and both readers respect it. A CHECK refuses
  the flag without a point, because a flag qualifying nothing reads as knowledge
  we do not have; RLS test 38 proves it from the app's side and the migration
  proves it as `postgres`.

  **The flag clears itself.** Any hand-typed digit or pasted Maps link over a
  centroid is the user asserting a real coordinate, so the component wraps its
  setters rather than calling them directly. Measured end to end on PAF0001:
  taking the centre stored `POINT(32.4245 34.7754)` with `approx = true` and
  **left the quality score at 40**; typing real coordinates over it cleared the
  flag and took the score to 50. Both transitions are in the event diff.

  **Nothing existing moved.** Every row got `false`, so no coordinate already
  entered became approximate and no quality score changed — the property that
  made this safe to apply to a production database with real listings on it.
- **VAT treatment derived, not remembered, M — NEEDS AN OPERATOR DECISION.**
  Reduced-rate eligibility follows from covered area, price and buyer status; the
  calculators exist and `cyprus_config` is built to hold verified thresholds.
  Suggest the status and show the rule that produced it. **The thresholds must
  come from the operator — a CRM must not invent tax law**, which is the same
  reason B4's reservation agreements are parked (HANDOFF §5).
- ~~**Owner net ↔ asking ↔ commission, shown, S.**~~ ✅ **DONE 2026-08-25.** A
  live panel under the Pricing fields on the Details tab. No migration.

  **THE FLOOR IS A DIVISION, AND THE TEMPTING VERSION IS WRONG.** Commission is
  charged on the SALE price, so the lowest sale that still delivers the owner's
  net is `net / (1 − pct/100)`, not `net + commission`. At 5% on a €200.000 net
  the naive sum gives €210.000, which returns €199.500 after commission — five
  hundred short of what the owner was promised. A test pins that difference
  in euro precisely because the wrong answer looks so reasonable.

  **It is four numbers, not the three the entry counted.**
  `min_acceptable_price` already existed alongside asking and owner net, and it
  is a SALE price while owner net is what the owner receives — so the panel also
  says, in euro, when the min acceptable does not actually deliver the net, and
  when the ASKING price itself does not (the worse case, which nothing else on
  the page would have shown).

  **Live, not a snapshot**, because the question is asked mid-negotiation: it
  reads the fields on input bubble, so typing "what if I take 240?" moves the
  figures without saving. The three fields stay uncontrolled — converting a
  working form's inputs to controlled state to feed a read-only panel is a lot
  of risk for a display.

  **Visibility is not re-implemented.** `commission_pct` arrives from
  `mandates_safe`, which returns NULL unless the reader is an admin or the
  property's assigned agent. Nothing derives from null, so the panel simply does
  not render for anyone else — the masking upstream IS the gate, and a second
  copy of that rule would be one more thing to drift.

  **A bug in my own explanatory line, caught by reading the rendered page:** it
  said "divided by 0.96" because `.toFixed(2)` rounded the 0.965 behind a 3.5%
  rate, and 200.000 / 0.96 is 208.333 — an explanation that does not reproduce
  the figure printed beside it. Now stated as a percentage (96.5%), which does.
- ~~**Quality-score worklist, S.**~~ ✅ **DONE 2026-08-25.** `/properties/worklist`,
  reached from a *Worklist* button on the list. No migration. The entry was
  right that the information was already being computed and discarded.

  **ORDERED BY POINTS RECOVERABLE, NOT BY COUNT**, and that is the one real
  decision in it. The question a desk is asking is not "what is most common" but
  "where does an afternoon buy the most" — so 12 listings missing a price
  (12 × 10 = 120) ranks ABOVE 22 missing a permit status (22 × 5 = 110), which
  sorting by count would have put the other way round. Both numbers are shown so
  the reader can disagree. Verified in the real local data, where exactly that
  pair appears in exactly that order.

  **The shared input builder is the part that protects it.**
  `recomputeQualityScore` made THREE queries per property — right for one save,
  ruinous across a portfolio (60 units = 180 queries). The worklist does three
  for the whole list. To stop the two paths drifting, the input-building was
  extracted into `buildQualityInput` and BOTH now call it: a worklist saying
  "12 missing coordinates" while the detail pages disagree would be worse than
  no worklist, because it looks authoritative.

  Reads `mandates_safe`, not `mandates`, for the same reason the app path does —
  a listing manager has no base-table SELECT and would otherwise see every one
  of their properties in the "Active mandate" bucket.

  **It persists nothing.** Scores are computed fresh for display and the stored
  `quality_score` column is untouched; a report that quietly rewrites what it
  reports on is not one.

  Scope: non-archived, status in draft/available/reserved/under_offer — a sold
  listing needs no more photos. Categories name the TAB the fix lives on, which
  is what turns a count into an instruction; the tabs are Radix state with no
  href, so naming them is as close to a deep link as the app allows.
- ~~**Portfolio tab on a contact, S.** Finding 9, from the other side.~~
  **ALREADY SHIPPED — this line was a DUPLICATE and stayed open for four days.**
  It went in with the audit (`0cc9ab6`, 2026-08-21) and finding 9 shipped the
  SAME DAY (`19e42a1`) as exactly this: a `portfolio` tab on the contact page.
  Two lists, one idea, and only the numbered one got struck through.

  **Verified before closing rather than assumed**, on 2026-08-25: the tab is
  present, reads "Properties (4)" for a contact owning 74 rows, and SQL confirms
  74 collapse to exactly 4 top-level entries (PAF0001, PAF0002, PAF0002-P2,
  PAF0003) — the unit rollup finding 9 was built around, agreeing to the row.

  The contact page already covers every side of this: what they own or built
  (Properties), what they are buying (Deals), what they are looking for (0043
  saved searches on Preferences), and what has happened (Activity). There is no
  remaining "other side" to build.

  **Worth reading as a process failure, not just a stale line.** Nothing here
  distinguished "proposal" from "shipped" except a strikethrough applied by
  hand, so a duplicate survived in a second list and was picked up as work four
  days later. When an item appears in two sections, close both.
- ~~**Project availability share link, M.**~~ **SHIPPED 2026-08-22 (`92958e9`)**
  — migration `0041`, a second `kind` on 0023's machinery. **No new table:**
  `share_link_properties` already joins a link to the one property it names, so
  the revoke-before-grant rule above had nothing to bite on, which the migration
  says out loud rather than leaving as a silent omission.

  **The exposure boundary moved, deliberately and only for the new kind.**
  `status` is exposed — "40 available · 12 sold" IS the product — and 0023's
  proposal allowlist still does not carry it. RLS test **29** resolves BOTH
  kinds over the SAME project and asserts status present on one and absent on
  the other, which is the only way to prove the widening is scoped rather than
  global. Test 25 was not edited: the availability branch early-returns above
  0023's code, so the proposal payload and its pinned key set are untouched.
  `visibility` did NOT move with `status` — status is market truth about a unit,
  visibility is the desk's channel strategy.

  **A phased project's units hang off the PHASE**, so the resolver walks
  descendants rather than children; a naive `parent_id` query renders an empty
  matrix for exactly the projects big enough to need one. Recursive, not
  depth-2, because "a phase cannot contain a phase" is enforced in `createPhase`
  and NOT in the database. A link may name a phase, which is the scoping
  control. Units are grouped by phase because a phase's delivery date is its own.

  **A link may pin a `price_list` version**, and pinned means pinned: a unit the
  version omits shows no price rather than a live one, with the shortfall stated
  on the page. `on delete restrict` stops a quoted version being deleted under a
  live link.

  **Measured, not reasoned about:** minted through the real UI on a 75-unit
  phased project, opened anonymously (both phases present, the phase's 2029 date
  distinct from the project's 2028), revoked, and re-opened to the neutral page —
  with `created`, `opened` and `revoked` events and `verify_events_chain` true
  after each. Reading that rendered page is what caught `unpriced_count`
  reporting a price-list shortfall on a page that had no price list; the
  regression assertion in test 29 was confirmed to FAIL against the pre-fix
  resolver before being kept.
  **Applied to hosted 2026-08-22** in the §3 sequence, via `execute_sql` and not
  `apply_migration` — the latter stamps a timestamp-shaped version and would
  break the `non_filename_versions` = 0 invariant. `get_advisors` after: **no new
  SECURITY finding** (`resolve_share_link` was already the pinned 0028 exception),
  and **one new PERFORMANCE finding, knowingly accepted** —
  `share_links_price_list_id_fkey` has no covering index, which is the 64th
  instance of `unindexed_foreign_keys` on this project and the fourth on
  `share_links` alone (`contact_id`, `created_by`, `revoked_by` are the others).
  Indexing one while three siblings stay bare would be noise; the FK is walked
  only when a `price_lists` row is deleted, which nothing in the app does. **The
  whole 63-finding class is what wants a decision, not this one row.**
  **VERIFY:** `grep -c "createAvailabilityLink" lib/actions/share-links.ts` — 0
  means reverted. *(1 on 2026-08-22.)* The original entry follows.

  - **Project availability share link, M (original).** `share_links` already
  mints, opens and revokes with full evidence. Point the same machinery at a
  project and a developer or partner agent gets a live availability matrix
  instead of yesterday's PDF.
- ~~**Construction progress + delivery date, S.**~~ ✅ **DONE 2026-08-25.** A
  *Build & handover* card on the property Overview and on the project units page,
  above sales velocity. No migration — finding 10 already made both columns
  editable; this says what they MEAN together.

  **NO PERCENTAGE COLUMN WAS ADDED, AND THE BAR IS NOT A PERCENTAGE OF WORK.**
  The eight `CONSTRUCTION_STATUSES` are an ordered sequence, so position along
  them is derivable for free — but eight even steps would put `permit_granted`
  at 37.5% for a project where **nothing has been built**. The weighting instead
  gives the three stages where building happens (under construction, structure
  complete, finishing) **25 points each — 75 of the 100 between them**; paperwork
  gets 10 across three stages and handover the last 15. The caption on the card
  says it is a position along the sequence and not a surveyed percentage,
  because a number on a screen reads as measured unless told otherwise.

  **A free-text status still shows, with NO bar and NO stage.**
  `construction_status` is `text` and finding 10 deliberately preserves whatever
  a row holds as "(as recorded)"; inventing a position for a word nobody
  recognises would undo exactly that. Verified against a real free-text value.

  **The delivery date became an answer rather than a date**: whole months to
  handover in Cyprus wall-clock, negative once passed, and a flag when the date
  has gone by with the build unfinished — or when a project is marked delivered
  with the date still ahead. Both are worded as something to look at, never as
  an error, because handing over early is legitimate.

  **A test caught an overclaim in my own comment.** It said starting on site was
  the largest single jump; completing the structure is the same 25 points. The
  weights were right and the sentence was not — corrected in both, and the test
  now pins the 25/25/25 shape instead.
- ~~**Sales velocity per project, M.**~~ ✅ **DONE 2026-08-25.** A card on
  `/properties/[id]/units`: units, sold, absorption %, remaining, pace over the
  last 12 months, a projected months-to-sell-out, and a 24-month bar chart.
  **NO MIGRATION AND NO NEW COLUMN** — the entry's core claim held exactly.

  **But the entry named the wrong event, and getting that wrong would have
  undercounted silently.** Property status changes are written by TWO paths in
  two shapes: the units grid (`updateUnitStatus`) writes `status_changed`
  `{reference, from, to}`, and the property details form (`saveProperty`) writes
  `updated` `{section, changed: {status: {from, to}}}`. A unit marked sold from
  the details form produces no `status_changed` row at all, so a reader that
  handled only the named shape would have shown a low chart with nothing
  anywhere saying it was low. `soldAtFromEvents` handles both, and the local
  fixture deliberately seeds a third of its sales through the `updated` shape so
  a regression shows up as a wrong total rather than as nothing.

  A `sold_at` column was considered and REFUSED: it would be a second source of
  truth about something the event log already records, which is the trade the
  events table exists to avoid.

  **Decisions worth keeping:** only units whose CURRENT status is `sold` are
  counted, so the chart reconciles with the inventory beside it and a reverted
  sale is not a sale; `withdrawn` is excluded from `remaining`; the projection
  uses the last 12 months rather than all time, and is `null` — not "never", not
  "0 months" — when nothing has sold in a year; sold units with no recorded date
  are counted in absorption but SURFACED as missing from the chart rather than
  quietly dropped.

  Scoped to direct `kind = 'unit'` children, the same set the rest of that page
  shows. A phased project keeps units under its phases, so you read velocity per
  phase — recursing would make this one card disagree with every other number on
  the page.
- ~~**Keys follow the mandate, S.**~~ ✅ **DONE 2026-08-25** (migration 0053).
  Ending a mandate raises one `key_recall` task naming how many keys the agency
  still holds. Both paths covered: `setMandateStatus` on termination (through
  the service role from an already-admin-gated action, because the raiser is
  SECURITY DEFINER and takes any mandate id) and `expire_mandates()` nightly for
  expiry. Self-heals when the last key goes back.

  **"S" WAS WRONG, AND THE REASON IS THE VALUABLE PART.** `tasks.mandate_id` had
  only ever carried ONE kind, and two places silently depended on that —
  `expire_mandates()` step 3 and `supersedeRenewalTasks()` both completed every
  open task matching a mandate id, with no `kind` filter. A key_recall task
  hangs off a mandate that is BY DEFINITION no longer active, so both would have
  closed it on sight: the cron that night, the action within milliseconds. The
  feature would have looked like it worked — task created, event written — while
  leaving nobody anything to do.

  **The bug was demonstrated, not assumed.** A rolled-back probe ran the
  pre-0053 predicate against a real recall task and closed it (1 closed, 0
  open), then ran the shipped `expire_mandates()` against the same row and left
  it open. RLS test 37 pins it permanently with a message saying why.

  **Scope decisions worth keeping:** `in_office` and `checked_out` are chased;
  `with_owner` is the state that CLOSES the task; `lost` is excluded, because a
  key nobody can find cannot be handed back and is already its own record. The
  7-day due date is a GRACE PERIOD on a task that has already fired, not a
  firing threshold — which is why it is deliberately NOT in 0052's
  `nudge_thresholds`.

  **First run picks up history**, not just tonight's endings: the predicate is
  "ended mandate + keys still held + no task yet". On a large database that is a
  one-time batch. Measured before shipping — 0 on production, 0 locally.

- ~~**THE PROPERTY MAP (B5) RENDERS BLANK — SHIPPED, THEN HIDDEN.**~~
  **WITHDRAWN 2026-08-20: THE MAP WAS NEVER BROKEN.** Verified working against
  the real bundle — 9 `/planet/*.pbf` vector tiles, `load` fired, `loaded: true`,
  Cyprus drawn with roads and bilingual labels, headless and headed alike. The
  Map link is restored and both E2E tests are un-fixmed.

  **Everything in the original entry below was measured through two broken
  instruments, and every "ruled out by direct measurement" line it contains is
  worthless.** Keep it as the cautionary tale it is.

  1. **`requestAnimationFrame` does not run in a hidden tab.** MapLibre requests
     tiles from inside its rAF render loop and fires `load` from there too. Every
     "blank map" observation was taken through browser automation, where
     `document.visibilityState === "hidden"` and `document.hasFocus() === false` —
     including the checks against production. A hidden tab cannot render ANY map,
     working or not, so those checks could only ever produce the symptom they
     found. **Check `document.visibilityState` before believing anything about a
     canvas.**
  2. **A worker's fetches never appear in the window's resource timeline.**
     Vector tiles are fetched by MapLibre's worker. Measured on the same working
     page at the same moment: 9 tiles at the network level, **0** via
     `performance.getEntriesByType("resource")`, and 11 `.pbf` glyphs (fetched on
     the main thread) which is what made the ORIGINAL any-`.pbf` assertion pass.
     So the first assertion passed for the wrong reason and the "fixed" one could
     never pass at all. Count tiles with `page.on("request")`.

  **Both traps are written up permanently in `docs/ENGINEERING_NOTES.md` §7.**

  The sequence is the point: an assertion that could not fail was replaced with
  one that could not pass, the red CI was then read as proof the feature was
  broken, and a working feature was hidden from users on that basis. Each step
  was reasonable given the step before, and the whole chain was wrong, because
  nobody validated the instrument. The real bug fixed along the way was the
  effect-churn in `map-view.tsx` (the map was torn down and rebuilt on every
  render) — genuine, worth keeping, and never the cause of anything blank.

  The original entry follows.

  - **THE PROPERTY MAP (B5) RENDERS BLANK — SHIPPED, THEN HIDDEN (2026-08-11). (original).**
    Everything except the tiles works: the style, TileJSON, sprites and font glyphs
    all load, the canvas is correctly sized (1390x729), WebGL2 is supported, blob
    workers run, nothing is CSP-blocked and nothing errors in the console. MapLibre
    requests **zero** map tiles (`/planet/*.pbf`). Ruled out by direct measurement,
    not by reasoning: the CSP origin is present on `img-src` and `connect-src`; a
    `.pbf` fetched by hand from the page returns 200/119157 bytes; `resize()`
    changes nothing; the real effect-churn bug (the map was being torn down and
    rebuilt on every render) was found and fixed and was NOT the cause. Downgrading
    `maplibre-gl` 6.4.0 -> 5.24.0 changed the symptom (glyphs began loading) but not
    the outcome. Remaining suspect, UNPROVEN: MapLibre's worker under Next 16 /
    Turbopack, which is the thing that actually fetches tiles.

    Route `/properties/map` and migration 0031 (district/area centroids) stay —
    both are harmless. What was removed is the **way in**: the Map link on
    `/properties` is commented out, so nobody reaches a grey rectangle. Two E2E
    tests are `test.fixme` — the `/planet/` tile assertion and the link round-trip.

    **The tile assertion is the real lesson here.** The original version counted any
    `.pbf` request. Font glyphs are also `.pbf`, so it passed in CI, on a build
    whose map was blank in production. A test that cannot fail is worse than no
    test: it spends the credibility of a green run on nothing. Do not weaken it
    back — fix the map.

    **RE-VERIFIED IN PRODUCTION 2026-08-20** (gnk-crm.vercel.app on 9e2ddc9, real
    signed-in browser): still blank. 0 `/planet/*.pbf`, 11 glyph `.pbf`, 15
    OpenFreeMap requests (style, TileJSON, sprites json+png, glyphs), canvas
    1390x729, WebGL2 supported, and **not one console message** on a fresh reload.

    **THE CLUE THAT NARROWS THIS, found on that run: `property-map-empty` is NOT in
    the DOM**, so `data.features.length > 0` — the resolver and the district-centroid
    fallback both work. The pins are a `circle` layer fed from LOCAL GeoJSON: they
    need no tiles and would paint over a blank background. Nothing paints. So this
    is not "the basemap fails and the pins survive" — `map.on("load")` almost
    certainly never fires, and the handler that calls addSource/addLayer never runs.

    That fits the worker hypothesis and sharpens it: `load` waits on sources,
    sources are fetched by the worker, so a dead worker stalls `load` forever —
    silently, which is exactly the signature (no error, correct canvas, style and
    glyphs fine). It also EXONERATES a whole branch: the resolver, the GeoJSON
    coordinate order, the layer paint properties and the styling are all fine, so
    do not spend time there.

    Next step if picked up: reproduce in a bare Vite build to isolate whether this
    is MapLibre or the bundler, since that single fact splits the search space.
    Instrument `map.on("load")`, `map.on("error")` and `map.on("sourcedata")`
    FIRST — confirming load never fires (or catching the error it swallows) is
    cheaper than any further network archaeology.

    VERIFY: `grep -c "^test.fixme(" tests/e2e/property-map.spec.ts` — `2` means
    still broken and parked. `0` means someone fixed it and this entry is stale.
    (Anchored at `^` and including the paren ON PURPOSE: the unanchored
    `grep -c "test.fixme"` returns `3`, because a comment in that file explains the
    markers. That wrong number was written here first and caught by running it.)

- ~~**Property map, the rest of the shortlist (proposed 2026-08-20).**~~
  **CLOSED 2026-08-26 — THE SHORTLIST IS EXHAUSTED, and this parent line was the
  last thing making it look otherwise.** Of the four: *Price on the pin* shipped
  2026-08-20, *Map viewport in the URL* and *Draw-a-polygon* were both decided
  against BY THE OPERATOR the same day, and *Hover sync* is blocked on a
  precondition its own entry names.

  **Both `VERIFY:` commands below still return `0`, and for the two declined
  items that is the CORRECT state rather than a gap** — which is precisely how
  an aggregate entry misleads: its checks kept passing while its contents were
  resolved underneath it. Re-verified 2026-08-26.

  **Hover sync needs a combined view that does not exist**, measured not assumed:
  `/properties` references the map component 0 times and `/properties/map`
  references the list 0 times — they are separate pages with a toggle between
  them. Building a split list+map view is a real feature and a NEW entry if
  anyone wants it, not the tail of this one.

  Click-to-open popups, fit-to-results and clustering shipped; the four below
  were the rest, in the order I would have done them.

  - ~~**Price on the pin.**~~ **SHIPPED 2026-08-20.** Not as originally
    described, though: a label on every pin is destroyed by the stacking, because
    MapLibre resolves a label collision by HIDING one, so a price drawn over
    shared-centroid pins shows one arbitrary property out of however many are
    underneath. The value is on the CLUSTER, which is what you mostly see here —
    `clusterProperties` aggregates a minimum as the worker clusters, so the badge
    reads `3 · from €380.000`. Lone pins carry their own price below the marker.
    Verified on a visible page: correct minimum, and an all-unpriced cluster shows
    its count with NO price rather than `from €0`.

    **Two traps worth keeping.** `["to-number", x, fallback]` does NOT fall back
    for null — the spec converts null to 0 successfully — so the first version
    would have read `from €0` for any cluster holding one unpriced property.
    Hence the explicit `hasPrice` flag: a style expression has nothing else safe
    to branch on. And the console warnings this map logs are **not ours**: they
    were measured identical with our layers removed entirely, come from the
    OpenFreeMap Liberty style, and vary with zoom rather than with our data.

  - ~~**Map viewport in the URL.**~~ **DECIDED AGAINST 2026-08-20** (operator).
    Fit-to-results largely obsoleted it: the filters already live in the URL and
    the map fits to the filtered set, so a link already reproduces a meaningful
    view — one derived from the data rather than frozen coordinates. Adding
    `?lat=&lng=&zoom=` would buy little and cost a precedence rule plus a way for
    a shared link to disagree with what it shows. Revisit only if someone wants to
    send *this exact view* rather than *these results*. Original entry: `?lat=&lng=&zoom=` alongside the existing filter
    params, so Map↔List stops throwing the view away and a map position can be
    sent to a colleague. Fits the pattern `parsePropertyFilters` already sets.
    VERIFY: `grep -c "moveend" components/features/properties/map-view.tsx` — `0` = not built.
  - **Hover sync between list and map.** Hovering a list row highlights its pin.
    Only worth it once list and map are visible together, which they are not today.
  - ~~**Draw-a-polygon "search this area".**~~ **DECLINED 2026-08-20 by the
    operator** — not wanted, and it was the only L on the shortlist. The technical
    note is kept because it stays true if that ever changes. Original entry: The genuinely valuable one for real
    estate, and the largest. `properties.location` is already
    `geography(point,4326)`, so the query is `ST_Covers` behind the SAME RLS and
    the SAME filter parser both views share — the work is the drawing UI and
    getting the polygon into the filter object, not the spatial SQL.
    VERIFY: `ls supabase/migrations | grep -ci area_search` — `0` = not built.

  NOT worth building: a map picker on the property form.
  `components/features/properties/map-location-fields.tsx` already accepts lat/lng
  AND resolves a pasted Google Maps link, short links included, which is faster
  than dragging a pin.

- **Leaked-password protection is disabled (operator decision).** Surfaced by
  the `get_advisors` run after applying 0034 to hosted on 2026-08-21, not by a
  code read. Supabase Auth can check new passwords against HaveIBeenPwned;
  it is off. One toggle in the dashboard, no code, no migration — but it is an
  auth-policy change for real users, so it is the operator's call. Sits with the
  other auth decisions (mandatory 2FA) rather than with engineering work.
  **VERIFY:** `get_advisors` type `security` — the `auth_leaked_password_protection`
  lint disappears once enabled. *(present 2026-08-21.)*
- ~~**A save with no coordinates recorded a `location` change every time.**~~
  **FIXED 2026-08-21** (`locationChanged` in `lib/utils/geo.ts`). The inline
  check computed `samePoint` as "both non-null and equal" and treated
  `!samePoint` as changed, so both-null read as a change: every save of a
  coordinate-less property wrote a needless `location` update AND put a false
  entry in the event's changed-field diff — in an app whose whole point is that
  the diff is trustworthy. It went unnoticed until unit inheritance started
  READING that diff and began severing `location` inheritance for a change that
  never happened. **A latent wrong answer stayed invisible until something
  depended on it.**
  **VERIFY:** `grep -c "locationChanged" lib/utils/geo.ts` — 0 means reverted.
- ~~**HOSTED GRANTS ON `mandates_safe` ARE WIDER THAN THE REPO ASKS FOR — SECURITY.**~~
  **FIXED 2026-08-21, migration `0037`, applied to hosted the same day.** Hosted
  and local ACLs are now byte-identical:
  `{postgres=arwdDxtm, service_role=arwdDxtm, authenticated=r}`. Measured after:
  `anon` can neither read nor insert, `authenticated` can read and not insert.
  The RLS suite (48) and the mandate E2E both passed against the reduced grants
  before it went to production, so listing managers still read the view.

  `service_role` deliberately untouched — 0022 owns that question. The other two
  views in `public` (`geography_columns`, `geometry_columns`) carry the same
  broad grants and are deliberately left alone: they arrive with PostGIS and are
  not this project's to manage. The original entry follows.

  - **HOSTED GRANTS ON `mandates_safe` (original entry).** Measured, not inferred:

  | | `anon` | `authenticated` |
  |---|---|---|
  | hosted | `arwdDxtm` | `arwdDxtm` |
  | local | `Dxtm` (no select) | `rDxtm` (select only) |

  `0002` grants **`select` to `authenticated` and nothing else**, and no migration
  revokes anything on this view — so hosted picked the rest up from Supabase's
  default privileges on `public`, and local (correctly) did not. Hosted has been
  the outlier since the view was created.

  **Why the write bits matter here specifically.** `information_schema.views`
  reports `is_updatable = YES` and `is_insertable_into = YES` — it is a simple
  view over one table, so Postgres makes it auto-updatable. Its owner is
  `postgres`, which **has `rolbypassrls`**, and it is not `security_invoker`. So a
  write routed through the view is performed as the owner and **does not go
  through `mandates` RLS**, which is otherwise the only thing stopping a
  non-admin creating mandates or setting `commission_pct`. An INSERT is the live
  path: an auto-updatable view without `WITH CHECK OPTION` does not apply its own
  WHERE clause to inserts. UPDATE/DELETE are bounded by that WHERE, which for
  `anon` matches nothing.

  **NOT EXPLOITED — this was established from catalogue facts only.** No write
  was attempted against production.

  **Not caused by 0036**, which uses `create or replace view` and preserves the
  ACL: `relacl` was captured before and after and is byte-identical.

  The fix is a revoke bringing hosted in line with what 0002 already says, and it
  cannot break the app — every mandate write goes through the base table as
  admin, and no code reads this view as `anon`. It is still a production
  permission change, so it wants an explicit yes rather than being folded into a
  feature migration.
  **VERIFY:** compare `relacl` for `mandates_safe` on hosted against local; the
  entry is closed when `anon` has no `arwd` and `authenticated` has `r` only.
- **NOTE — `recomputeQualityScore` reads mandates from a table that depends on WHO IS
  CALLING — noted 2026-08-21, handled, worth remembering.** The app reads
  `mandates_safe`, because listing managers have no base-table SELECT and reading
  `mandates` scored their saves 10 points low. A script running as `service_role`
  reads NOTHING through that view — its WHERE tests `current_org_id()` and
  `current_role_gnk()`, both null outside a user session — so it scores every
  mandated property 10 points low instead. Opposite blindness, same symptom.
  There is no single source correct for both, so `mandateSource` is now an
  explicit option and the caller says which. **Caught by dry-running the
  recompute script before letting it write.** Any future job that scores
  properties outside a user session must pass `mandateSource: "base"`.
- **NOTE — A NEW TABLE NEEDS AN EXPLICIT `REVOKE` BEFORE ITS `GRANT`. This rule was
  ALREADY WRITTEN DOWN and I did not follow it — 0039 broke it, 0040 corrected
  it.** `0023` documents the whole trap in its own comments, having hit it on its
  own apply in 2026-08: *"Hosted Supabase applies default privileges that hand
  `anon` and `authenticated` full DML on every new table in `public`; the local
  stack does not. So a migration that only GRANTs produces two different
  databases."* It even records the same mitigating detail — RLS still denied anon
  every row, so nothing was exposed.

  **The failure is therefore not the discovery, it is that the rule lived only in
  a migration comment nobody reads before writing a NEW migration.** That is why
  it is here now, in the file the header tells you to check before starting
  anything. Knowledge in a 2026-08 migration's preamble is not knowledge the next
  table gets for free. Supabase sets default privileges on `public`
  that fire at `CREATE TABLE`, and `grant` is ADDITIVE. So a migration that only
  grants ends up with the platform's grants PLUS its own:

  | | 0039 intended | 0039 actually got |
  |---|---|---|
  | hosted | `authenticated=arwd` | `anon=arwdDxtm`, `authenticated=arwdDxtm` |
  | local | `authenticated=arwd` | `anon=Dxtm`, `authenticated=arwdDxtm` |

  Every older table is clean (`price_lists` and `payment_plans` read
  `{postgres, service_role, authenticated=arwd}`) because 0001/0002 predate the
  current default privileges — **not** because granting is sufficient.

  It was caught by reading `relacl` after applying, not by any test: the app
  worked perfectly either way, because `unit_types` is a TABLE with RLS, so
  anon's grant was still filtered by policies testing `org_id =
  current_org_id()`. That is why this is defence-in-depth restored rather than a
  hole closed — unlike 0037, where the grant on a SECURITY DEFINER view WAS the
  whole control.

  **Rule for the next table: `revoke all ... from anon, authenticated` first,
  then grant exactly what is wanted, then assert the resulting `relacl` matches
  a table you trust.** 0040 does all three and is the template.
  **VERIFY:** every RLS table should give anon nothing —
  `select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity and has_table_privilege('anon', c.oid, 'INSERT')`
  returns 0 (measured 2026-08-22, hosted).
- Forgot-password flow on `/login` (doc 05): Supabase `resetPasswordForEmail` +
  reset page + email template. Natural fit with Phase 2 Resend integration.
  **VERIFY:** `grep -rl resetPasswordForEmail app lib` — any hit means shipped.
  *(0 files on 2026-08-11.)*
- Dark mode (doc 06 lists it as backlog).
  **VERIFY:** `grep -c "dark:" app/globals.css` — 0 means not started.
  *(0 on 2026-08-11. Do NOT check with `grep next-themes`: `components/ui/sonner.tsx`
  imports `useTheme` as shadcn boilerplate and reports a false hit.)*
- Restore `app/(app)/properties/loading.tsx` skeleton once Next.js fixes the
  queued-suspense-reveal hydration bug (see DECISIONS 2026-07-12 · T3.5).
  Re-test: property detail tabs must stay clickable with the file present.
  **VERIFY:** `ls "app/(app)/properties/loading.tsx"` — exists means restored.
  *(absent on 2026-08-11.)*
- Keys i18n: register/movement dialog strings are hardcoded English (Phase 1
  ships English; the transfer/mark_lost/edit/history UI landed in the
  2026-07-20 keys audit, T-audit).
  **VERIFY:** `grep -rl useTranslations components/features/keys` — 3 of 3
  components means done. *(0 of 3 on 2026-08-11.)*
- Settings/users: invite emails, self-service password reset and "reset 2FA"
  (doc 05) — all ride the Phase 2-3 email integration; Phase 1 invites hand
  over a one-time password (DECISIONS 2026-07-14 · T5.4).
  **VERIFY:** `grep -rl inviteUserByEmail app lib` — any hit means shipped.
  *(0 files on 2026-08-11.)*

- Audit remaining `z.string().uuid()` usages (leads.ts, units.ts,
  properties.ts required ids) for the Zod 4 strict-RFC-4122 trap: Postgres
  accepts any 32-hex uuid but Zod 4 `.uuid()` rejects e.g. the seeded
  `11111111-…` fixture ids. `optionalUuid` in deals/properties validators
  already fixed to `z.guid()` (T3.2); the rest only ever see
  `gen_random_uuid()` values today so they are safe in practice.
  **VERIFY:** `grep -rn 'z\.string()\.uuid()' lib | wc -l` — 0 means the audit
  is finished. *(4 usages on 2026-08-11.)*
- ~~Dashboard SQL-side aggregates~~ — **DONE 2026-07-23** (audit PERF-3,
  migration 0018 `admin_dashboard_stats`). The SUMS no longer undercount past
  the caps; proven with a rolled-back 2,100-deal probe (old capped sum was
  €122,000 light). 9 dashboard round trips became 4. RLS test 22 pins the
  SECURITY INVOKER org scoping.
- Dashboard KPI deltas vs the previous period (7d vs prior 7d, month vs last
  month) — same queries with a shifted window.
- "Lost this month" counter beside "Won this month" for honest pipeline health.
- Admin visibility into org-wide overdue tasks and unassigned leads (agents
  see only their own).
- "View all →" footer links on the admin Latest-events and Mandates-expiring
  cards once a canonical events/mandates list page exists to link to.
- Property importer `photo_folder` support (doc 09): ingest photos from
  `import-media/<folder>/` through the T1.4 media pipeline. T5.6 imports all
  other columns; photo ingestion deferred.
- `/leads/[id]` lead detail page (doc 05): lead summary + editable fields +
  conversation/event history (EventTimeline) + convert panel. The inbox now
  covers link contact / assign / correct / reopen / convert / close inline
  (2026-07-15), so the standalone page is deferred as a nice-to-have. A
  converted lead links out to its deal via "View deal →".
- Leads inbox: pagination past the current 100-row slice (header counts are
  already exact DB counts, 2026-07-16). The status filter half of this line
  shipped 2026-07-21 — see DECISIONS T-list-scope.
- List scope follow-ups (T-list-scope): deals/viewings/offers lists should get
  the same scope treatment their terminal statuses already imply. (The
  property Archive/Restore button half of this line shipped 2026-07-21 — see
  DECISIONS T-property-archive.)
- `JWT issued at future` resilience (seen on prod 2026-07-19 and again
  2026-07-21, count 1 each, route `/properties/[id]`; also hit locally on
  2026-07-21 where the Docker VM clock had drifted while the host clock was
  fine). A slightly future-dated access token makes PostgREST reject the query
  and the user gets the "Couldn't load properties" boundary until they reload
  or re-login. Not a code defect and rare, but it is user-visible and
  self-inflicted-looking. ~~Options: a one-shot retry on that specific PostgREST
  message, or nudging GoTrue/Supabase clock-skew tolerance.~~ **Both measured out
  2026-08-08 — see the third-sighting entry below for the numbers.** Diagnosis
  note: the local fix is clearing cookies + re-login to mint a fresh token, NOT
  restarting the Supabase stack.
- Retention-expiry view (T-contact-erasure follow-up): erasure stamps
  `contacts.retention_until` (erasure date + 5y AML duty) but nothing yet acts
  on it, so retained KYC documents would sit in the bucket forever — which is
  the GDPR storage-limitation problem in slow motion. Needs an admin view
  listing contacts whose `retention_until` has passed (the partial index
  `contacts_retention_idx` from 0017 already supports the query) plus a
  "purge retained documents" action reusing the erasure action's guarded
  delete + storage-removal path. Deliberately deferred: the earliest real
  expiry is 2031.
- Erasure coverage gaps (T-contact-erasure): `deals.commission_notes` and
  `viewings.notes` are free text that may name the data subject; both are
  retained today under the legal-claims basis. If a data subject disputes that,
  they need a review path. Also `leads.lost_reason` is left intact.
- Add-lead dialog: optional property link (schema + createLead already accept
  `property_id`; the form never sends it) and an optional backdated
  `received_at` for leads entered after the fact, so the response-time KPI
  reflects reality.
- RLS follow-up: read the contacts/properties/viewings/tasks UPDATE policies
  with the client and decide whether cross-member hand-off should be locked
  down like leads/deals (0009) or stays intentional collaboration.
- Event log durability: logEvent runs after its mutation commits, so a failed
  event insert surfaces as an action error the user retries (risking a
  duplicate mutation). Long-term: write event + mutation in one transaction
  via RPC or trigger.
- Pipeline board: filter bar (agent, expected-value range) and a board-level
  open-value total in the header.
- Pipeline board: stale-deal highlighting — tint cards whose
  `stage_entered_at` tenure exceeds a per-stage threshold (column is in place
  since 0011).
- Properties list: column sorting (price, score, updated) — currently fixed
  `created_at desc` only — plus a `?tab=` param on the detail page so
  Media/Documents tabs are deep-linkable.
- Property media: drag-and-drop photo reorder with dnd-kit (pin `DndContext
  id`, see pipeline board) replacing the up/down arrows; re-watermark
  renditions when visibility changes (watermark currently applies only at
  upload time, so a private→public flip publishes unwatermarked images).
- Rent price history: the 0005 trigger only tracks `asking_price`; tracking
  `rent_price_month` needs a `price_type` discriminator column on
  `price_history` (schema change, not just a trigger edit).
- Properties module i18n (en/el/ru) for consistency with the dashboard pass —
  the module ships hardcoded English per the Phase 1 spec.
- Search index follow-up: `properties_ref_trgm` covers `reference` only;
  `address` / `title->>en` ilike scans are unindexed (fine at internal scale).
- Bulk list actions (multi-select → status/visibility change) and CSV export,
  if the team asks for them.
- Contacts follow-ups (T-audit-contacts): merge as a SECURITY DEFINER RPC for
  true atomicity (current app-side merge is archive-first + idempotent-resume);
  additional_phones add/remove UI (today they only originate from merges);
  contacts module i18n (en/el/ru); CSV export of the filtered list; filter
  inputs don't re-sync on browser back/forward (applied filters do); email
  uniqueness is advisory-only (no partial unique index like phone — add one if
  duplicate emails start appearing); `/contacts?tab=` deep-links.
- Viewings follow-ups (T-audit-viewings): reschedule/edit action
  (`checkViewingConflicts` already takes `excludeId` for it; must clear the
  route stamp when the day changes); optional deal picker in the create dialog
  (`deal_id` is accepted by the schema/validator but no UI sends it); admin-only
  "reopen to scheduled" recovery for mis-clicked terminal statuses; decide the
  fate of the unused `viewings.owner_notified` column (Phase 2 owner
  notifications?); calendar hint when paging past the 90-day/500-row fetch
  window; route save as a single RPC for atomicity (currently N sequential
  updates); "Mark completed" one-tap on the slip-signed success panel.
- Tasks follow-ups (T-audit-tasks): edit / delete / reschedule-due-date UI
  (delete RLS exists but nothing uses it; auto renewal tasks can only be
  completed, never dismissed or snoozed); entity-linked tasks — `contact_id` /
  `deal_id` columns exist (contact-merge even repoints them) but no UI sets or
  displays them; "Add task" buttons on property/contact/deal detail pages;
  admin section on /tasks for org-wide overdue + unassigned tasks with a
  claim/assign control (0012's admin fallback prevents new orphans, but an
  explicit surface beats a fallback); tasks module i18n (en/el/ru); feedback
  nudge rows could show the contact name next to the property ref.
- Settings follow-ups (T-audit-settings): admin "Reset password" button on the
  users table (regenerate a temp password via the existing admin API + the
  credentials-shown-once dialog — closes the no-SMTP lockout gap until Phase 2
  email); force password change on first login (user_metadata flag + redirect);
  delete-unused-area button (the areas_delete RLS policy exists but no UI calls
  it); per-stage deal counts in the stages editor so delete refusals are
  predictable; "verified N months ago / never verified" staleness badge on
  cyprus-config cards; settings module i18n (en/el/ru); org-scoped branding
  paths if multi-org ever ships (branding/logo.png is global today).
- ~~Reports follow-ups (T-audit-reports)~~ — ALL SHIPPED: deal filter,
  generated-reports list, verify-a-report and the nightly chain cache as
  T-audit-reports-2 (migrations 0015/0016); module i18n as T-audit-reports-3.
- ~~Event-line vocabulary i18n (`describeEvent`)~~ — SHIPPED as
  T-audit-events-i18n: `describeEvent` takes a translator; `EventTimeline`
  passes the request-locale one so every general timeline translates; the
  evidence record passes a pinned English one so preview + PDF stay English.
  `events` namespace in en/el/ru. The event PAYLOAD values (names, section
  keys, channels, stage names, user-typed reasons, file names) deliberately
  stay as-stored — only the template text translates.

- ~~**CSV export — remaining lists.**~~ **ALL SHIPPED 2026-07-24, the day after contacts** — properties (`0e57f5c`), leads (`0e6544d`), deals (`8624e59`), viewings (`bd8bf50`), keys (`04b4d4f`), tasks (`a29a222`, whose message says "completes the rollout"). Seven export routes under `app/(app)/*/export/route.ts`, five extracted `lib/queries/*-list.ts` modules each with a colocated unit test, and seven E2E specs (`tests/e2e/*-export.spec.ts`). Exactly the plan this entry described, executed in full.

  **This entry stayed open for 18 days and sent a session off to rebuild finished work on 2026-08-11.** It was caught by globbing `app/**/export/**/route.ts` before writing anything. **The lesson is the file's, not the reader's:** an entry describing work to do is a claim, and claims here go stale silently. Before starting anything from BACKLOG, check whether it already exists.
- ~~**Export audit logging (decision needed).**~~ **Resolved 2026-07-23: yes, log exports.** Built in `lib/services/export-audit.ts` (org-level `export`/`exported` event, written before the CSV is returned). Contacts export logs; the remaining lists inherit it via `logListExport`. See DECISIONS `T-export-audit`.
- ~~**Database-level 2FA enforcement (security, follow-up to C2).**~~ **SHIPPED AND APPLIED TO HOSTED 2026-08-11** — migration 0029 `require_aal2`, exactly the opt-in template this entry prescribed, on all 29 RLS-enabled tables. Evidence in IMPROVEMENTS C2, reasoning in DECISIONS `T-aal2-rls`, rollback in `docs/superpowers/plans/2026-08-10-c2-db-2fa-enforcement.md`.
- ~~**A dormant admin has no second factor**~~ **CLOSED 2026-08-25 — THE CONDITION NO LONGER HOLDS, measured rather than assumed.** Both production admins now carry a verified factor and both have signed in recently: `gerasimos@` 1 factor, last sign-in 2026-08-20 (the entry below says he had none and had not signed in since 2026-07-15), `nontari@` 1 factor, last sign-in 2026-08-18. **This was stale in the DANGEROUS direction** — a reader would have acted on an exposure that had already been closed by the account simply enrolling. The original assessment follows, because the reasoning about blast radius is still the right reasoning. Production has
  two active admins. `nontari@` enrolled TOTP on 2026-08-09 (factor `verified`).
  `gerasimos@` is also a full admin — same reach over client KYC and the
  evidence chain — with **no verified factor and no sign-in since 2026-07-15**.
  A dormant privileged account protected by a password alone is the cheapest way
  into this system, and it is also the account that would carry the blast radius.
  Operator call, not an engineering one: enrol it, downgrade it to `agent`, or
  deactivate it until it is needed. Deliberately not changed by an agent — it is
  someone's account. Note it doubles as the lockout safety net for C2's
  DB-level enforcement, so decide it BEFORE that lands.

  **Decision (2026-08-09): left as admin, deliberately.** Two consequences to
  carry forward. (1) He should enrol TOTP at `/security` next time he signs in —
  the account is otherwise password-only. (2) He is currently the ONLY other
  admin, which makes him the lockout safety net for C2's DB-level 2FA
  enforcement; that is an argument for keeping him, not against, but it means
  C2 must not assume every admin has a factor.
- ~~**Settings → Users cannot show who has 2FA — which is why the dormant admin
  went unnoticed (noticed 2026-08-09).**~~ **SHIPPED THE SAME DAY** — migration
  0028 `org_mfa_status()` plus a `2FA` column in
  `components/features/settings/users-panel.tsx`, which also renders an explicit
  "could not read 2FA status" state rather than letting a failed query read as
  "nobody has 2FA". This entry stayed open in BACKLOG for two days after the work
  landed; it was found on 2026-08-11 by checking the component instead of reading
  the note. The write-up below is kept because the reasoning still explains the
  shape of the solution.

  **Not a five-minute job, which is why it is written down rather than done.**
  There is no public admin API for another user's factors in `@supabase/auth-js`
  2.x — `listFactors` exists only on a user's OWN client, and the admin variant
  is private. So it needs a `SECURITY DEFINER` function over `auth.mfa_factors`,
  roughly:

  ```sql
  create function org_mfa_status()
  returns table(profile_id uuid, has_verified_factor boolean)
  language sql security definer set search_path = public, auth as $$
    select p.id,
           exists (select 1 from auth.mfa_factors f
                    where f.user_id = p.id and f.status = 'verified')
      from profiles p
     where p.org_id = current_org_id() and current_role_gnk() = 'admin';
  $$;
  ```

  Treat it as a security change, not a UI one: **HANDOFF §4.3 — a new security
  definer function is anon-executable by default**, so it needs the explicit
  `revoke … from public, anon` and a `get_advisors` pass, which is precisely
  what migration 0021 got wrong. Then a "2FA" column and an RLS test that a
  non-admin gets nothing back.
- ~~**RLS helper functions are called ONCE PER ROW — counted, 2026-08-11.**~~ **CLOSED 2026-08-25** — re-verified on hosted with the entry's own two checks: `0030_hoist_rls_helpers.sql` is in the repo and `rls_hoisted_policy_count()` returns **24** with **0** bare calls, exactly what it claimed. The body below is kept for the measurements.
  ~~**FIXED ON THE 7 LIST TABLES**~~ — **DONE AND APPLIED TO HOSTED 2026-08-11**,
  migration 0030. 24 policies hoisted, 0 bare, 115 policies before and after,
  `get_advisors` clean. Design and plan under `docs/superpowers/`; rollback is
  `docs/superpowers/plans/2026-08-11-rls-hoist-rollback.sql`; the reasoning is
  DECISIONS `T-rls-hoist`.

  **VERIFY — two checks, because "built" and "applied" are different states:**

  ```
  in the repo:  ls supabase/migrations/0030_hoist_rls_helpers.sql
  on hosted:    select public.rls_hoisted_policy_count();   -- 24 = applied, error = not
  ```

  *On 2026-08-11 after the apply: present in the repo, and 24 on hosted.*

  **62 permissive policies remain bare on purpose** — 36 on config/staff-bounded
  tables, 26 read a few rows at a time. Widening to those is a separate decision,
  not an oversight.

  What landed locally: 24 permissive policies on `contacts`, `deals`, `events`,
  `leads`, `properties`, `tasks`, `viewings` rewritten with both helpers wrapped
  in `(select …)`. **62 permissive policies remain bare on purpose** (36 on
  config/staff-bounded tables, 26 read a few rows at a time).

  **Verified, and the meaning-preservation twice over:** the migration's own
  equivalence check (0 changed on an untouched database, exactly 1 when a policy
  was deliberately weakened), plus an independent out-of-band diff that stripped
  the wrappers back out of the migration and compared against the rollback script
  — byte-identical for all 24. `EXPLAIN` shows `InitPlan … loops=1`; 48 RLS tests
  pass with the 44 pre-existing unchanged; 115 policies before and after.

  **Three traps found while building it, all worth keeping.** `pg_policies.qual`
  is deparsed by `pg_get_expr()` against the CALLER's `search_path`, so with
  `pg_catalog` pinned the call renders `public.current_org_id()` and an
  unqualified literal silently inverts the guard — the fix normalises the
  qualification away rather than depending on a path. The equivalence check must
  normalise BOTH sides identically, or a re-run against an already-hoisted
  database reports "changed 24 predicates" when nothing changed. And
  `rls_hoisted_policy_count()` matches `current_org_id()` only, so it is complete
  only alongside `rls_bare_helper_calls()`.

  Original finding follows.

  83 of the 115 policies call `current_org_id()`; 62 call `current_role_gnk()`.

  **The measurement, on a purpose-built 20-row probe table:**

  | policy predicate | calls for one 20-row scan |
  |---|---|
  | `org_id = probe_fn()` | **21** |
  | `org_id = (select probe_fn())` | **1** |

  The probe was a `stable security definer plpgsql` function — the same shape as
  `current_org_id()` — that raised a `NOTICE` per invocation; the notices were
  counted. It scales with rows, so the cost is linear in result-set size on every
  query against 26 tables.

  **Two false starts worth recording, because both produced confident wrong
  readings.** `pg_stat_user_functions` does not track here: three explicit calls
  moved the counter by 0, so an early "0 calls" reading was the instrument, not
  the truth — **validate a counter by making it move before trusting a zero.**
  And `set local role authenticated` outside a transaction block is a no-op
  warning, so the first probe ran as `postgres`, which bypasses RLS entirely and
  evaluated no policy at all.

  Plan shape alone does NOT settle this — `current_org_id()` appears as an
  `Index Cond` in some plans (evaluated once, as a scan key) and a `Filter` in
  others. An earlier version of this entry read one plan and generalised. Count
  calls, don't read shapes.

  **The fix** is Supabase's documented `(select …)` wrapper; 0029 already writes
  its own predicate that way. **Still not urgent** — the largest table holds tens
  of rows, so 21 calls versus 1 is currently microseconds. It becomes real when
  the desk puts volume in. Each rewrite is a drop-and-recreate of a live security
  policy (there is no `create or replace policy`), so it wants its own session
  with the RLS suite green before and after.
- ~~**Sentry has no source maps and no release tracking (noticed 2026-08-09).**~~
  **SHIPPED 2026-08-11 (`70e4ceb`) — one acceptance check still open.**

  `next.config.ts` now wraps with `withSentryConfig`. The deploy uploaded **751
  files in two bundles**, both bound to release `70e4ceb9205d` (Sentry →
  Settings → Source Maps), and that release is the first carrying a
  `vercel-production` deploy marker instead of sitting unfinalized.

  **STILL UNVERIFIED, deliberately: that a real stack trace resolves to a
  filename.** Maps being present does not prove they MATCH the deployed
  bundles — mismatched paths are the classic silent failure, and no local build
  can show it. Operator decision 2026-08-11 was to wait for a genuine client
  error rather than manufacture one. **When the next client error appears, read
  its top frame.** A path like `components/features/…` means this worked;
  another `chunks/44sdjkbb-9351.js` means the maps do not match and this
  reopens.

  Two claims in the original entry below were wrong — both corrected by checking
  the dashboard rather than reading the note. `SENTRY_ORG` is in Vercel too (not
  just AUTH_TOKEN and PROJECT), and **releases were already being created and
  attached**: the Vercel integration did that, which is why 2026-08-10 issues
  read `release 7b9c11c213c7`. What was missing was source maps and *finalized*
  releases, not release names.

  Build behaviour proven three ways before shipping — no token (0 maps, exit 0),
  bad token (**exit 0**, 401s logged, so an expired credential cannot break
  deploys), upload enabled (60 client maps). `.map` files are deleted after
  upload *even when the upload fails*, and production still answers 403 for a
  `.js.map`. Reasoning in the commit; the original entry follows.

  - **Sentry has no source maps and no release tracking (original).**
    **[HISTORICAL — SUPERSEDED BY THE ENTRY ABOVE, WHICH SHIPPED. Not open work.]**
    Delivery is fixed and alerting is proven, but the DATA is poor. `next.config.ts`
    does not wrap with `withSentryConfig`, so stack traces arrive minified — the
    2026-08-03 production error read
    `.next/server/chunks/ssr/[root-of-the-server]__1852x8s._.js:1:6032`, which
    names no file and no line — and no release is attached, so an issue cannot be
    tied to the deploy that caused it. With several deploys a day that is the
    difference between "this broke today" and "this broke, somewhere, sometime".

    The prerequisites are ALREADY in Vercel and unused: `SENTRY_AUTH_TOKEN`,
    `SENTRY_PROJECT` and `VERCEL_GIT_COMMIT_SHA` exist (added Aug 3 by the Sentry
    integration) — they are exactly what the build plugin needs. So this is
    `withSentryConfig` plus a release derived from the commit SHA.

    Treat as a BUILD change, not a config tweak: it alters the production build and
    uploads source maps at build time, so it wants a green CI run and a check that
    the deploy still succeeds before it is trusted. Verify by reading a real stack
    trace in Sentry afterwards, not by the plugin being present.
- **Mandatory 2FA — DECIDED YES 2026-08-26. LEFT OFF UNTIL BEFORE THE NEXT
  HIRE, operator decision the same day.** It binds nobody today: production has
  two users and both are already enrolled (measured 2026-08-26), so the harness
  work below buys nothing until a third person exists.

  **THE TRIGGER IS WIRED, NOT JUST WRITTEN DOWN.** "Before the next hire" is a
  condition nobody watches, and a note in this file is exactly how the last
  conditional item got missed — the contact portfolio tab was rebuilt four days
  after it shipped because its duplicate sat unread here. So the reminder lives
  on the **Invite user dialog**, which is the only moment it matters: inviting
  someone while `MFA_REQUIRED` is false shows a warning saying they will be able
  to sign in with a password alone. It disappears by itself once the switch is
  thrown, because it renders on `!MFA_REQUIRED`.

  **MECHANISM SHIPPED, SWITCH NOT THROWN.** The operator asked for it. It cannot be turned on without shipping a
  red pipeline, and BOTH halves were measured rather than predicted:

  * **Database half** (drop the opt-in arm from `mfa_satisfied()`): the RLS
    suite goes from **58 passing to 4 failed / 16 passed / 38 skipped**, three of
    four files down. The shared fixtures hold no factors ON PURPOSE —
    `mfa-enforcement.test.ts` says so in its header, because a verified factor
    gates that user's aal1 sessions and would break every other test.
  * **App half** (`MFA_REQUIRED`): `tests/e2e/auth.setup.ts` logs in and asserts
    the Dashboard heading. With the gate on, the seed admin — who has no factor
    — lands on `/security` instead, the setup fails, and it is a `dependency` of
    every project, so **all 204 E2E tests go down with it**. That file already
    records the seed admin having no factor as a KNOWN GAP.

  **What IS shipped and verified in a browser:** the proxy gate, the redirect to
  `/security?enrol=required`, and the banner explaining why. A factor-less
  session hitting `/dashboard`, `/properties` or `/contacts` lands on enrolment;
  enrolment stays reachable because neither `/security` nor the app shell
  touches an RLS table (that was the trap to avoid — a locked door with the key
  behind it); and there is no redirect loop. **Turning it on is one word** in
  `lib/constants/mfa.ts`.

  **What it costs to flip:** the E2E auth setup must enrol a TOTP factor for the
  seed admin and store an aal2 session, and the RLS fixtures must do the same in
  `beforeAll`. Feasible — `lib/testing/totp.ts` and `mfa-enforcement.test.ts`
  already do it for dedicated users — but a test-harness project with real flake
  risk: that file dodges a 30-second TOTP boundary for ONE user, and this is
  every fixture on every run. `mfa.spec.ts` needs revisiting too, since it tests
  enrolling from scratch as the seed admin.

  **Recovery path, since the entry asked for one:** Supabase issues no recovery
  codes, so the answer is a second enrolled admin plus `auth.admin.mfa.deleteFactor`
  through the GoTrue admin API, which the app already wraps for unenrolment.
  Production satisfies it today — two admins, both enrolled (measured 2026-08-26).
- ~~**Deal-scoped "Log contact" action (follow-up to B7).**~~ **SHIPPED
  2026-08-07 (migration 0025).** It was worse than this entry described: the
  edit did not merely buy 14 days of quiet, it CLOSED the open chase-up
  immediately via `deals_supersede_nudges` and logged
  `reason: deal_contacted_or_closed` against the editing user — the log asserted
  contact nobody had claimed. Silence now has its own column, `last_contact_at`,
  written only by `logDealContact` and by `logConversation` on a converted lead;
  `last_activity_at` still drives the health score and is still bumped by edits.
  The trigger's `WHEN` clause had to move with the predicate — it fired on
  `last_activity_at or status`, so the function alone would have been correct
  while the feature stayed broken. RLS test 27 and the reworked E2E nudge spec
  pin both directions. See DECISIONS `T-deal-contact`.
- ~~**Configurable nudge thresholds (decision, follow-up to B7).**~~ ✅ **DONE
  2026-08-25** (migration 0052). Settings → Nudges, four typed inputs, admin
  only, evented. Built exactly as this entry prescribed — `cyprus_config` +
  a `coalesce` default so the cron survives a missing key.

  **THE DECISION IT ASKED FOR WAS PUT TO THE OPERATOR AND ANSWERED: the health
  score does NOT follow.** It keeps its fixed cliff (full ≤7d, half ≤14d, none
  after). So setting the nudge to 21 days means the score calls a deal stale a
  week before anyone is told, and that divergence is now VISIBLE — the settings
  page says it in plain English — rather than silent, which was the entry's
  actual worry. The reason to refuse coupling: `deals.health_score` and its
  factor snapshot are STORED and recomputed only in-action (T3.3), so a score
  tracking this setting would either be wrong on every existing deal until
  something touched it, or need a mass recompute from a settings save that —
  by T3.3's own rule — writes no event and would be invisible in every
  timeline.

  **This entry undercounted: it is four thresholds, not two.** 0047's 2 days and
  0051's 7 days joined the original 14/48. **`mandate_renewal` was never one of
  them** — 0012 already reads `mandates.renewal_reminder_days` per row, which is
  also the precedent 0052 follows.

  **A BUG WAS FOUND AND FIXED IN THE PROCESS.** The no-contact boundary is a
  function of the threshold, so changing it trips the existing self-heal — and
  that self-heal logged `reason: deal_contacted`, which was safe to assert only
  while the boundary could move for one reason. Writing "the deal was contacted"
  into an append-only log when nobody contacted anybody cannot be taken back.
  The sweep now distinguishes the two (a real contact stamps `last_contact_at`
  AFTER the task was minted) and writes `threshold_changed`. RLS test 36 pins
  both arms.

  **The risk this entry was really about did not disappear, it MOVED** — from
  "two hardcoded copies" to "the SQL reader and the TypeScript reader". They are
  now a matched pair: `public.nudge_threshold()` and `readThreshold()` in
  `lib/services/nudge-thresholds.ts` implement the same five fallback rules, and
  `nudge-thresholds.test.ts` runs the same table against TS that 0052's
  assertion block runs against SQL. **Change one, change the other and both
  tables** — otherwise the settings page displays a number the sweeps are not
  using, which is worse than the hardcoding was because it looks authoritative.
- ~~**Nudges can land on a deactivated assignee (B7 + 0012).**~~ **RESOLVED
  2026-08-02 (migration 0024).** Every arm of the three-armed fallback is now
  active-only in all three system kinds (`deal_no_contact`, `viewing_feedback`,
  `mandate_renewal`) — previously only arm 3 checked `is_active`, so the guard
  stopped exactly where the fallback started. Fixing the arms alone was not
  enough: the cycle guards refuse to re-mint a task for a boundary that already
  has one, and deactivation usually happens *after* assignment, so the re-home
  is stated as an invariant and self-healed nightly as step 5 of
  `create_followup_nudges` (which runs 03:15, after expire-mandates at 03:00, so
  one place owns it for all three kinds) plus a one-time backfill. RLS test 26
  pins it. Note the test asserts the assignee **as minted**, read from the
  `followup_task_created` event: step 5 re-homes within the same invocation, so
  asserting on `tasks.assignee_id` alone passes even with the arms reverted —
  verified by reverting them and watching it still pass.
- ~~**Human-assigned tasks are still stranded by deactivation.**~~ **RESOLVED
  2026-08-09 — "Needs an owner" on `/tasks`, admin-only.** No migration: RLS
  already granted admins the whole org on `tasks_select`/`tasks_update`, so this
  was a missing SURFACE, not a missing permission.

  It covers **both** invisibilities, not just the one this entry named. A NULL
  assignee is equally unreachable and is genuinely possible — `create_followup_nudges`
  ends its three-arm coalesce at "oldest active admin", so an org with no active
  admin mints one. Reassign is explicit and admin-only, and logs the existing
  `assigned` event (`to_name`), so no new event type or i18n key was needed.

  **The precondition is the subtle part.** `toggleTaskDone`'s pattern folds the
  no-op check into the write so a double submit cannot log twice, but a bare
  `.neq("assignee_id", to)` evaluates to NULL for an unassigned row and PostgREST
  drops it — silently refusing the exact case this feature exists for. It is
  `.or("assignee_id.is.null,assignee_id.neq.<id>")`, and `stranded-tasks.spec.ts`
  reassigns the orphan specifically to pin that path.

  Original entry: 0024's sweep is
  deliberately scoped to system-generated rows (`kind is not null`); a task one
  person assigned to another by hand still sits invisible if the assignee is
  deactivated. Re-homing those silently would overwrite a human's deliberate
  choice, so it wants a surface (an admin "tasks held by deactivated users" list
  with an explicit reassign) rather than a cron rule. Pairs naturally with the
  org-wide overdue/unassigned admin view already in this file.
- ~~**`csp.spec.ts` depends on test residue.**~~ **RESOLVED 2026-08-02.** The
  two detail tests asserted `expect(href).toBeTruthy()` on the first row of
  `/properties` and `/contacts`, which only `happy-path.spec.ts` creates — so
  against a freshly reset database both FAILED on run 1 and passed on run 2.
  Of the two fixes offered here, **seeding** was chosen over self-skipping:
  these are the heaviest client routes in the app (tabbed forms, media grid),
  and dropping their CSP evidence silently on a fresh database is the worse
  trade. The spec now prefers a real row when one exists — real data exercises
  media and documents a bare fixture does not — and seeds its own property and
  contact when the list is empty, removing them in `afterAll`. Cleanup is
  marker-based (`reference like 'CSP-FIXTURE-%'`; `contacts.notes`, since
  `properties` has no `notes` column) so a crashed run is swept by the next one
  rather than leaking rows. Seeding needs the service key, so against a
  non-local base URL the tests still self-skip rather than assert falsely.
  Verified without a `db reset` by forcing the empty-list branch, confirming
  both rows were really created, and watching the marker sweep remove them.
  **The real proof was finally taken 2026-08-08** — the substitute was only ever
  used because disk was down to 9.3 GB, and after the workspace and Docker moved
  to `D:` the reset cycle became affordable. `supabase db reset` (all 25
  migrations from scratch, leaving `properties=0 contacts=0`) then **run 1** of
  `csp.spec.ts`: 31 passed / 3 skipped, with `property detail` and `contact
  detail` — the two that used to fail on run 1 — both green via the seeding
  path, and `CSP-FIXTURE-%` / `csp-detail-fixture` counts back to 0 afterwards.
- **NOTE — CSP report delivery cannot be confirmed "later" — Vercel log retention is
  ~1 hour on this plan (C1).** `/api/csp-report` sinks to stdout, and HANDOFF
  told the operator to browse production and then grep the runtime logs for
  `[csp]`. A 7-day query returns *"the requested window likely exceeds your
  plan's runtime-log retention (Hobby 1h, Pro 1 day…)"*, so any check made more
  than an hour after browsing will find nothing — and "no `[csp]` lines" would
  be misread as "the policy is clean" when it may mean "reports were never
  delivered, or expired". Those two must not be confused before anyone promotes
  the policy from Report-Only to enforced. Fix: browse and grep inside the same
  hour, or give the endpoint a durable sink (configure the Sentry DSN, which the
  handler already writes to, or add a Vercel Log Drain). Found 2026-07-29.
- ~~**Hosted has `service_role` EXECUTE grants that no migration produces (schema
  drift).**~~ **RESOLVED 2026-07-29 (migration 0022).** Diagnosed from the ACLs:
  hosted carried explicit `service_role=X/postgres` entries on `current_org_id`,
  `current_role_gnk` and `expire_mandates` — hand-applied, not role inheritance
  and not a platform default. Revoked rather than captured as a migration,
  because nothing needs them: the first two are RLS helpers and `service_role`
  bypasses RLS, and `expire_mandates` is pg_cron-only, run as `postgres`, which
  keeps its own grant (0007 §1 said exactly that). Verified no caller exists in
  app code, scripts or tests. `verify-restore.sql`'s expectations, which had
  encoded the drift, were corrected — a migration-built database now passes all
  25 invariants, where four failed before.
- ~~**`lib/supabase/client.ts` is dead code — and that is currently a security
  asset.**~~ **RESOLVED 2026-08-08 — deleted, and the property it provided is now
  ENFORCED instead of accidental.** The file was the only thing that would have
  put a Supabase credential in the browser, and nothing imported it, so "no
  Supabase key ships" was true by luck. `security.spec.ts` did not cover it
  either: it blocks `service_role` / `sb_secret_` and explicitly *permits*
  `sb_publishable_`, so the publishable key could have started shipping with the
  suite still green. The bundle-hygiene test now asserts **no Supabase key of any
  kind** reaches the browser, in both formats (`sb_*` prefix scan and a
  JWT-shaped scan for the legacy anon key), with a note telling whoever trips it
  that adding a browser client is legitimate and they should relax the assertion
  deliberately rather than delete the file it protects.

  **The guard was proved by a negative control, not assumed:** referencing
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` from a client component made the test fail, and
  reverting made it pass. Worth doing given this file's own §2b entry lists four
  ways a green test proved nothing.

  Original entry: `createBrowserClient` is called there and nowhere else; no module
  imports the exported `createClient`. Verified 2026-08-03: no JWT-shaped string
  and no `supabase.co` appears in any of the 63 chunks of a production
  `.next/static` build, so the browser receives no Supabase credential at all.
  Deleting it is the tidy answer, but note the consequence of the opposite
  choice: the day someone imports it, `NEXT_PUBLIC_SUPABASE_ANON_KEY` starts
  shipping to the browser. That is normal and safe for an anon/publishable key —
  it is *designed* to be public — but it should be a conscious decision rather
  than a side effect, and it changes what HANDOFF §2b step 4 can verify. Keep or
  delete deliberately; do not let it happen by accident.
- **NOTE — `JWT issued at future`, third sighting, now with a deployment stamp.** Seen
  again on prod 2026-08-03T17:07:18Z, route `/properties`, count 1, users 1, on
  deployment `dpl_D3WRnCp…`. Same shape as 2026-07-19 and 2026-07-21: a
  slightly future-dated access token makes PostgREST reject the query and the
  user gets the "Couldn't load properties" boundary until they reload or
  re-login. Unrelated to the key rotation — this is the session JWT's `iat`, not
  the API key. It is now the only recurring runtime error in production, and
  `get_runtime_errors` on the Vercel connector makes it cheap to keep counting.

  **MEASURED 2026-08-08, and it rules the retry option OUT.** PostgREST already
  carries its own future-`iat` leeway, so the two options this entry had been
  carrying since 2026-07-19 are not equivalent — one of them cannot work.
  Swept a hand-signed token against the local stack at increasing offsets:

  | `iat` offset | result |
  |---|---|
  | +0s, +5s, +10s, +20s | **HTTP 200** — accepted |
  | +31s, +60s, +120s, +300s, +3600s | **HTTP 401** `PGRST303` `JWT issued at future` |

  The tolerance is ~30s. **So every rejection we have actually seen means the
  token was more than 30 seconds ahead** — which is a broken clock, not the
  sub-second blip the "one-shot retry" idea assumed. A retry would have to sleep
  30+ seconds to land past the boundary, which hangs the page for far longer than
  the error costs; capped at anything sane it never fires at all. A retry wrapper
  was written, unit-tested, and then **deleted rather than committed**, because
  it could only ever have been dead code (DECISIONS 2026-08-08).

  Also now known precisely: the code is **`PGRST303`** at **401**, so detection
  needs no message matching. And note Next redacts server-component error
  messages before they reach `app/(app)/error.tsx` — the browser gets a `digest`,
  not the text — so anything that branches on this must do so **server-side**.

  **Graceful degradation SHIPPED 2026-08-08.** `unwrapRows` routes `PGRST303` to
  a new `/session-clock` page instead of the boundary — it says the clock is
  ahead, that reloading will not help, and offers one button wired to the
  existing `logout()` server action. No auto sign-out (that needs a GET endpoint
  with a side effect, i.e. a logout-CSRF surface) and the page sits outside the
  `(app)` group, because that layout builds its own client and would loop.

  Confirmed by replaying a re-signed session against the running app: +0s/+20s
  render normally, **+31s through +120s land on `/session-clock`**. Which
  incidentally explains why this bug exists — **there are two tolerances.**
  PostgREST refuses from ~31s while GoTrue still calls the user authenticated at
  +120s, so the session passes `proxy.ts` and fails every query. Widening
  tolerance is not available: PostgREST's JWT settings are not exposed on
  Supabase.

  Still open, and now the only part: the underlying clock. This page makes the
  failure legible and one click from recovery; it does not stop a machine whose
  clock drifts half a minute.
- ~~**The signed slip PDF has no recorded hash anywhere.**~~ **RESOLVED
  2026-08-08 (migration 0026).** `viewing_slips.pdf_sha256` is written at signing
  time and the same value goes into the hash-chained `viewing_slip_signed`
  payload, which is the half that cannot be edited afterwards — a column alone
  would be as forgeable as the file. **Left NULL for the one pre-existing slip,
  deliberately:** hashing the bytes in Storage today would assert they are the
  bytes that were signed, which nobody can vouch for, and it would be
  indistinguishable from a hash taken at signing. A null says "unknown", which is
  true. Verified by signing a real slip through the real canvas, then
  re-downloading the PDF and re-hashing it — `sha256Hex(pdf)` returning the hash
  of its argument is trivially true and proves nothing about whether the stored
  value describes the stored file (`tests/e2e/slip-pdf-hash.spec.ts`).

  Originally diagnosed during the
  2026-08-05 Storage restore drill (BACKUP_RESTORE §4c). `viewing_slips` stores
  `signature_sha256` for the signature PNG, and event 60's payload carries that
  same hash — so a corrupted or substituted signature image is detectable. The
  slip **PDF** (`viewing_slips.pdf_path`) has no hash in the row and none in the
  event, so nothing can prove a restored slip PDF is byte-identical to the one
  that was signed. Evidence reports do not share the gap: their generation event
  carries `pdf_sha256`, and that is what made the drill's end-to-end proof
  possible. Fix is small — hash the PDF at generation and put it in the row and
  the `viewing_slip_signed` payload — but it is only forward-looking: the one
  existing slip stays unhashable, so the change wants a decision about whether to
  backfill from the current bytes (which asserts they are the right bytes) or
  leave it null.

---

## Follow-ons from the 2026-08-23 outside report (Phases A–C shipped)

**Nothing here gets built without explicit direction.** Phases A, B and C of
`IMPROVEMENTS_EXECUTION.md` are done and deployed; these are the threads they
deliberately left hanging, and each says why it needs a decision rather than a
developer.

### Needs an operator decision

- **Replace "top agents by activity" on the admin dashboard.** The review is
  right that it is a vanity metric — clicks are not conversion — and 0042 left
  a note saying so in the aggregate. Replacing it means choosing what goes in
  its place: lead-to-viewing, viewing-to-offer, win rate, commission, or some
  mix. That is a desk decision, not a code one. (Dashboard *filters* by
  agent/office/period are a different matter: refused by guardrail 6, and not
  going here.)

- **Sync `properties.status` with a live reservation.** 0044 deliberately does
  not: auto-flipping a listing to `reserved` on hold and back on expiry couples
  two entities through a cron job, and the revert is where that class of bug
  lives. If the desk wants it, the shape is a trigger on `reservations` plus a
  documented rule for what happens when the listing status was changed by hand
  in the meantime — which is the part that needs deciding.

- ~~**Drop `contacts.preferences`.**~~ ✅ **DONE 2026-08-26** (migration 0055),
  operator decision.

  **The precondition was met with evidence, not asserted.** Production held 2
  contacts, both carrying `preferences`, and BOTH WERE LITERALLY `{}`. Nothing
  was ever entered, so nothing was converted and nothing was lost. **The
  migration does not rely on that measurement** — it re-counts at apply time and
  hard-aborts if any row holds anything, so a restored backup or a future
  database cannot lose a blob to this file. Proven by running the guard against
  a row with content: it refused with "1 of 169 contact(s) still hold
  preferences".

  **THE DEPLOY ORDER INVERTED, and the standing rule would have broken
  production.** "Hosted migration BEFORE the merge" is the rule for an ADDITIVE
  change. A drop is the mirror image: reads survive (`select("*")` just returns
  one column fewer) but the live code WRITES the column in three places, and an
  UPDATE naming a dropped column errors. One of the three is **GDPR erasure**,
  whose patch always sets `preferences: {}` — dropping first would have 500'd
  Article 17 until the deploy caught up. Order used: merge, deploy, confirm,
  then drop.

  **It surfaced a real GDPR gap that predates it.** Erasure cleared
  `contacts.preferences` because a buyer's criteria lived there. 0043 moved those
  criteria to `buyer_requirements` ROWS and erasure was never updated to follow,
  so a person's budget, areas and bedroom needs had been surviving Article 17.
  Erasure now deletes those rows, the audit payload counts them, the dialog says
  so, and a test asserts `saved_searches` is in `fields_cleared` — if that ever
  fails, erasure has quietly stopped reaching search history again.

  Removed with it: the Preferences form and its save branch, its validator and
  the `CONTACT_PURPOSES` vocabulary that existed only for it, the legacy blob
  panel on the saved-searches card, and the merge rule that moved a blob into an
  empty primary. **The CSV importer now writes a real saved search** from the
  same columns instead of packing them into jsonb — so an imported buyer is
  matched against listings immediately rather than sitting inert.

### Decision-free once someone asks for them

- ~~**Price-drop campaign.**~~ ✅ **DONE 2026-08-24** (`08c7b00`, migration
  0045). Raises one task when a drop brings a property inside a buyer's budget
  for the FIRST time — `wasPricedOut`, not "can they afford it now", because the
  latter alerts every already-matching buyer on every drop. **Two lessons came
  out of it and generalise:** Postgres `numeric` arrives from PostgREST as a
  STRING, so `Number.isFinite` on it is false and it must be coerced; and a
  discarded error makes a whole feature vanish silently — both swallow sites now
  log to Sentry.
- ~~**New-listing alert.**~~ ✅ **DONE 2026-08-24** (`ae0a6a2`, migration 0046).
  Triggers on a STATUS transition into `MATCHABLE_STATUSES`, which correctly
  also covers a withdrawn listing put back on and a fallen-through sale.
  **This line used to say the unpriced→priced case "belongs here". That was
  wrong** — it belongs to neither alert, because an unpriced property already
  passes the budget hard filter, so setting a price can only ever REMOVE a
  match. Pinned by tests in both modules.
- ~~**Price-drop alerts on a BULK reprice.**~~ ✅ **DONE 2026-08-24**
  (`b490c2e`, migration 0048). One task against the PROJECT, aggregated in
  memory from a single fetch, so round trips are constant whatever the block
  size.

### New, from building the above

- ~~**A `task_kinds` lookup table instead of widening `tasks_kind_chk`.**~~
  ✅ **DONE 2026-08-24** (`9070d23`, migration 0049). **This line overstated the
  case and the migration says so**: adding a kind still needs a migration,
  because a kind with no sweep behind it is an orphan nobody writes. The real
  win is that it is now a one-line INSERT rather than a constraint rewrite, and
  an INSERT cannot silently drop the kinds already there. The FK refuses an
  unknown kind exactly as loudly as the CHECK did, proven in the migration and
  again in RLS test 33.

- ~~**NOTE — CI: `supabase/setup-cli@v1` can fail with "Failed to resolve latest
  Supabase CLI release: rate limit exceeded".**~~ ✅ **FIXED 2026-08-26 — the
  action is gone; the CLI is an exact devDependency.**

  **The cause was `version: latest`**, which makes the action ask the GitHub API
  which release is newest; that call is anonymous and rate-limited. It went red
  TWICE in two days — `6349db3` on `e2e` (08-25), `2affb4a` on `rls` (08-26) —
  **not specific to one job**: it hits whichever job runs the action first, and
  both times the identical content had passed on the branch minutes earlier. The
  job died **before a single test ran**, so the log held no test output at all.

  **FIXED IN TWO STEPS THE SAME DAY, and the second replaced the first.**

  The first attempt (`75ae045`) pinned `version: 2.115.0` on the action in both
  jobs. That killed the API call, and CI proved it — the step went from start to
  `tar xz` in 0.55s with no resolve attempt in the log. But it left the CLI
  version written in TWO places: the workflow, and whatever `npx supabase`
  happened to fetch locally, where nothing was pinned at all. Two numbers that
  must be hand-synced are the same staleness trap in a new spot.

  **The shape that shipped (`9d70037`, then this) makes package-lock.json the
  only place the version lives.** `supabase` is an exact devDependency —
  `"supabase": "2.115.0"`, no caret, because `npm i -D` writes `^2.115.0` by
  default and a caret is precisely the floating being removed. `supabase/setup-cli`
  is GONE from the workflow and the three call sites go through `npx`
  (`npx supabase start` in `rls` and `e2e`, `npx supabase status -o env`).
  `npm ci` already ran before every one of them, so `npx` resolves from
  node_modules rather than the network.

  **Why the npm route cannot reproduce the failure:** the package has NO
  postinstall, and the platform binaries are `optionalDependencies` pinned to
  exact `2.115.0` on the npm registry (`@supabase/cli-linux-x64` and seven
  siblings, all in the lockfile). Nothing anywhere in the install or the run
  contacts the GitHub API. **Do not re-add the action** — it brings back both the
  rate-limited call and the second version number. The workflow says so at each
  call site.

  Local and CI now provably run the same binary: bump the devDependency and both
  sides move together, or neither does.

  **Do not read this as the port-54322 flake below** — that one fails inside
  `supabase start`, this one failed before it. Tell them apart by whether the log
  mentions a port or the API.
- **NOTE — CI: `e2e` can fail to start Supabase with "port 54322 address already in
  use".** Seen once on 2026-08-24 (`b490c2e`) minutes after identical content
  passed on the branch. **It is infrastructure, not code — `gh run rerun <id>
  --failed` clears it.** `rls` and `e2e` both run `supabase start` with no
  `needs:` between them; on GitHub-hosted runners each job gets its own VM, so
  this looks like transient Docker networking rather than a real collision. If
  it becomes frequent, the cheap fix is a retry around `supabase start`. Written
  down so a recurrence costs minutes rather than an afternoon.
- ~~**Reservation deposits against `payment_plans`.**~~ ✅ **DONE 2026-08-24**
  (`264786a`, migration 0050). **This line said `payment_plans` had "nothing
  reading them", which was wrong** — the units page lists them. The gap was
  downstream: nothing linked a reservation to a plan or applied one to a price.
  A hold now carries a FROZEN schedule (amounts fixed at apply time, so a later
  reprice cannot move what a buyer was quoted), with per-line paid state.

  **A plan's `due` is FREE TEXT, not a date** — so a plan can never drive a
  clock, and `reservation_installments.due_date` is agreed per reservation.
  That is the input instalment reminders need.
- ~~**Instalment reminders.**~~ ✅ **DONE 2026-08-24** (migration 0051).
  `remind-due-installments` at 03:55, behind the two reservation sweeps so a
  hold that lapsed overnight is already `expired` and its reminders supersede
  in the same pass. It was indeed the first kind added by a one-line INSERT
  into `task_kinds`, which is what 0049 was for.

  **IT DIVERGES FROM 0047 ON PURPOSE, and this is the part worth remembering.**
  0047 warns on `LIVE_RESERVATION_STATUSES` (held + confirmed). This sweep also
  chases `converted` — the TERMINAL state meaning the sale went ahead, which is
  where a Cyprus buyer on a 10/30/60 plan sits for almost the entire life of
  their schedule. Reusing the "live" definition would have stopped chasing every
  instalment at the exact moment the money began to matter: a sweep that runs
  nightly, reports nothing, and is broken. RLS test 35 pins it with a comment
  saying so, because "tidying" this to match 0047 is the obvious wrong edit.

  Overdue lines are in scope with **no floor on age**. 0047 can look only
  forward because the 03:45 expiry sweep handles everything behind it; nothing
  plays that role here, so an unpaid line just sits. Ignoring old ones would
  mean the sweep goes quietest about the money most at risk.

  **A note for the next migration that writes a `superseded` event:**
  `reservation_no_longer_live` is now emitted by TWO sweeps, so the renderer in
  `lib/services/events.ts` disambiguates on `kind`. A third reuse of a reason
  string needs the same treatment, or the wrong sentence renders.
- ~~**Reservation expiry warning.**~~ ✅ **DONE 2026-08-24** (`604738b`,
  migration 0047). Warns 2 days out, self-heals on extend/release, and runs at
  03:50 so it supersedes the stale warning of anything the 03:45 expiry closed.
  EXECUTE was locked down in the migration rather than after an advisor run —
  the first application of T-C4's lesson at write time.
