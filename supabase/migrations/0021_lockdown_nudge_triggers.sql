-- 0021: close advisors 0028/0029 re-opened by 0020.
--
-- 0007 §1 revoked EXECUTE on every trigger function for the stated reason that
-- they are "fired by the engine, not called; EXECUTE not needed". 0020 added two
-- more — trg_supersede_deal_nudges and trg_supersede_viewing_nudges — which were
-- created AFTER 0007 ran and so inherited Supabase's default grant of EXECUTE on
-- public-schema functions to anon + authenticated. Both were therefore exposed
-- at /rest/v1/rpc/*, and the security advisor flagged them the moment 0020
-- landed on hosted.
--
-- Not exploitable: Postgres refuses to call a function whose return type is
-- `trigger` outside trigger context ("trigger functions can only be called as
-- triggers"), so the RPC would error rather than supersede anyone's tasks. But
-- the grant is still wrong, it contradicts a lockdown this repo made
-- deliberately, and leaving a known advisor warning standing teaches the next
-- reader that advisor warnings are noise.
--
-- create_followup_nudges(uuid) already revokes + re-grants to service_role in
-- 0020 and is NOT re-stated here.

revoke execute on function public.trg_supersede_deal_nudges()    from public, anon, authenticated;
revoke execute on function public.trg_supersede_viewing_nudges() from public, anon, authenticated;
