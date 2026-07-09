-- =============================================================================
-- 07_SEED_DATA.sql — reference data. Copy into supabase/migrations/0003_seed.sql
-- (or supabase/seed.sql). Idempotent where practical.
-- ⚠ VERIFY all Cyprus rates against current legislation before go-live and set
--   verified_at accordingly. Rates are config, never code.
-- =============================================================================

-- ---------- organization ----------
insert into organizations (id, name, slug)
values ('00000000-0000-0000-0000-000000000001','GN Kalaitsidis Capital','gnk')
on conflict (slug) do nothing;

-- After creating the first auth user (admin) in Supabase dashboard, attach:
-- insert into profiles (id, org_id, role, full_name, email)
-- values ('<AUTH_USER_UUID>','00000000-0000-0000-0000-000000000001','admin','Gerasimos Kalaitsidis','<email>');

-- ---------- districts ----------
insert into districts (org_id, code, name, sort_order) values
('00000000-0000-0000-0000-000000000001','PAF','{"en":"Paphos","el":"Πάφος","ru":"Пафос"}',1),
('00000000-0000-0000-0000-000000000001','LIM','{"en":"Limassol","el":"Λεμεσός","ru":"Лимассол"}',2),
('00000000-0000-0000-0000-000000000001','LAR','{"en":"Larnaca","el":"Λάρνακα","ru":"Ларнака"}',3),
('00000000-0000-0000-0000-000000000001','NIC','{"en":"Nicosia","el":"Λευκωσία","ru":"Никосия"}',4),
('00000000-0000-0000-0000-000000000001','FAM','{"en":"Famagusta","el":"Αμμόχωστος","ru":"Фамагуста"}',5)
on conflict (org_id, code) do nothing;

-- Starter areas (extend in Settings)
insert into areas (org_id, district_id, name)
select '00000000-0000-0000-0000-000000000001', d.id, a.name
from districts d
join (values
  ('PAF','{"en":"Kato Paphos","el":"Κάτω Πάφος","ru":"Като Пафос"}'::jsonb),
  ('PAF','{"en":"Universal","el":"Γιουνιβέρσαλ","ru":"Юниверсал"}'),
  ('PAF','{"en":"Chloraka","el":"Χλώρακα","ru":"Хлорака"}'),
  ('PAF','{"en":"Peyia / Coral Bay","el":"Πέγεια / Κόραλ Μπέι","ru":"Пейя / Корал Бэй"}'),
  ('PAF','{"en":"Geroskipou","el":"Γεροσκήπου","ru":"Героскипу"}'),
  ('PAF','{"en":"Tala / Tsada","el":"Τάλα / Τσάδα","ru":"Тала / Цада"}'),
  ('LIM','{"en":"Germasogeia","el":"Γερμασόγεια","ru":"Гермасойя"}'),
  ('LIM','{"en":"Agios Athanasios","el":"Άγιος Αθανάσιος","ru":"Айос Афанасиос"}'),
  ('LIM','{"en":"Agios Tychonas","el":"Άγιος Τύχωνας","ru":"Айос Тихонас"}'),
  ('LIM','{"en":"City Centre / Molos","el":"Κέντρο / Μόλος","ru":"Центр / Молос"}')
) as a(code, name) on a.code = d.code
on conflict do nothing;

-- ---------- deal stages ----------
insert into deal_stages (org_id, deal_type, name, sort_order, is_won, is_lost)
values
-- sale
('00000000-0000-0000-0000-000000000001','sale','New',1,false,false),
('00000000-0000-0000-0000-000000000001','sale','Qualified',2,false,false),
('00000000-0000-0000-0000-000000000001','sale','Viewing',3,false,false),
('00000000-0000-0000-0000-000000000001','sale','Offer',4,false,false),
('00000000-0000-0000-0000-000000000001','sale','Reservation',5,false,false),
('00000000-0000-0000-0000-000000000001','sale','Legal & Bank',6,false,false),
('00000000-0000-0000-0000-000000000001','sale','Completed',7,true,false),
('00000000-0000-0000-0000-000000000001','sale','Lost',8,false,true),
-- rental
('00000000-0000-0000-0000-000000000001','rental','New',1,false,false),
('00000000-0000-0000-0000-000000000001','rental','Qualified',2,false,false),
('00000000-0000-0000-0000-000000000001','rental','Viewing',3,false,false),
('00000000-0000-0000-0000-000000000001','rental','Application',4,false,false),
('00000000-0000-0000-0000-000000000001','rental','Contract Signed',5,true,false),
('00000000-0000-0000-0000-000000000001','rental','Lost',6,false,true),
-- antiparoxi (land-for-units exchange)
('00000000-0000-0000-0000-000000000001','antiparoxi','Landowner Contact',1,false,false),
('00000000-0000-0000-0000-000000000001','antiparoxi','Site & Zoning Review',2,false,false),
('00000000-0000-0000-0000-000000000001','antiparoxi','Developer Matching',3,false,false),
('00000000-0000-0000-0000-000000000001','antiparoxi','Exchange Terms',4,false,false),
('00000000-0000-0000-0000-000000000001','antiparoxi','Legal Structuring',5,false,false),
('00000000-0000-0000-0000-000000000001','antiparoxi','Agreement Signed',6,true,false),
('00000000-0000-0000-0000-000000000001','antiparoxi','Lost',7,false,true),
-- advisory
('00000000-0000-0000-0000-000000000001','advisory','Enquiry',1,false,false),
('00000000-0000-0000-0000-000000000001','advisory','Scoping',2,false,false),
('00000000-0000-0000-0000-000000000001','advisory','Proposal Sent',3,false,false),
('00000000-0000-0000-0000-000000000001','advisory','Engaged',4,true,false),
('00000000-0000-0000-0000-000000000001','advisory','Lost',5,false,true)
on conflict do nothing;

-- ---------- Cyprus config ----------
-- ⚠ Verify every value at implementation; then update verified_at.
insert into cyprus_config (key, value, description, verified_at, source_note) values

('transfer_fees', '{
  "bands": [
    {"up_to": 85000,  "rate": 0.03},
    {"up_to": 170000, "rate": 0.05},
    {"up_to": null,   "rate": 0.08}
  ],
  "relief_pct": 0.50,
  "relief_note": "50% reduction applies to transfers not subject to VAT",
  "vat_paid_exempt": true,
  "vat_paid_note": "No transfer fees when the transaction was subject to VAT"
}', 'Department of Lands & Surveys transfer fee bands (progressive, per purchaser share)', null,
'DLS scale. Verify current relief regime before go-live.'),

('stamp_duty', '{
  "bands": [
    {"up_to": 5000,   "rate": 0},
    {"up_to": 170000, "rate": 0.0015},
    {"up_to": null,   "rate": 0.002}
  ],
  "cap": 20000
}', 'Stamp duty on purchase contracts, capped at €20,000', null,
'Verify bands and cap against current Stamp Duty Law.'),

('vat_property', '{
  "standard_rate": 0.19,
  "reduced_rate": 0.05,
  "reduced_rules_post_2023": {
    "applies_to": "first primary residence, new property",
    "reduced_area_cap_sqm": 130,
    "reduced_value_cap_eur": 350000,
    "max_total_value_eur": 475000,
    "max_total_area_sqm": 190,
    "disability_area_cap_sqm": 190
  },
  "note": "Reduced 5% applies to the first 130 sqm / €350,000 subject to overall caps; excess at 19%. Transitional rules existed for pre-Nov-2023 permits."
}', 'VAT on property: standard vs reduced-rate primary residence rules (post-June-2023 amendment)', null,
'Verify against current VAT Law amendment before enabling the Phase 3 wizard.'),

('capital_gains_tax', '{
  "rate": 0.20,
  "lifetime_exemptions_eur": {
    "general": 17086,
    "agricultural_land_farmer": 25629,
    "primary_residence": 85430
  },
  "primary_residence_conditions": "ownership and use as main residence for required period; area limits apply"
}', 'CGT on disposal of Cyprus immovable property (seller-side estimate only)', null,
'Verify exemption figures and conditions.'),

('other_property_taxes', '{
  "immovable_property_tax": "abolished since 2017",
  "local_authority_fees": "municipal/community charges and sewerage apply annually — varies by municipality",
  "note_2026_reform": "Corporate tax 15% and SDC on dividends 5% under the 2026 reform affect corporate holding analyses (Phase 3 calculator context), not purchase costs."
}', 'Contextual notes for calculators and proposals', null, null),

('company_details', '{
  "legal_name": "GN Kalaitsidis Capital Ltd",
  "brand": "Kalaitsidis Capital",
  "website": "kalaitsidis.com",
  "base": "Paphos, Cyprus",
  "default_locale": "en",
  "timezone": "Asia/Nicosia"
}', 'Used on PDFs, slips, and evidence reports', null, null)

on conflict (key) do nothing;
