-- 0008: Ensure the `media` bucket is public. Renditions (thumb/card/full) are
-- served to the browser via getPublicUrl → /storage/v1/object/public/media/…,
-- which only works when storage.buckets.public = true for this bucket.
--
-- 0001 inserts the bucket as public, but with `on conflict (id) do nothing`:
-- if a `media` bucket already existed (e.g. auto-created, or created private via
-- the dashboard before migrations ran), that insert is skipped and the bucket
-- stays private — every property photo then renders as a broken image. This
-- statement is idempotent and repairs that state without touching object data.
update storage.buckets set public = true where id = 'media';
