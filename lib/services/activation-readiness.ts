import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readBrandingFiles, BRANDING_USE } from "@/lib/services/branding";
import { enquiryAckConfigured } from "@/lib/services/enquiry-ack";
import { enquiryAlertConfigured } from "@/lib/services/enquiry-alert";
import { escalationRecipients, readLeadEscalation, type LeadEscalationConfig } from "@/lib/services/lead-escalation";
import { readLeadRouting, type LeadRouting } from "@/lib/services/lead-routing";
import {
  DEFAULT_ALERT_FROM,
  isResendTestDomain,
  senderDomain,
  senderReadinessCopy,
  type SenderReadiness,
} from "@/lib/services/sender-readiness";
import type { Database } from "@/lib/supabase/database.types";

/**
 * What is switched on in THIS deployment, what waits on a step outside the
 * CRM, and what is not built — the Settings overview (A07, /settings).
 *
 * WHY. Each integration's readiness was computed only where it is configured
 * (Lead routing, Lead escalation, Portals, Organization) or only inside an
 * on-demand preview (the escalation's sender line), and every env-gated
 * sender skipped with a server `console.warn` no admin ever reads. The list
 * of operator steps lived in HANDOFF.md. This module gathers the answers the
 * existing readers already give into one read-only list.
 *
 * READ-ONLY, AND IT CHANGES NOTHING. No row enables anything; each links to
 * the page where the setting is changed (and where Lead escalation keeps its
 * preview-then-Save discipline). The routing and escalation values are the
 * operator's decisions: the rows state them and recommend none.
 *
 * WHAT IT MAY SAY ABOUT THE ENVIRONMENT. Booleans and counts, and one string:
 * the DOMAIN of the From, which is a public DNS name the provider prints in
 * every message it sends. Never a key, never a value, never the
 * ENQUIRY_ALERT_TO addresses (a count only). `readEnvFlags` is the only
 * function here that touches the environment, and what it returns is all a
 * row can ever see — activation-readiness.test.ts feeds it sentinel values
 * and searches every row, and the rendered page, for them.
 *
 * A FAILED READ IS "COULD NOT CHECK", NEVER "OFF". `off` is the reassuring
 * answer for an integration and the wrong one when the read failed; every
 * database read below is checked, and a failure becomes state `unknown`.
 *
 * ONE DEFINITION OF EACH RULE. The routing and escalation rows read the rows
 * through `readLeadRouting` / `readLeadEscalation` (which mirror the SQL),
 * count usable people by the SQL's own rule (routing: an ACTIVE member of
 * the org the rule names, any role — 0136 `submit_public_enquiry`) and by
 * `escalationRecipients` (escalation), arm the desk alert by
 * `enquiryAlertConfigured` and the acknowledgement by `enquiryAckConfigured`,
 * and word the sender by `senderReadinessCopy`.
 *
 * Server-only (BACKLOG ENV-1): it reads the provider key's presence.
 */

/* ------------------------------------------------------------------------- */
/* the environment                                                           */
/* ------------------------------------------------------------------------- */

export interface EnvFlags {
  resendKeySet: boolean;
  /** how many desk addresses ENQUIRY_ALERT_TO names — the addresses themselves never leave here */
  alertToCount: number;
  fromSet: boolean;
  /** the From's domain (public); null when the From holds no usable address */
  senderDomain: string | null;
  /** the From is Resend's shared test sender (unset, or a resend.dev address) */
  fromIsTestDomain: boolean;
  /** `enquiryAlertConfigured` */
  deskAlertArmed: boolean;
  /** `enquiryAckConfigured` */
  ackArmed: boolean;
  siteRevalidateUrlSet: boolean;
  siteRevalidateKeySet: boolean;
  cronSecretSet: boolean;
  ipHashSaltSet: boolean;
  forwardKeySet: boolean;
  sentryDsnSet: boolean;
  publicSentryDsnSet: boolean;
}

/**
 * The deployment's environment, reduced to what a page may print. The desk
 * count splits ENQUIRY_ALERT_TO exactly as the alert's sender does
 * (enquiry-alert.ts: split on commas, trim, drop empties), because that list
 * is the `to` of one message.
 */
export function readEnvFlags(env: NodeJS.ProcessEnv = process.env): EnvFlags {
  const domain = senderDomain(env.ENQUIRY_ALERT_FROM ?? DEFAULT_ALERT_FROM);
  return {
    resendKeySet: Boolean(env.RESEND_API_KEY),
    alertToCount: (env.ENQUIRY_ALERT_TO ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean).length,
    fromSet: env.ENQUIRY_ALERT_FROM !== undefined,
    senderDomain: domain,
    fromIsTestDomain: domain !== null && isResendTestDomain(domain),
    deskAlertArmed: enquiryAlertConfigured(env),
    ackArmed: enquiryAckConfigured(env),
    // notifySite (site-revalidate.ts) arms on both being truthy
    siteRevalidateUrlSet: Boolean(env.SITE_REVALIDATE_URL),
    siteRevalidateKeySet: Boolean(env.SITE_REVALIDATE_KEY),
    cronSecretSet: Boolean(env.CRON_SECRET),
    ipHashSaltSet: Boolean(env.IP_HASH_SALT),
    forwardKeySet: Boolean(env.ENQUIRY_FORWARD_KEY),
    // instrumentation.ts / instrumentation-client.ts arm on a truthy DSN
    sentryDsnSet: Boolean(env.SENTRY_DSN),
    publicSentryDsnSet: Boolean(env.NEXT_PUBLIC_SENTRY_DSN),
  };
}

/* ------------------------------------------------------------------------- */
/* the database                                                              */
/* ------------------------------------------------------------------------- */

export type Read<T> = { ok: true; value: T } | { ok: false };

/** A member as the rules need them: whether they have an address, never the address. */
export interface ReadinessMember {
  id: string;
  role: string;
  isActive: boolean;
  hasAddress: boolean;
}

export interface ReadinessFacts {
  env: EnvFlags;
  routing: Read<LeadRouting>;
  escalation: Read<LeadEscalationConfig>;
  /** the org's profiles; their rule-relevant shape only */
  members: Read<ReadinessMember[]>;
  branding: Read<{ logo: boolean; watermark: boolean }>;
}

type Answer = { data: unknown; error: { message?: string } | null };

/** A read that rejected instead of answering is a failed answer, never a thrown page. */
async function settle(q: PromiseLike<Answer>, label: string): Promise<Answer> {
  try {
    return await q;
  } catch (err) {
    return { data: null, error: { message: `${label} threw: ${err instanceof Error ? err.name : "unknown"}` } };
  }
}

function failed(res: Answer, label: string): boolean {
  if (res.error || !Array.isArray(res.data)) {
    // the label and the error MESSAGE only — PostgREST never echoes a value here
    console.warn(`[activation-readiness] ${label}: ${res.error?.message || "the answer held no rows"}`);
    return true;
  }
  return false;
}

/**
 * Every fact the overview needs except the provider's answer about the sender,
 * which the page asks separately (it may take up to three seconds). Reads in
 * parallel; NEVER throws — a read that fails is `{ ok: false }` and its rows
 * say "Could not check".
 *
 * `supabase` is the admin's own session (cyprus_config and profiles are
 * readable to an admin under RLS, as the two settings pages read them);
 * `admin` makes the service role, used only for the branding folder listing
 * — a factory, so a deployment whose service client cannot even be built
 * reads "Could not check" on the two branding rows instead of losing the
 * whole page. Profiles are scoped to `orgId` explicitly as well as by RLS.
 */
export async function loadReadinessFacts(
  supabase: SupabaseClient<Database>,
  admin: () => SupabaseClient<Database>,
  orgId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReadinessFacts> {
  const listBranding = async () => {
    try {
      return await readBrandingFiles(admin());
    } catch (err) {
      console.warn(`[activation-readiness] service client: ${err instanceof Error ? err.name : "unknown"}`);
      return { ok: false } as const;
    }
  };
  const [config, profiles, branding] = await Promise.all([
    settle(
      supabase.from("cyprus_config").select("key, value").in("key", ["lead_routing", "lead_escalation"]),
      "cyprus_config",
    ),
    settle(supabase.from("profiles").select("id, role, is_active, email").eq("org_id", orgId), "profiles"),
    listBranding(),
  ]);

  let routing: Read<LeadRouting> = { ok: false };
  let escalation: Read<LeadEscalationConfig> = { ok: false };
  if (!failed(config, "cyprus_config")) {
    const rows = config.data as Array<{ key: string; value: unknown }>;
    const value = (key: string) => rows.find((r) => r.key === key)?.value ?? null;
    // a MISSING row is not a failure: both SQL readers treat it as the
    // seeded default (off), and so do these
    routing = { ok: true, value: readLeadRouting(value("lead_routing")) };
    escalation = { ok: true, value: readLeadEscalation(value("lead_escalation")) };
  }

  let members: Read<ReadinessMember[]> = { ok: false };
  if (!failed(profiles, "profiles")) {
    const rows = profiles.data as Array<{ id: string; role: string; is_active: boolean; email: string | null }>;
    members = {
      ok: true,
      value: rows.map((p) => ({
        id: p.id,
        role: p.role,
        isActive: p.is_active === true,
        hasAddress: typeof p.email === "string" && p.email.trim() !== "",
      })),
    };
  }

  return {
    env: readEnvFlags(env),
    routing,
    escalation,
    members,
    branding: branding.ok
      ? { ok: true, value: { logo: branding.files.logo !== undefined, watermark: branding.files.watermark !== undefined } }
      : { ok: false },
  };
}

/* ------------------------------------------------------------------------- */
/* the rows                                                                  */
/* ------------------------------------------------------------------------- */

export const READINESS_STATES = [
  "on",
  "off",
  "needs_setup",
  "not_built",
  "attention",
  "unknown",
  "checking",
] as const;
export type ReadinessState = (typeof READINESS_STATES)[number];

/** The pill's word for each state. The word carries the meaning; colour only repeats it. */
export const STATE_LABEL: Record<ReadinessState, string> = {
  on: "On",
  off: "Off",
  needs_setup: "Needs setup outside the CRM",
  not_built: "Not built",
  attention: "Needs attention",
  unknown: "Could not check",
  checking: "Checking…",
};

export type ReadinessGroup = "enquiries" | "listings" | "branding";

export const GROUP_TITLE: Record<ReadinessGroup, string> = {
  enquiries: "Website enquiries",
  listings: "Listings & marketing",
  branding: "Branding",
};

export type NextStepWho = "admin" | "operator" | "development";

export const WHO_LABEL: Record<NextStepWho, string> = {
  admin: "Admin, in the CRM",
  operator: "Operator, outside the CRM",
  development: "Development",
};

export interface ReadinessRow {
  id: string;
  group: ReadinessGroup;
  name: string;
  state: ReadinessState;
  /** the pill's word when a row has a more exact one than STATE_LABEL (Uploaded, Verified, …) */
  label?: string;
  summary: string;
  nextStep: { who: NextStepWho; text: string } | null;
  link: { href: string; text: string } | null;
}

const COULD_NOT_READ = "reload the page to ask again.";
const SENDER_SETUP =
  "Verify the firm's sending domain in Resend (its DNS records go in at the DNS host), set ENQUIRY_ALERT_FROM in Vercel to an address on it, then redeploy.";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The worker's own gate, by name: what is missing for this deployment to send at all. */
function mailSetup(env: EnvFlags): string {
  const missing = [!env.resendKeySet && "RESEND_API_KEY", env.alertToCount === 0 && "ENQUIRY_ALERT_TO"].filter(Boolean);
  return missing.length ? `Set ${missing.join(" and ")} in Vercel.` : "";
}

/** Routing's usable people, by the SQL's rule: listed, an active member of this org (any role). */
function routingUsable(rule: LeadRouting, members: ReadinessMember[]): number {
  const active = new Set(members.filter((m) => m.isActive).map((m) => m.id));
  return new Set(rule.agents.filter((id) => active.has(id))).size;
}

/**
 * Escalation's eligible recipients by `escalationRecipients` itself (active,
 * admin or agent, of the org, with an address). The member's id stands in
 * for the address it never carries here — the rule only asks whether there
 * is one. No assignee: this counts the policy, not one lead.
 */
function escalationEligible(policy: LeadEscalationConfig, members: ReadinessMember[]): number {
  const ORG = "this-org";
  return escalationRecipients(
    policy,
    members.map((m) => ({ id: m.id, org_id: ORG, email: m.hasAddress ? m.id : null, role: m.role, is_active: m.isActive })),
    { org_id: ORG, assigned_agent_id: null },
  ).length;
}

function routingRow(facts: ReadinessFacts): ReadinessRow {
  const base = {
    id: "lead-routing",
    group: "enquiries" as const,
    name: "Lead routing",
    link: { href: "/settings/lead-routing", text: "Open Lead routing" },
  };
  if (!facts.routing.ok) {
    return { ...base, state: "unknown", summary: `The routing rule could not be read — ${COULD_NOT_READ}`, nextStep: null };
  }
  const rule = facts.routing.value;
  if (rule.mode === "off") {
    return {
      ...base,
      state: "off",
      summary:
        "Website enquiries arrive unassigned and wait in the lead inbox for someone to take them. After an hour without an answer, a follow-up task goes to whoever took it — or, if nobody did, to the oldest active admin.",
      nextStep: { who: "admin", text: "Whether to route enquiries round-robin, and to whom, is decided on Lead routing." },
    };
  }
  if (!facts.members.ok) {
    return {
      ...base,
      state: "unknown",
      summary: `Round-robin is set, but who can receive enquiries could not be read — ${COULD_NOT_READ}`,
      nextStep: null,
    };
  }
  const usable = routingUsable(rule, facts.members.value);
  if (usable === 0) {
    return {
      ...base,
      state: "attention",
      summary:
        "Round-robin is set, but nobody it names is an active member — every website enquiry arrives unassigned, as if routing were off.",
      nextStep: { who: "admin", text: "Choose at least one active member on Lead routing, or switch it off there." },
    };
  }
  return {
    ...base,
    state: "on",
    summary: `Round-robin over ${plural(usable, "person", "people")}: each website enquiry goes to whoever has the fewest open leads.`,
    nextStep: null,
  };
}

/** How the provider's answer bears on a message that names other people. */
type SenderVerdict = "checking" | "verified" | "refused" | "unconfigured" | "unknown";

function senderVerdict(sender: SenderReadiness | null): SenderVerdict {
  if (sender === null) return "checking";
  switch (sender.state) {
    case "domain_verified":
      return "verified";
    case "custom_unverified":
      return "unknown";
    case "not_configured":
      return "unconfigured";
    case "test_sender":
    case "custom_not_verified":
    case "invalid_from":
    case "key_rejected":
      return "refused";
  }
}

function escalationRow(facts: ReadinessFacts, sender: SenderReadiness | null): ReadinessRow {
  const base = {
    id: "lead-escalation",
    group: "enquiries" as const,
    name: "Lead escalation",
    link: { href: "/settings/lead-escalation", text: "Open Lead escalation" },
  };
  if (!facts.escalation.ok) {
    return { ...base, state: "unknown", summary: `The escalation policy could not be read — ${COULD_NOT_READ}`, nextStep: null };
  }
  const policy = facts.escalation.value;
  const verdict = senderVerdict(sender);

  if (!policy.enabled) {
    const off =
      "Off. Nobody else is e-mailed when a website enquiry goes unanswered; the one-hour follow-up task still lands.";
    if (verdict === "verified") {
      return {
        ...base,
        state: "off",
        summary: off,
        nextStep: { who: "admin", text: "Switching it on is decided on Lead escalation: preview, then Save." },
      };
    }
    if (verdict === "checking") {
      return { ...base, state: "off", summary: `${off} Checking the sending domain…`, nextStep: null };
    }
    if (verdict === "unknown") {
      return {
        ...base,
        state: "off",
        summary: `${off} Whether the sending domain is verified could not be checked — see Sending domain.`,
        nextStep: { who: "operator", text: "Check the sending domain's status in Resend before it is switched on." },
      };
    }
    if (verdict === "unconfigured") {
      return {
        ...base,
        state: "off",
        summary: `${off} Switching it on waits for e-mail to be set up on this deployment — see Sending domain.`,
        nextStep: { who: "operator", text: "Finish the e-mail setup first (see Sending domain); switching it on is then decided on Lead escalation." },
      };
    }
    return {
      ...base,
      state: "off",
      summary:
        `${off} Switching it on waits for a verified sending domain: an escalation names all its recipients in one message, ` +
        "and until the domain is verified the mail service refuses a message to anyone but the account owner.",
      nextStep: { who: "operator", text: "Finish the sending-domain setup first (see Sending domain); switching it on is then decided on Lead escalation." },
    };
  }

  if (!facts.members.ok) {
    return { ...base, state: "unknown", summary: `On, but who would receive it could not be read — ${COULD_NOT_READ}`, nextStep: null };
  }
  const eligible = escalationEligible(policy, facts.members.value);
  if (eligible === 0) {
    return {
      ...base,
      state: "attention",
      summary:
        "On, but none of its recipients is an active admin or agent with an e-mail address — every escalation is cancelled with nobody to tell.",
      nextStep: { who: "admin", text: "Choose recipients on Lead escalation." },
    };
  }
  const when = `after ${plural(policy.after_minutes, "minute", "minutes")} of ${policy.working_hours ? "working" : "clock"} time without an answer`;
  const who = plural(eligible, "recipient", "recipients");
  switch (verdict) {
    case "verified":
      return { ...base, state: "on", summary: `On: ${who} e-mailed about a website enquiry ${when}.`, nextStep: null };
    case "checking":
      return { ...base, state: "checking", summary: `On: ${who}, ${when}. Checking the sending domain…`, nextStep: null };
    case "unknown":
      return {
        ...base,
        state: "unknown",
        summary: `On: ${who}, ${when}. Whether the mail service accepts its messages could not be checked — see Sending domain.`,
        nextStep: { who: "operator", text: "Check the sending domain's status in Resend." },
      };
    case "unconfigured":
      return {
        ...base,
        state: "attention",
        summary: `On, but this deployment cannot send e-mail (see Sending domain) — escalations wait unsent.`,
        nextStep: { who: "operator", text: `${mailSetup(facts.env)} Then redeploy.`.trim() },
      };
    case "refused":
      return {
        ...base,
        state: "attention",
        summary:
          `On (${who}), but the sending domain is not verified — the mail service refuses a message naming anyone but the account owner, ` +
          "and an escalation names all its recipients in one message.",
        nextStep: { who: "operator", text: SENDER_SETUP },
      };
  }
}

function deskAlertRow(facts: ReadinessFacts, sender: SenderReadiness | null): ReadinessRow {
  const env = facts.env;
  const base = { id: "desk-alert", group: "enquiries" as const, name: "Desk alert e-mail", link: null };
  if (!env.deskAlertArmed) {
    const missing = [!env.resendKeySet && "RESEND_API_KEY", env.alertToCount === 0 && "ENQUIRY_ALERT_TO"].filter(Boolean).join(" and ");
    return {
      ...base,
      state: "needs_setup",
      summary: `Not sent from this deployment (${missing} not set): no e-mail tells the desk a website enquiry arrived. Enquiries still land in the lead inbox.`,
      nextStep: { who: "operator", text: `Set ${missing} in Vercel, then redeploy.` },
    };
  }
  if (env.alertToCount === 0) {
    // armed by a truthy ENQUIRY_ALERT_TO that names nobody (" , ")
    return {
      ...base,
      state: "attention",
      summary: "Armed, but ENQUIRY_ALERT_TO names no address — every desk alert would be refused.",
      nextStep: { who: "operator", text: "Put the desk's address in ENQUIRY_ALERT_TO in Vercel, then redeploy." },
    };
  }
  const to = plural(env.alertToCount, "desk address", "desk addresses");
  if (sender === null) {
    return { ...base, state: "checking", summary: `Each website enquiry is e-mailed to ${to}. Checking the sender…`, nextStep: null };
  }
  switch (sender.state) {
    case "domain_verified":
      return { ...base, state: "on", summary: `Each website enquiry is e-mailed to ${to}, from ${sender.domain}.`, nextStep: null };
    case "test_sender":
      return env.alertToCount > 1
        ? {
            ...base,
            state: "attention",
            summary: `Each website enquiry is e-mailed to ${to} in one message from Resend's test sender, which refuses a message naming anyone but the address that owns the Resend account.`,
            nextStep: { who: "operator", text: SENDER_SETUP },
          }
        : {
            ...base,
            state: "on",
            summary: `Each website enquiry is e-mailed to ${to}, from Resend's test sender — it arrives only if that address owns the Resend account.`,
            nextStep: { who: "operator", text: SENDER_SETUP },
          };
    case "custom_unverified":
    case "not_configured":
      return {
        ...base,
        state: "unknown",
        summary: `Each website enquiry is e-mailed to ${to}${env.senderDomain ? `, from ${env.senderDomain}` : ""}; whether the mail service accepts it could not be checked — see Sending domain.`,
        nextStep: { who: "operator", text: "Check the sending domain's status in Resend." },
      };
    case "custom_not_verified":
    case "invalid_from":
    case "key_rejected":
      return {
        ...base,
        state: "attention",
        summary: `Armed for ${to}, but the mail service refuses what this deployment sends — see Sending domain.`,
        nextStep: { who: "operator", text: sender.state === "key_rejected" ? "Replace RESEND_API_KEY in Vercel with a valid key, then redeploy." : SENDER_SETUP },
      };
  }
}

/** The Sending domain row's pill word per provider answer (the sentence is senderReadinessCopy's). */
const SENDER_PILL: Record<SenderReadiness["state"], { state: ReadinessState; label: string }> = {
  domain_verified: { state: "on", label: "Verified" },
  test_sender: { state: "needs_setup", label: "Test sender only" },
  not_configured: { state: "needs_setup", label: "Not configured" },
  custom_unverified: { state: "unknown", label: "Could not check" },
  custom_not_verified: { state: "attention", label: "Refused" },
  invalid_from: { state: "attention", label: "Refused" },
  key_rejected: { state: "attention", label: "Refused" },
};

function senderRow(facts: ReadinessFacts, sender: SenderReadiness | null): ReadinessRow {
  const base = { id: "sending-domain", group: "enquiries" as const, name: "Sending domain", link: null };
  if (sender === null) {
    return { ...base, state: "checking", summary: "Asking the mail service about the sending domain…", nextStep: null };
  }
  const pill = SENDER_PILL[sender.state];
  const nextStep = ((): ReadinessRow["nextStep"] => {
    switch (sender.state) {
      case "domain_verified":
        return null;
      case "key_rejected":
        return { who: "operator", text: "Replace RESEND_API_KEY in Vercel with a valid key, then redeploy." };
      case "custom_unverified":
        return { who: "operator", text: "Check the domain's status in Resend." };
      case "not_configured":
        return { who: "operator", text: `${mailSetup(facts.env)} ${SENDER_SETUP}` };
      default:
        return { who: "operator", text: SENDER_SETUP };
    }
  })();
  return { ...base, state: pill.state, label: pill.label, summary: senderReadinessCopy(sender).text, nextStep };
}

function ackRow(facts: ReadinessFacts, sender: SenderReadiness | null): ReadinessRow {
  const env = facts.env;
  const base = { id: "visitor-ack", group: "enquiries" as const, name: "Visitor acknowledgement", link: null };
  if (!env.ackArmed) {
    return {
      ...base,
      state: "needs_setup",
      summary:
        "Not sent: a visitor who leaves an e-mail address gets no confirmation that the enquiry arrived. It is sent only from the firm's own sending address — never Resend's test sender.",
      nextStep: { who: "operator", text: env.resendKeySet ? SENDER_SETUP : `Set RESEND_API_KEY in Vercel. ${SENDER_SETUP}` },
    };
  }
  if (sender === null) {
    return { ...base, state: "checking", summary: "Armed on this deployment. Checking the sending domain…", nextStep: null };
  }
  switch (sender.state) {
    case "domain_verified":
      return {
        ...base,
        state: "on",
        summary: `Each enquirer who leaves an e-mail address gets a short confirmation from ${sender.domain}.`,
        nextStep: null,
      };
    case "custom_unverified":
    case "not_configured":
      return {
        ...base,
        state: "unknown",
        summary: `Armed${env.senderDomain ? `, from ${env.senderDomain}` : ""}; whether the mail service accepts it could not be checked — see Sending domain.`,
        nextStep: { who: "operator", text: "Check the sending domain's status in Resend." },
      };
    case "test_sender":
    case "custom_not_verified":
    case "invalid_from":
    case "key_rejected":
      return {
        ...base,
        state: "attention",
        summary: "Armed, but the mail service refuses what this deployment sends — every acknowledgement fails. See Sending domain.",
        nextStep: { who: "operator", text: sender.state === "key_rejected" ? "Replace RESEND_API_KEY in Vercel with a valid key, then redeploy." : SENDER_SETUP },
      };
  }
}

function siteRefreshRow(facts: ReadinessFacts): ReadinessRow {
  const env = facts.env;
  const base = { id: "site-refresh", group: "listings" as const, name: "Website refresh on change", link: null };
  if (env.siteRevalidateUrlSet && env.siteRevalidateKeySet) {
    return {
      ...base,
      state: "on",
      summary: "When a public listing changes here, the website is asked to refresh its page at once.",
      nextStep: null,
    };
  }
  const missing = [!env.siteRevalidateUrlSet && "SITE_REVALIDATE_URL", !env.siteRevalidateKeySet && "SITE_REVALIDATE_KEY"]
    .filter(Boolean)
    .join(" and ");
  return {
    ...base,
    state: "needs_setup",
    summary: `Not armed (${missing} not set): the website picks up changes on its own timers, within an hour.`,
    nextStep: { who: "operator", text: `Set ${missing} in Vercel (the key is the one the website holds), then redeploy.` },
  };
}

/**
 * The portals not built yet, in the repo's own words (the registry's pending
 * entries and BACKLOG's milestone 2). Deliberately NOT read from
 * lib/services/portals/** or portal_connections: the portal work is being
 * rewritten, and which built portals are switched on is the Portals page's
 * to say. This row states only what is absent from the build.
 */
function portalsRow(): ReadinessRow {
  return {
    id: "portals",
    group: "listings",
    name: "Portal feeds not built yet",
    state: "not_built",
    summary:
      "RERA.cy and Thribee are scheduled for portal milestone 2 (Thribee also needs the website's listing-URL pattern). " +
      "Bazaraki Pro and Prian.ru need the portal's XML format first — Bazaraki gives it to Pro accounts, Prian on request. " +
      "Which of the other portals are switched on is shown on the Portals page.",
    nextStep: { who: "development", text: "Built when their milestone, or the portal's format, arrives." },
    link: { href: "/settings/portals", text: "Open Portals" },
  };
}

function brandingRows(facts: ReadinessFacts): ReadinessRow[] {
  const link = { href: "/settings/organization", text: "Open Organization" };
  if (!facts.branding.ok) {
    return (["logo", "watermark"] as const).map((kind) => ({
      id: kind,
      group: "branding" as const,
      name: kind === "logo" ? "Logo" : "Watermark",
      state: "unknown" as const,
      summary: `Whether one is uploaded could not be checked — ${COULD_NOT_READ}`,
      nextStep: null,
      link,
    }));
  }
  const { logo, watermark } = facts.branding.value;
  return [
    {
      id: "logo",
      group: "branding",
      name: "Logo",
      state: logo ? "on" : "off",
      label: logo ? "Uploaded" : "Not uploaded",
      summary: logo ? BRANDING_USE.logo : "No logo uploaded. No document or report prints one yet, so this changes nothing today.",
      nextStep: { who: "development", text: "A document or report that prints the logo is not built." },
      link,
    },
    {
      id: "watermark",
      group: "branding",
      name: "Watermark",
      state: watermark ? "on" : "off",
      label: watermark ? "Uploaded" : "Not uploaded",
      summary: watermark ? BRANDING_USE.watermark : "Photos of public and partner listings are published without a watermark.",
      nextStep: watermark ? null : { who: "admin", text: "To add one, upload a PNG with transparency on Organization." },
      link,
    },
  ];
}

/**
 * Every row, in page order. Pure. `sender` is the provider's answer
 * (`senderReadiness`), or null while it is still being asked — the rows that
 * depend on it then read "Checking…", never a guess.
 */
export function buildReadinessRows(facts: ReadinessFacts, sender: SenderReadiness | null): ReadinessRow[] {
  return [
    routingRow(facts),
    escalationRow(facts, sender),
    deskAlertRow(facts, sender),
    senderRow(facts, sender),
    ackRow(facts, sender),
    siteRefreshRow(facts),
    portalsRow(),
    ...brandingRows(facts),
  ];
}

export interface TechnicalFlag {
  name: string;
  set: boolean;
  /** what "set" means, when a count says more than yes */
  detail?: string;
  /** what this deployment does without it */
  whenUnset: string;
}

/** The environment's names, set or not — never a value. */
export function technicalFlags(env: EnvFlags): TechnicalFlag[] {
  return [
    { name: "RESEND_API_KEY", set: env.resendKeySet, whenUnset: "no e-mail is sent from this deployment." },
    {
      name: "ENQUIRY_ALERT_TO",
      set: env.alertToCount > 0,
      detail: env.alertToCount > 0 ? plural(env.alertToCount, "address", "addresses") : undefined,
      whenUnset: "the desk alert has nobody to tell.",
    },
    {
      name: "ENQUIRY_ALERT_FROM",
      set: env.fromSet,
      detail: env.fromSet
        ? env.senderDomain
          ? `on ${env.senderDomain}${env.fromIsTestDomain ? " (Resend's test sender)" : ""}`
          : "holds no usable address"
        : undefined,
      whenUnset: "mail leaves from Resend's test sender, which reaches only the Resend account's owner.",
    },
    { name: "SITE_REVALIDATE_URL", set: env.siteRevalidateUrlSet, whenUnset: "the website refreshes on its own timers." },
    { name: "SITE_REVALIDATE_KEY", set: env.siteRevalidateKeySet, whenUnset: "the website refreshes on its own timers." },
    {
      name: "CRON_SECRET",
      set: env.cronSecretSet,
      whenUnset: "the desk-alert sweep refuses every run, so an alert the enquiry missed waits.",
    },
    {
      name: "ENQUIRY_FORWARD_KEY",
      set: env.forwardKeySet,
      whenUnset: "enquiries the website forwards are rate-limited on the website's own address, as if from one visitor.",
    },
    {
      name: "IP_HASH_SALT",
      set: env.ipHashSaltSet,
      whenUnset: "rate-limit fingerprints are salted with the public project URL, which is weaker.",
    },
    { name: "SENTRY_DSN", set: env.sentryDsnSet, whenUnset: "server errors are not reported to Sentry." },
    { name: "NEXT_PUBLIC_SENTRY_DSN", set: env.publicSentryDsnSet, whenUnset: "browser errors are not reported to Sentry." },
  ];
}
