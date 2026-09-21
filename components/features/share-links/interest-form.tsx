"use client";

import { useId, useRef, useState, type FormEvent } from "react";

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
 * An error keeps the form and the same idempotency key, so a retry after a
 * lost answer is the same lead, never a second one. The key lives in a ref
 * (a hidden input's defaultValue is not storage: React re-syncs it on every
 * render). A 404 is terminal: the link is no longer usable.
 */
const COPY = {
  en: {
    cta: "I'm interested",
    heading: "Tell us how to reach you about",
    name: "Your name",
    email: "Email",
    phone: "Phone",
    message: "Message",
    optional: "optional",
    send: "Send",
    sending: "Sending…",
    cancel: "Cancel",
    reply: "Please give an email address or a phone number.",
    done: "Thank you — we have noted your interest in",
    doneBy: "will be in touch.",
    error: "We could not record your interest. Please try again.",
    gone: "This link is no longer available. Please contact your agent.",
    tooMany: "Too many requests from this connection. Please try again in a few minutes.",
  },
  el: {
    cta: "Με ενδιαφέρει",
    heading: "Πείτε μας πώς να επικοινωνήσουμε μαζί σας για το",
    name: "Το όνομά σας",
    email: "Email",
    phone: "Τηλέφωνο",
    message: "Μήνυμα",
    optional: "προαιρετικό",
    send: "Αποστολή",
    sending: "Αποστολή…",
    cancel: "Άκυρο",
    reply: "Δώστε μια διεύθυνση email ή έναν αριθμό τηλεφώνου.",
    done: "Ευχαριστούμε — καταγράψαμε το ενδιαφέρον σας για το",
    doneBy: "θα επικοινωνήσει μαζί σας.",
    error: "Δεν ήταν δυνατή η καταγραφή του ενδιαφέροντός σας. Δοκιμάστε ξανά.",
    gone: "Ο σύνδεσμος δεν είναι πλέον διαθέσιμος. Επικοινωνήστε με τον σύμβουλό σας.",
    tooMany: "Πάρα πολλά αιτήματα από αυτή τη σύνδεση. Δοκιμάστε ξανά σε λίγα λεπτά.",
  },
  ru: {
    cta: "Мне интересно",
    heading: "Как с вами связаться по объекту",
    name: "Ваше имя",
    email: "Эл. почта",
    phone: "Телефон",
    message: "Сообщение",
    optional: "необязательно",
    send: "Отправить",
    sending: "Отправка…",
    cancel: "Отмена",
    reply: "Укажите адрес эл. почты или номер телефона.",
    done: "Спасибо — мы отметили ваш интерес к объекту",
    doneBy: "свяжется с вами.",
    error: "Не удалось сохранить ваш запрос. Попробуйте ещё раз.",
    gone: "Эта ссылка больше недоступна. Обратитесь к вашему агенту.",
    tooMany: "Слишком много запросов с этого подключения. Попробуйте через несколько минут.",
  },
} as const;

export type InterestLocale = keyof typeof COPY;

type Phase = "idle" | "open" | "submitting" | "done" | "gone" | "error";

const field =
  "w-full rounded-[8px] border border-border bg-bg px-3 py-2 text-base text-text-1 outline-none focus:border-brand-700 focus:ring-2 focus:ring-brand-700/30";

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
  const t = COPY[locale];
  const id = useId();
  const [phase, setPhase] = useState<Phase>("idle");
  const [problem, setProblem] = useState<string | null>(null);
  // One key for the life of this form: a retry is the same lead.
  const keyRef = useRef<string | null>(null);
  if (keyRef.current === null) keyRef.current = crypto.randomUUID();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const phone = String(data.get("phone") ?? "").trim();
    if (!email && !phone) {
      setProblem(t.reply);
      setPhase("error");
      return;
    }
    setProblem(null);
    setPhase("submitting");
    try {
      const res = await fetch("/api/public/proposals/interest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          property_reference: reference,
          name: String(data.get("name") ?? ""),
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
      if (res.status === 429) {
        setProblem(t.tooMany);
        setPhase("error");
        return;
      }
      if (res.status === 400) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setProblem(body?.error ?? t.error);
        setPhase("error");
        return;
      }
      setProblem(t.error);
      setPhase("error");
    } catch {
      // the answer was lost: the key makes the retry the same lead
      setProblem(t.error);
      setPhase("error");
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
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-2 rounded-[8px] border border-border bg-bg/60 p-3" aria-busy={busy}>
      <p className="text-sm font-medium text-text-1">
        {t.heading} <span className="font-mono">{reference}</span>
      </p>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-name`} className="text-xs text-text-2">
          {t.name}
        </label>
        <input id={`${id}-name`} name="name" required maxLength={200} autoComplete="name" className={field} disabled={busy} />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-email`} className="text-xs text-text-2">
            {t.email}
          </label>
          <input id={`${id}-email`} name="email" type="email" inputMode="email" maxLength={320} autoComplete="email" className={field} disabled={busy} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-phone`} className="text-xs text-text-2">
            {t.phone}
          </label>
          <input id={`${id}-phone`} name="phone" type="tel" inputMode="tel" maxLength={40} autoComplete="tel" className={field} disabled={busy} />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-message`} className="text-xs text-text-2">
          {t.message} <span className="text-text-3">({t.optional})</span>
        </label>
        <textarea id={`${id}-message`} name="message" rows={3} maxLength={5000} className={field} disabled={busy} />
      </div>
      {/* HONEYPOT: never shown, never focusable; a bot that fills every field fills this one. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        <label htmlFor={`${id}-website`}>Website</label>
        <input id={`${id}-website`} name="website" tabIndex={-1} autoComplete="off" />
      </div>
      {problem ? (
        <p role="alert" className="text-sm text-danger">
          {problem}
        </p>
      ) : null}
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
