/**
 * 0126's lines and the way back to 0125's catalogue, shared by the test files
 * that need them: task-contact-property-org-isolation.test.ts (0126's own
 * replays), viewing-parent-org-isolation.test.ts (0123's),
 * reservation-lead-property-org-isolation.test.ts (0124's) and
 * task-reservation-lead-org-isolation.test.ts (0125's). Each must take 0126
 * off before it can take its own migration off: 0126's two contact keys
 * depend on 0123's contacts_org_id_id_key, 0126's two predicates sit in the
 * create_followup_nudges body 0123 compares with 0078's, and 0126's contact
 * join sits in the reservation-sweep bodies 0124 and 0125 compare with their
 * predecessors'.
 *
 * Not a test file: it registers no tests. Never pointed at hosted.
 */

export const SIG_0126 = {
  cfn: "public.create_followup_nudges(uuid)",
  warn: "public.warn_expiring_reservations(uuid)",
  remind: "public.remind_due_installments(uuid)",
} as const;

/** The three bodies as 0123 (cfn) and 0125 (warn, remind) left them — CR-stripped md5 of prosrc. */
export const MD5_0125 = {
  cfn: "874347807d5340b5b3a2cd588e3b7499",
  warn: "6f9febc3430ec5bba9cb4a81f1eb46fb",
  remind: "b84ea00e6b0a54a207e74f1edc817007",
} as const;

/** The lines 0126 adds (newline + indentation + predicate), and the one select-list item it rewrites in place. */
export const K0126 = {
  /** create_followup_nudges arm 2c's duplicate guard (the same text as 0125's reservation-sweep guard line — strip per function) */
  retentionGuard: "\n          and t.org_id = d.org_id",
  /** create_followup_nudges arm 4c's self-heal */
  retentionHeal: "\n       and t.org_id = c.org_id",
  /** warn's and remind's contact join (each once) */
  contactJoin: "\n      left join contacts ct on ct.id = r.contact_id\n       and ct.org_id = r.org_id",
  contactSelectOld: "r.property_id, r.contact_id, r.created_by,",
  contactSelectNew: "r.property_id, ct.id as contact_id, r.created_by,",
} as const;

/**
 * A body with 0126's lines taken out (and the select-list item put back):
 * must be the 0123 / 0125 one. Only THAT function's lines come out — 0126's
 * retention-guard line is character for character 0125's reservation-sweep
 * guard line, so stripping it from warn / remind would remove 0125's.
 */
export function strip0126(body: string, fn: keyof typeof SIG_0126) {
  if (fn === "cfn") return body.split(K0126.retentionGuard).join("").split(K0126.retentionHeal).join("");
  return stripContactJoin0126(body);
}

/**
 * The reservation sweeps' 0126 change taken out (the join removed, the
 * select-list item put back). A no-op on any body that does not carry it, so
 * 0124's and 0125's files can run it over every body they compare.
 */
export function stripContactJoin0126(body: string) {
  return body.split(K0126.contactJoin).join("").split(K0126.contactSelectNew).join(K0126.contactSelectOld);
}

/**
 * 0125's catalogue for 0126's objects, inside the caller's transaction: the
 * three single-column keys back with their rules, the three indexes gone, the
 * three bodies and comments as 0123 / 0125 left them. A no-op on a database
 * still at 0125 (nothing of 0126's is there), so the earlier files can run it
 * unconditionally.
 */
export const REVERT_0126_SQL = `
  do $rev$
  declare b text;
  begin
    if not exists (select 1 from pg_constraint
                    where conname in ('reservations_org_contact_fkey', 'tasks_org_contact_fkey', 'tasks_org_property_fkey')) then
      return;
    end if;
    alter table public.reservations drop constraint if exists reservations_org_contact_fkey;
    alter table public.tasks drop constraint if exists tasks_org_contact_fkey;
    alter table public.tasks drop constraint if exists tasks_org_property_fkey;
    drop index if exists public.reservations_org_contact_idx;
    drop index if exists public.tasks_org_contact_idx;
    drop index if exists public.tasks_org_property_idx;
    alter table public.reservations add constraint reservations_contact_id_fkey
      foreign key (contact_id) references public.contacts(id) on delete set null;
    alter table public.tasks add constraint tasks_contact_id_fkey
      foreign key (contact_id) references public.contacts(id);
    alter table public.tasks add constraint tasks_property_id_fkey
      foreign key (property_id) references public.properties(id);

    select prosrc into b from pg_proc where oid = 'public.create_followup_nudges(uuid)'::regprocedure;
    execute format('create or replace function public.create_followup_nudges(p_org uuid default null) returns void '
                   'language sql security definer set search_path = public as %L',
                   replace(replace(b, E'\\n          and t.org_id = d.org_id', ''), E'\\n       and t.org_id = c.org_id', ''));
    select prosrc into b from pg_proc where oid = 'public.warn_expiring_reservations(uuid)'::regprocedure;
    execute format('create or replace function public.warn_expiring_reservations(p_org uuid default null) returns void '
                   'language sql security definer set search_path = public as %L',
                   replace(replace(b, E'\\n      left join contacts ct on ct.id = r.contact_id\\n       and ct.org_id = r.org_id', ''),
                           'r.property_id, ct.id as contact_id, r.created_by,', 'r.property_id, r.contact_id, r.created_by,'));
    select prosrc into b from pg_proc where oid = 'public.remind_due_installments(uuid)'::regprocedure;
    execute format('create or replace function public.remind_due_installments(p_org uuid default null) returns void '
                   'language sql security definer set search_path = public as %L',
                   replace(replace(b, E'\\n      left join contacts ct on ct.id = r.contact_id\\n       and ct.org_id = r.org_id', ''),
                           'r.property_id, ct.id as contact_id, r.created_by,', 'r.property_id, r.contact_id, r.created_by,'));
    -- CREATE OR REPLACE keeps comments: back to 0123's / 0125's text
    execute format('comment on function public.create_followup_nudges(uuid) is %L',
                   split_part(obj_description('public.create_followup_nudges(uuid)'::regprocedure, 'pg_proc'), ' Since 0126', 1));
    execute format('comment on function public.warn_expiring_reservations(uuid) is %L',
                   split_part(obj_description('public.warn_expiring_reservations(uuid)'::regprocedure, 'pg_proc'), ' Since 0126', 1));
    execute format('comment on function public.remind_due_installments(uuid) is %L',
                   split_part(obj_description('public.remind_due_installments(uuid)'::regprocedure, 'pg_proc'), ' Since 0126', 1));
  end $rev$;
`;
