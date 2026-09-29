/**
 * 0125's lines and the way back to 0124's catalogue, shared by the two test
 * files that need them: task-reservation-lead-org-isolation.test.ts (0125's
 * own replays) and reservation-lead-property-org-isolation.test.ts (0124's,
 * which must take 0125 off before it can take 0124 off — 0125's task keys
 * depend on 0124's reservations_org_id_id_key, and 0125's predicates sit in
 * the bodies 0124 compares with 0052's / 0098's).
 *
 * Not a test file: it registers no tests. Never pointed at hosted.
 */

/** The four bodies as 0124 (warn, remind, SLA) and 0090 (expire) left them — CR-stripped md5 of prosrc. */
export const MD5_0124 = {
  warn: "ad1f48646a22f8b1bd9ae0acdd8de11a",
  remind: "8be21b0e317d1c46ff3a0316e9dff40c",
  sla: "292c1cd4e14cdfe5fcb4d29ecf33d895",
  expire: "b7cdb54d68a76c5f2e1a3383391e85b4",
} as const;

export const SIG_0125 = {
  warn: "public.warn_expiring_reservations(uuid)",
  remind: "public.remind_due_installments(uuid)",
  sla: "public.raise_lead_sla_tasks(uuid, integer)",
  expire: "public.expire_reservations()",
} as const;

/** The lines 0125 adds (newline + indentation + predicate), and the one guard it rewrites in place. */
export const K0125 = {
  /** warn's and remind's duplicate guards (each once) */
  guard: "\n          and t.org_id = d.org_id",
  warnHeal: "\n       and t.org_id = r.org_id",
  remindHeal: "\n       and t.org_id = i.org_id",
  slaHeal: "\n       and t.org_id = l.org_id",
  expireHeal: "\n       and t.org_id = e.org_id",
  slaGuardOld: "where t.lead_id = l.id and t.kind = 'lead_unanswered')",
  slaGuardNew: "where t.lead_id = l.id and t.org_id = l.org_id and t.kind = 'lead_unanswered')",
} as const;

/** A body with 0125's lines taken out (and the SLA guard put back): must be the 0124 / 0090 one. */
export function strip0125(body: string) {
  return [K0125.guard, K0125.warnHeal, K0125.remindHeal, K0125.slaHeal, K0125.expireHeal]
    .reduce((b, k) => b.split(k).join(""), body)
    .split(K0125.slaGuardNew)
    .join(K0125.slaGuardOld);
}

/**
 * 0124's catalogue for 0125's objects, inside the caller's transaction. A
 * no-op on a database still at 0124 (nothing of 0125's is there), so 0124's
 * test file can run it unconditionally.
 */
export const REVERT_0125_SQL = `
  do $rev$
  declare b text;
  begin
    if not exists (select 1 from pg_constraint where conrelid = 'public.tasks'::regclass
                      and conname in ('tasks_org_reservation_fkey', 'tasks_org_installment_fkey', 'tasks_org_lead_fkey'))
       and not exists (select 1 from pg_constraint where conname = 'reservation_installments_org_id_id_key') then
      return;
    end if;
    alter table public.tasks drop constraint if exists tasks_org_reservation_fkey;
    alter table public.tasks drop constraint if exists tasks_org_installment_fkey;
    alter table public.tasks drop constraint if exists tasks_org_lead_fkey;
    drop index if exists public.tasks_org_reservation_idx;
    drop index if exists public.tasks_org_installment_idx;
    drop index if exists public.tasks_org_lead_idx;
    alter table public.tasks add constraint tasks_reservation_id_fkey
      foreign key (reservation_id) references public.reservations(id) on delete cascade;
    alter table public.tasks add constraint tasks_installment_id_fkey
      foreign key (installment_id) references public.reservation_installments(id) on delete cascade;
    alter table public.tasks add constraint tasks_lead_id_fkey
      foreign key (lead_id) references public.leads(id);
    alter table public.reservation_installments drop constraint if exists reservation_installments_org_id_id_key;

    select prosrc into b from pg_proc where oid = 'public.warn_expiring_reservations(uuid)'::regprocedure;
    execute format('create or replace function public.warn_expiring_reservations(p_org uuid default null) returns void '
                   'language sql security definer set search_path = public as %L',
                   replace(replace(b, E'\\n          and t.org_id = d.org_id', ''), E'\\n       and t.org_id = r.org_id', ''));
    select prosrc into b from pg_proc where oid = 'public.remind_due_installments(uuid)'::regprocedure;
    execute format('create or replace function public.remind_due_installments(p_org uuid default null) returns void '
                   'language sql security definer set search_path = public as %L',
                   replace(replace(b, E'\\n          and t.org_id = d.org_id', ''), E'\\n       and t.org_id = i.org_id', ''));
    select prosrc into b from pg_proc where oid = 'public.raise_lead_sla_tasks(uuid, integer)'::regprocedure;
    execute format('create or replace function public.raise_lead_sla_tasks(p_org uuid default null, p_minutes int default 60) returns int '
                   'language plpgsql security definer set search_path = public as %L',
                   replace(replace(b, E'\\n       and t.org_id = l.org_id', ''),
                           'where t.lead_id = l.id and t.org_id = l.org_id and t.kind', 'where t.lead_id = l.id and t.kind'));
    select prosrc into b from pg_proc where oid = 'public.expire_reservations()'::regprocedure;
    execute format('create or replace function public.expire_reservations() returns void '
                   'language sql security definer set search_path = public as %L',
                   replace(b, E'\\n       and t.org_id = e.org_id', ''));
    -- CREATE OR REPLACE keeps comments: back to 0124's / 0090's text
    execute format('comment on function public.warn_expiring_reservations(uuid) is %L',
                   split_part(obj_description('public.warn_expiring_reservations(uuid)'::regprocedure, 'pg_proc'), ' Since 0125', 1));
    execute format('comment on function public.remind_due_installments(uuid) is %L',
                   split_part(obj_description('public.remind_due_installments(uuid)'::regprocedure, 'pg_proc'), ' Since 0125', 1));
    execute format('comment on function public.raise_lead_sla_tasks(uuid, int) is %L',
                   split_part(obj_description('public.raise_lead_sla_tasks(uuid, integer)'::regprocedure, 'pg_proc'), ' Since 0125', 1));
    execute format('comment on function public.expire_reservations() is %L',
                   split_part(obj_description('public.expire_reservations()'::regprocedure, 'pg_proc'), ' Since 0125', 1));
  end $rev$;
`;
