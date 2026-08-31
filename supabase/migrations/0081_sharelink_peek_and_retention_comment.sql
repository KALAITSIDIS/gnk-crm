-- 0081 — the two DB-touching halves of the ungated-closures batch
-- (2026-09-01 artifact verification; operator-delegated decisions).
--
-- ============================================================================
-- HALF 1 — SEC-04: a READ-ONLY budget peek for the share-link page.
-- ============================================================================
--
-- The share-link page resolves FIRST and rate-checks second, discarding the
-- over-budget answer into a log line — an over-budget prober still gets a
-- full SECURITY DEFINER resolve per request. The feed route rate-checks
-- first, but its counter is a REQUEST counter by design; the share-link
-- counter counts MISSES ONLY ("a legitimate open never touches this table",
-- 0023). note_share_link_miss is increment-and-report with no read-only
-- peek, so a naive reorder would silently redefine misses to requests and
-- make buyer lockout possible where it was impossible (office NAT, link
-- previews and refreshes all share one ip-hash bucket).
--
-- This function is the missing peek: it REPORTS whether the current window
-- is already over budget WITHOUT inserting. The page calls it before
-- resolve_share_link and refuses (the same neutral page) when true; the
-- existing miss-branch increments stay byte-for-byte, so both 0023
-- invariants hold. Same window arithmetic as note_share_link_miss — the two
-- must agree on what "the current window" is.
--
-- Grants mirror note_share_link_miss (anon-callable — the page runs on the
-- public client). The restore pack's grants_expected gains the row in the
-- same change, and verify-restore.test.ts enforces that in CI.
--
-- ============================================================================
-- HALF 2 — CY-03: the 0017 column comment stated the WRONG anchor.
-- ============================================================================
--
-- contacts.retention_until's comment said "(erasure date + 5y AML duty)" —
-- which is what the code wrongly did until today. The code half of CY-03
-- (same batch) anchors retention to the END OF THE RELATIONSHIP, clamped to
-- the erasure date for ongoing relationships; the comment now states the
-- actual rule so the next reader isn't taught the defect back.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

create or replace function public.share_link_over_budget(
  p_ip_hash text,
  p_limit int default 20
)
returns boolean
language sql
stable security definer
set search_path = public
as $fn$
  select coalesce(
    (
      select attempts
        from share_link_attempts
       where ip_hash = p_ip_hash
         and window_start = date_trunc('hour', now())
                          + (floor(extract(minute from now()) / 15) * interval '15 minutes')
    ),
    0
  ) > p_limit;
$fn$;

revoke execute on function public.share_link_over_budget(text, int) from public;
grant execute on function public.share_link_over_budget(text, int)
  to anon, authenticated, service_role;

comment on function public.share_link_over_budget(text, int) is
  'READ-ONLY peek at the share-link miss budget for the current 15-minute '
  'window — never inserts (0023''s counter means MISSES; only '
  'note_share_link_miss may increment it). Lets the share-link page refuse '
  'an over-budget prober BEFORE the resolve round trip (SEC-04).';

comment on column public.contacts.retention_until is
  'Date the retained KYC documents may be purged: 5 years after the END of '
  'the business relationship (last deal close, slip signature or mandate '
  'expiry — clamped to the erasure date when the relationship was still '
  'ongoing). Null when no documents were retained. Anchor corrected by 0081 '
  '(CY-03); it previously read "erasure date + 5y", which is what the code '
  'wrongly did.';

do $$
declare
  n int;
  over boolean;
  acl text;
begin
  -- the peek must exist, be callable, and answer false for a hash nobody used
  select public.share_link_over_budget('0081-selftest-hash', 3) into over;
  if over then
    raise exception '0081 aborted: peek answered over-budget for an untouched hash';
  end if;

  -- and it must be READ-ONLY: the self-test call above must not have
  -- inserted a row — that property is the entire point of the function
  select count(*) into n from share_link_attempts where ip_hash = '0081-selftest-hash';
  if n <> 0 then
    raise exception '0081 aborted: the peek INSERTED (% row(s)) — it must never write', n;
  end if;

  -- grants: anon and authenticated may execute (the page runs anon)
  if not has_function_privilege('anon', 'public.share_link_over_budget(text, int)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.share_link_over_budget(text, int)', 'EXECUTE') then
    raise exception '0081 aborted: app roles cannot execute the peek';
  end if;

  -- the retention comment must state the corrected anchor
  select col_description('public.contacts'::regclass,
                         (select attnum from pg_attribute
                           where attrelid = 'public.contacts'::regclass
                             and attname = 'retention_until')) into acl;
  if acl is null or position('END of' in acl) = 0 then
    raise exception '0081 aborted: retention_until comment does not state the corrected anchor: %', acl;
  end if;

  raise notice '0081: share_link_over_budget live (read-only proven, anon-callable); retention_until comment states the relationship-end anchor';
end $$;
