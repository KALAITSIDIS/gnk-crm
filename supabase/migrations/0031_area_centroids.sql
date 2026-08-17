-- 0031 — district and area centroids, so every property can be mapped.
--
-- IMPROVEMENTS B5 claimed properties.location was "already populated". It is
-- not: checked 2026-08-11, 0 of 2 rows have coordinates. The write path works
-- (map-location-fields.tsx -> lib/actions/properties.ts) and was simply never
-- used, so a map keyed on location alone would render zero pins indefinitely.
--
-- Centroids give every listing a position on day one. A property resolves to its
-- exact location if it has one, else its area centroid, else its district
-- centroid. Approximate pins render differently from exact ones so nobody reads
-- a centroid as a surveyed point.
--
-- Stored rather than computed: these are fixed Cyprus geography, and storing them
-- lets an admin correct one without a deploy.
--
-- COORDINATES ARE APPROXIMATE BY DESIGN. A few hundred metres out is fine; a pin
-- in the wrong village is not. The acceptance check is an operator looking at the
-- rendered map once.
--
-- FAM IS DELIBERATELY NOT FAMAGUSTA TOWN. Most of that district is in the north,
-- so a naive centroid lands in occupied territory. Operator decision 2026-08-11:
-- centre it on the FREE AREA — Paralimni / Protaras / Ayia Napa. Do not "correct"
-- this to the town.
--
-- EWKT IS `POINT(lng lat)` — LONGITUDE FIRST. Reversed, every property lands off
-- the Somali coast and still looks like valid data.

alter table districts add column if not exists centroid geography(point,4326);
alter table areas     add column if not exists centroid geography(point,4326);

comment on column districts.centroid is
  'Approximate centre of the district, used to place a property that has no exact '
  'location and no area centroid. FAM is the FREE AREA (Paralimni), not Famagusta '
  'town — see migration 0031.';
comment on column areas.centroid is
  'Approximate centre of the area, used to place a property that has no exact '
  'location. Preferred over the district centroid.';

update districts set centroid = case code
  when 'PAF' then 'SRID=4326;POINT(32.4245 34.7754)'::geography
  when 'LIM' then 'SRID=4326;POINT(33.0226 34.7071)'::geography
  when 'LAR' then 'SRID=4326;POINT(33.6201 34.9182)'::geography
  when 'NIC' then 'SRID=4326;POINT(33.3823 35.1856)'::geography
  when 'FAM' then 'SRID=4326;POINT(33.9832 35.0378)'::geography  -- Paralimni, free area
  else centroid
end
where code in ('PAF','LIM','LAR','NIC','FAM');

update areas a set centroid = v.pt::geography
from (values
  ('Kato Paphos',        'SRID=4326;POINT(32.4090 34.7550)'),
  ('Universal',          'SRID=4326;POINT(32.4160 34.7690)'),
  ('Chloraka',           'SRID=4326;POINT(32.4100 34.7900)'),
  ('Geroskipou',         'SRID=4326;POINT(32.4600 34.7600)'),
  ('Peyia / Coral Bay',  'SRID=4326;POINT(32.3670 34.8830)'),
  ('Tala / Tsada',       'SRID=4326;POINT(32.4300 34.8300)'),
  ('City Centre / Molos','SRID=4326;POINT(33.0430 34.6750)'),
  ('Germasogeia',        'SRID=4326;POINT(33.0850 34.7180)'),
  ('Agios Athanasios',   'SRID=4326;POINT(33.0480 34.7080)'),
  ('Agios Tychonas',     'SRID=4326;POINT(33.1230 34.7160)')
) as v(name_en, pt)
where a.name->>'en' = v.name_en;
