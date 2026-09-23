# 09 — DATA IMPORT TEMPLATES

Export current data (Excel, phone contacts, WhatsApp notes) into these two CSVs. Import scripts (`scripts/import/*`, task T5.6) run with service role, support `--dry-run`, write an import report, respect dedup, and log `imported` events. UTF-8 (in Excel: *CSV UTF-8*), comma- **or semicolon**-separated — Excel under Greek regional settings saves semicolons, and both are read — header row required. Empty cells = null. Numbers may be written the Greek or the English way (Rule 9).

## contacts_import.csv

| Column | Required | Format / values | Notes |
|---|---|---|---|
| first_name | ◐ | text | At least one of first/last/company |
| last_name | ◐ | text | |
| company_name | ◐ | text | |
| phone | no | any format | Normalized to E.164 (CY default); duplicates matched here |
| email | no | email | Secondary dedup key |
| telegram_username | no | without @ | |
| has_whatsapp | no | true/false | |
| languages | no | `en;el;ru` semicolon list | default en |
| nationality | no | ISO name or code | |
| contact_types | no | `buyer;owner;developer;...` | see enum list in doc 03 |
| temperature | no | hot/warm/cold/inactive/vip | default warm |
| source | no | website/referral/facebook/instagram/portal/partner/walk_in/whatsapp/telegram/phone/email/other | |
| psychology | no | investor/relocation/luxury/retirement/holiday/local_family/other | |
| budget_min / budget_max | no | number EUR | → a `buyer_requirements` saved search (0055) |
| pref_areas | no | `Kato Paphos;Peyia` | matched to areas by EN name |
| pref_bedrooms_min | no | int | |
| pref_property_types | no | `apartment;villa` | |
| consent_marketing | no | true/false | if true, consent_at = import time; note in gdpr_notes |
| consent_at | no | ISO date-time | the REAL grant time; without it the stamp is import time and the consent event says so (SEC-06) |
| notes | no | text | |

## properties_import.csv

| Column | Required | Format / values | Notes |
|---|---|---|---|
| reference | no | existing ref if any | If empty, generated as XXX#### |
| kind | no | standalone/project/unit | default standalone; units require parent_reference |
| parent_reference | ◐ | ref of project | required when kind=unit |
| property_type | yes | apartment/villa/townhouse/house/land/shop/office/building/hotel/warehouse/mixed_use/other | |
| transaction_type | no | sale/rent/sale_or_rent | default sale |
| status | no | draft/available/reserved/under_offer/sold/rented/withdrawn | default available |
| visibility | no | public/private/vip/partner/off_market/coming_soon | default private. `public` is honoured only when the row scores ≥ 70 once it and its mandate have landed (it is inserted private, scored, then published with `published_at` stamped as the app does); a project or phase imports as coming_soon at most |
| district_code | yes | PAF/LIM/LAR/NIC/FAM | |
| area | no | EN area name | created if missing |
| address | no | text | |
| latitude / longitude | no | decimal | |
| title_en / title_el / title_ru | no | text | |
| description_en / description_el / description_ru | no | text | |
| asking_price | no | number | |
| owner_net_price | no | number | internal |
| rent_price_month | no | number | |
| vat_status | no | new_vat/resale_no_vat/reduced_rate_eligible/unknown | |
| covered_area_sqm / plot_area_sqm / veranda_sqm | no | number | covered and plot, when given, are greater than 0 (at least 0.01) — leave the cell blank when unknown or not applicable (a flat's plot, land's covered area), never 0. A veranda may be 0 |
| bedrooms / bathrooms / parking_spaces | no | int | |
| floor_number / total_floors / year_built | no | int | floor 0 = ground floor, negative = basement; when both are given, floor_number ≤ total_floors |
| features | no | `pool;garden;sea_view;furnished` | keys from features constant |
| title_deed_status | no | separate/pending/shared/none/unknown | |
| permit_status | no | full/pending/partial/none/unknown | |
| registration_no | no | text | DLS registration number; drives the duplicate warning |
| plot_no / sheet_plan / registry_municipality | no | text | DLS identity, as the deed prints them |
| planning_zone_code | no | text | land |
| building_density_pct / coverage_ratio_pct | no | number | land |
| max_floors / road_frontage_m | no | number | land |
| owner_phone | no | any format | Linked/created as owner contact via dedup |
| owner_name | no | text | used if owner contact created |
| mandate_type | no | exclusive/open/verbal | creates active mandate |
| mandate_commission_pct | no | number | |
| mandate_expiry | no | YYYY-MM-DD | |
| internal_notes | no | text | |
| photo_folder | no | folder name | Photos in `import-media/<folder>/` — imported by `node --env-file=.env.local scripts/import/media.mts --file properties.csv` AFTER the row import (dry-run first; idempotent, `--append` to extend a gallery) |

## Rules

1. Import contacts **before** properties (owner linking).
2. Dry-run first; fix the report; then live run.
3. Anything unmappable → keep in a spare `notes` column rather than losing it.
4. Cyrillic/Greek data is fine in any text field; **names of record for legal docs should follow passport Latin transliteration** in notes where relevant.
5. **Headers are checked against these tables.** An unknown column stops the run before any row is written — a misspelt header would otherwise import every value in it as blank; `--allow-extra` ignores such columns instead (audit 2026-09-15, LST-10).
6. **Every run has a batch id** (`--batch <id>`, default `YYYYMMDD-HHMMSS-<file>`), written into each `imported` event's payload and into the report's file name, so a whole run can be found by one name.
7. **The importer cannot skip the publish gate** (audit 2026-09-15, LST-02). A row requested `public` is scored once it and its mandate exist and is published only at 70 or more, with `published_at` stamped; otherwise it stays private and the report row says the score.
8. **Areas and floors obey the app's rules** (audit 2026-09-23, LST-07). A row with a covered or plot area of 0 or less, or a floor above its total floors, is refused in the report naming the column — in the dry run too — before it creates an area or an owner contact. Migration 0113 refuses the same values at the table.
9. **Numbers are read the way Cyprus writes them** (2026-09-23). `85,5` and `85.5` are both eighty-five and a half; `1.200`, `1,200` and `1 200` are all twelve hundred; `1.200,50` and `1,200.50` are both twelve hundred and a half — a single `.` or `,` followed by exactly three digits groups thousands in prices, areas and lengths, since nobody writes those to three decimals. In `latitude`, `longitude` and the `_pct` columns a single separator is always the decimal mark (`34.775` is a latitude, not 34775). A cell that is not a plain number — `€250.000`, `185 m²`, `1,20,000` — is refused naming its column rather than guessed or left blank, and a whole-number column (bedrooms, floors, year) refuses a fraction instead of truncating it (`2,5` bedrooms used to import as 25). In a comma-separated file a number that contains a comma must be quoted — Rule 10.
10. **The file's structure is checked whole before anything is written** (2026-09-23) — in the dry run and the live run alike; `--allow-extra` does not relax it. The run stops with the file name, the line (as a text editor numbers it — a line break inside a quoted value counts), the column where it applies, and the reason, and never prints a cell's value. Refused:
    - a header name that is blank — a separator at the end of the header line makes one — that appears twice (names compared after trimming spaces), or that holds a line break, a double quote or the separator (a quote left open on the header line swallows the rows after it);
    - a row with more or fewer cells than the header; the message gives both counts. An empty value still needs its separator (`,,`), and an optional column may be left out of the header entirely instead;
    - a double quote that is never closed, a double quote inside an unquoted value, or text after a closing quote.

    One bad row refuses the whole file, the rows before it included: fix it and run again. An empty line, or one holding only spaces, is skipped; lines may end LF, CRLF or CR.

    **Quote any value that contains the file's separator.** In a comma-separated file `AUDIT,apartment,PAF,1,250,000,85.5` has seven cells under a five-column header and is refused — it used to import as a price of 1 and an area of 250. Write the price `"1,250,000"`, or without the commas (`1250000`, `1.250.000`, `1 250 000`):

    ```csv
    reference,property_type,district_code,asking_price,covered_area_sqm
    AUDIT,apartment,PAF,"1,250,000",85.5
    ```

    In a semicolon-separated file the same holds for a `;` inside a value (`"pool;garden"`), while a comma needs no quotes (`85,5`):

    ```csv
    reference;property_type;district_code;asking_price;covered_area_sqm
    AUDIT;apartment;PAF;1.250.000;85,5
    ```

    A double quote inside a quoted value is written twice: `"Villa ""Sunrise"""`. Excel does all of this itself when it saves; the rule bites on files written by hand or by other tools.
