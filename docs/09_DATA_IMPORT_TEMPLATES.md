# 09 — DATA IMPORT TEMPLATES

Export current data (Excel, phone contacts, WhatsApp notes) into these two CSVs. Import scripts (`scripts/import/*`, task T5.6) run with service role, support `--dry-run`, write an import report, respect dedup, and log `imported` events. UTF-8, comma-separated, header row required. Empty cells = null.

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
| budget_min / budget_max | no | number EUR | → preferences |
| pref_areas | no | `Kato Paphos;Peyia` | matched to areas by EN name |
| pref_bedrooms_min | no | int | |
| pref_property_types | no | `apartment;villa` | |
| consent_marketing | no | true/false | if true, consent_at = import time; note in gdpr_notes |
| notes | no | text | |

## properties_import.csv

| Column | Required | Format / values | Notes |
|---|---|---|---|
| reference | no | existing ref if any | If empty, generated as GNK-XXX-#### |
| kind | no | standalone/project/unit | default standalone; units require parent_reference |
| parent_reference | ◐ | ref of project | required when kind=unit |
| property_type | yes | apartment/villa/townhouse/house/land/shop/office/building/hotel/warehouse/mixed_use/other | |
| transaction_type | no | sale/rent/sale_or_rent | default sale |
| status | no | draft/available/reserved/under_offer/sold/rented/withdrawn | default available |
| visibility | no | public/private/vip/partner/off_market/coming_soon | default private |
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
| covered_area_sqm / plot_area_sqm / veranda_sqm | no | number | |
| bedrooms / bathrooms / parking_spaces | no | int | |
| floor_number / total_floors / year_built | no | int | |
| features | no | `pool;garden;sea_view;furnished` | keys from features constant |
| title_deed_status | no | separate/pending/shared/none/unknown | |
| permit_status | no | full/pending/partial/none/unknown | |
| planning_zone_code | no | text | land |
| building_density_pct / coverage_ratio_pct | no | number | land |
| max_floors / road_frontage_m | no | number | land |
| owner_phone | no | any format | Linked/created as owner contact via dedup |
| owner_name | no | text | used if owner contact created |
| mandate_type | no | exclusive/open/verbal | creates active mandate |
| mandate_commission_pct | no | number | |
| mandate_expiry | no | YYYY-MM-DD | |
| internal_notes | no | text | |
| photo_folder | no | folder name | Optional: photos placed in `import-media/<folder>/` are pipeline-processed |

## Rules

1. Import contacts **before** properties (owner linking).
2. Dry-run first; fix the report; then live run.
3. Anything unmappable → keep in a spare `notes` column rather than losing it.
4. Cyrillic/Greek data is fine in any text field; **names of record for legal docs should follow passport Latin transliteration** in notes where relevant.
