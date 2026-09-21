"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { INTEREST_COPY, interestProblemText, type InterestLocale } from "@/lib/services/proposal-interest-copy";
import type { ProposalInterestField } from "@/lib/validators/proposal-interest";

/**
 * "I'm interested" on ONE property of a shared proposal (0106).
 *
 * The buyer is a stranger with a forwarded link on a phone: no login, no
 * account, and nothing pre-filled — a forwarded link proves nothing about
 * who is typing, so the recipient the link was made for is never assumed.
 * They give a name and a way to reply, and the CRM makes a real enquiry out
 * of it (a lead for the proposal's author, a desk alert, an acknowledgement).
 *
 * States: idle (one button) → open (the form) → submitting → done | error.
 * An error keeps the form, what was typed and the same idempotency key, so
 * a retry after a lost answer — or after a correction — is the same lead,
 * never a second one. The key lives in a ref (a hidden input's defaultValue
 * is not storage: React re-syncs it on every render). A 404 is terminal:
 * the link is no longer usable.
 *
 * A REFUSAL SPEAKS THE PAGE'S LANGUAGE (audit 2026-09-22, finding 2). The
 * route answers a 400 with a CODE and the FIELD it concerns, never a
 * sentence the page should repeat; the sentence comes from
 * lib/services/proposal-interest-copy.ts in the proposal's locale, and is
 * rendered under the control it concerns, named by aria-describedby, with
 * aria-invalid on that control. The server stays the authority: the two
 * checks made here before posting (a name, a way to reply) only save a
 * round trip and speak through the same path.
 */
export type { InterestLocale };

type Phase = "idle" | "open" | "submitting" | "done" | "gone" | "error";

interface Problem {
  /** the route's code, or one of the page's own two — rendered through interestProblemText */
  code: string;
  field: ProposalInterestField;
}

const FIELDS: ReadonlyArray<NonNullable<ProposalInterestField>> = ["name", "email", "phone", "message", "contact"];
const asField = (v: unknown): ProposalInterestField =>
  typeof v === "string" && (FIELDS as ReadonlyArray<string>).includes(v) ? (v as ProposalInterestField) : null;

const field =
  "w-full rounded-[8px] border border-border bg-bg px-3 py-2 text-base text-text-1 outline-none focus:border-brand-700 focus:ring-2 focus:ring-brand-700/30 aria-[invalid=true]:border-danger";

export function InterestForm({
  token,
  reference,
  locale,
  agentName,
}: {
  token: string;
  reference: string;
  locale: InterestLocale;
  agentName: string | null;
}) {
  const t = INTEREST_COPY[locale];
  const id = useId();
  const [phase, setPhase] = useState<Phase>("idle");
  const [problem, setProblem] = useState<Problem | null>(null);
  // One key for the life of this form: a retry is the same lead.
  const keyRef = useRef<string | null>(null);
  if (keyRef.current === null) keyRef.current = crypto.randomUUID();

  function refuse(code: string, field: ProposalInterestField) {
    setProblem({ code, field });
    setPhase("error");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const email = String(data.get("email") ?? "").trim();
    const phone = String(data.get("phone") ?? "").trim();
    // The two refusals the page can make without a round trip; the route
    // makes the same ones, in the same words, when they are skipped.
    if (!name) return refuse("name_required", "name");
    if (!email && !phone) return refuse("contact_required", "contact");
    setProblem(null);
    setPhase("submitting");
    try {
      const res = await fetch("/api/public/proposals/interest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          property_reference: reference,
          name,
          email,
          phone,
          message: String(data.get("message") ?? ""),
          website: String(data.get("website") ?? ""),
          idempotency_key: keyRef.current,
        }),
      });
      if (res.status === 202) {
        setPhase("done");
        return;
      }
      if (res.status === 404) {
        setPhase("gone");
        return;
      }
      if (res.status === 429) return refuse("rate_limited", null);
      if (res.status === 400) {
        // the code and the field, never the sentence: the route's words are
        // English, the page's are the proposal's language
        const body = (await res.json().catch(() => null)) as { code?: unknown; field?: unknown } | null;
        return refuse(typeof body?.code === "string" ? body.code : "invalid_request", asField(body?.field));
      }
      refuse("unavailable", null);
    } catch {
      // the answer was lost: the key makes the retry the same lead
      refuse("network", null);
    }
  }

  if (phase === "done") {
    return (
      <p role="status" aria-live="polite" className="rounded-[8px] border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
        {t.done} <span className="font-mono">{reference}</span>.{agentName ? ` ${agentName} ${t.doneBy}` : ""}
      </p>
    );
  }
  if (phase === "gone") {
    return (
      <p role="status" aria-live="polite" className="rounded-[8px] border border-border bg-bg px-3 py-2 text-sm text-text-2">
        {t.gone}
      </p>
    );
  }
  if (phase === "idle") {
    return (
      <button
        type="button"
        onClick={() => setPhase("open")}
        className="w-full rounded-[8px] bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-800 focus:outline-none focus:ring-2 focus:ring-brand-700/40 sm:w-auto"
      >
        {t.cta}
      </button>
    );
  }

  const busy = phase === "submitting";
  // One problem at a time, rendered under the control it concerns; the
  // e-mail/phone pair share one message. `text` is the page's sentence for
  // the code, or the generic one for a code the page does not know.
  const text = problem ? (problem.code === "rate_limited" ? t.tooMany : interestProblemText(locale, problem.code)) : null;
  const errorId = `${id}-error`;
  const invalid = (f: NonNullable<ProposalInterestField>) => problem?.field === f || undefined;
  const contactInvalid = (f: "email" | "phone") => problem?.field === f || problem?.field === "contact" || undefined;
  const describedBy = (on: boolean | undefined) => (on ? errorId : undefined);
  // a plain function, not a nested component: a new component type on every
  // render would remount the message and re-announce it
  const problemAt = (when: boolean) =>
    when && text ? (
      <p id={errorId} role="alert" className="text-sm text-danger">
        {text}
      </p>
    ) : null;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-2 rounded-[8px] border border-border bg-bg/60 p-3" aria-busy={busy}>
      <p className="text-sm font-medium text-text-1">
        {t.heading} <span className="font-mono">{reference}</span>
      </p>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-name`} className="text-xs text-text-2">
          {t.name}
        </label>
        <input
          id={`${id}-name`}
          name="name"
          required
          maxLength={200}
          autoComplete="name"
          className={field}
          disabled={busy}
          aria-invalid={invalid("name")}
          aria-describedby={describedBy(invalid("name"))}
        />
        {problemAt(problem?.field === "name")}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-email`} className="text-xs text-text-2">
            {t.email}
          </label>
          <input
            id={`${id}-email`}
            name="email"
            type="email"
            inputMode="email"
            maxLength={320}
            autoComplete="email"
            className={field}
            disabled={busy}
            aria-invalid={contactInvalid("email")}
            aria-describedby={describedBy(contactInvalid("email"))}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-phone`} className="text-xs text-text-2">
            {t.phone}
          </label>
          <input
            id={`${id}-phone`}
            name="phone"
            type="tel"
            inputMode="tel"
            maxLength={40}
            autoComplete="tel"
            className={field}
            disabled={busy}
            aria-invalid={contactInvalid("phone")}
            aria-describedby={describedBy(contactInvalid("phone"))}
          />
        </div>
      </div>
      {problemAt(problem?.field === "email" || problem?.field === "phone" || problem?.field === "contact")}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-message`} className="text-xs text-text-2">
          {t.message} <span className="text-text-3">({t.optional})</span>
        </label>
        <textarea
          id={`${id}-message`}
          name="message"
          rows={3}
          maxLength={5000}
          className={field}
          disabled={busy}
          aria-invalid={invalid("message")}
          aria-describedby={describedBy(invalid("message"))}
        />
        {problemAt(problem?.field === "message")}
      </div>
      {/* HONEYPOT: never shown, never focusable; a bot that fills every field fills this one. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label htmlFor={`${id}-website`}>Website</label>
        <input id={`${id}-website`} name="website" tabIndex={-1} autoComplete="off" />
      </div>
      {/* a problem with no field: a lost answer, a 5xx, the rate meter, a code the page does not know */}
      {problemAt(problem !== null && problem.field === null)}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={() => {
            setProblem(null);
            setPhase("idle");
          }}
          disabled={busy}
          className="rounded-[8px] border border-border px-4 py-2 text-sm text-text-2 hover:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-700/30"
        >
          {t.cancel}
        </button>
        <button
          type="submit"
          disabled={busy}
          className="rounded-[8px] bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 focus:outline-none focus:ring-2 focus:ring-brand-700/40 disabled:opacity-60"
        >
          {busy ? t.sending : t.send}
        </button>
      </div>
    </form>
  );
}
