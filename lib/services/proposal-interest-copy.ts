/**
 * The proposal page's words for "I'm interested" (0106), in the three
 * languages a proposal is made in. Public share-link pages do not go through
 * next-intl — there is no signed-in user whose locale a request carries; the
 * PROPOSAL carries one (`share_links.locale`) — so, like proposal.tsx and
 * availability.tsx beside it, the dictionary lives in code and the component
 * indexes it by the proposal's locale.
 *
 * `problems` is the half the audit of 2026-09-22 (finding 2) added: the
 * route answers a rejected submission with a CODE and a FIELD
 * (lib/validators/proposal-interest.ts), and `interestProblemText` turns the
 * code into a sentence in the page's language. A code the page does not
 * know — a later deploy's, or one only the page itself can cause — is the
 * generic sentence, never English in a Greek page and never a blank.
 *
 * Kept free of React so a node test can check every code against every
 * locale without a DOM.
 */
export const INTEREST_LOCALES = ["en", "el", "ru"] as const;
export type InterestLocale = (typeof INTEREST_LOCALES)[number];

/**
 * The codes a VISITOR can cause with the form; each has a sentence in every
 * locale. The two `_line_break` codes (T-enquiry-identity-single-line) are
 * reachable only from a client that is not this page — its inputs cannot
 * hold a line break — and still get a sentence of their own, never
 * "please enter your name" to someone who did.
 */
export const VISITOR_PROBLEM_CODES = [
  "name_required",
  "name_too_long",
  "name_line_break",
  "email_invalid",
  "email_too_long",
  "phone_too_long",
  "phone_line_break",
  "message_too_long",
  "contact_required",
] as const;
export type VisitorProblemCode = (typeof VISITOR_PROBLEM_CODES)[number];

interface InterestCopy {
  cta: string;
  heading: string;
  name: string;
  email: string;
  phone: string;
  message: string;
  optional: string;
  send: string;
  sending: string;
  cancel: string;
  done: string;
  doneBy: string;
  /** the generic sentence: a lost answer, a 5xx, a code the page does not know */
  error: string;
  gone: string;
  tooMany: string;
  problems: Record<VisitorProblemCode, string>;
}

export const INTEREST_COPY: Record<InterestLocale, InterestCopy> = {
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
    done: "Thank you — we have noted your interest in",
    doneBy: "will be in touch.",
    error: "We could not record your interest. Please try again.",
    gone: "This link is no longer available. Please contact your agent.",
    tooMany: "Too many requests from this connection. Please try again in a few minutes.",
    problems: {
      name_required: "Please enter your name.",
      name_too_long: "Your name is too long (200 characters at most).",
      name_line_break: "Please write your name on one line.",
      email_invalid: "That email address does not look right — please check it.",
      email_too_long: "That email address is too long (320 characters at most).",
      phone_too_long: "That phone number is too long (40 characters at most).",
      phone_line_break: "Please write the phone number on one line.",
      message_too_long: "Your message is too long (5000 characters at most).",
      contact_required: "Please give an email address or a phone number.",
    },
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
    done: "Ευχαριστούμε — καταγράψαμε το ενδιαφέρον σας για το",
    doneBy: "θα επικοινωνήσει μαζί σας.",
    error: "Δεν ήταν δυνατή η καταγραφή του ενδιαφέροντός σας. Δοκιμάστε ξανά.",
    gone: "Ο σύνδεσμος δεν είναι πλέον διαθέσιμος. Επικοινωνήστε με τον σύμβουλό σας.",
    tooMany: "Πάρα πολλά αιτήματα από αυτή τη σύνδεση. Δοκιμάστε ξανά σε λίγα λεπτά.",
    problems: {
      name_required: "Παρακαλούμε γράψτε το όνομά σας.",
      name_too_long: "Το όνομα είναι πολύ μεγάλο (έως 200 χαρακτήρες).",
      name_line_break: "Παρακαλούμε γράψτε το όνομά σας σε μία γραμμή.",
      email_invalid: "Η διεύθυνση email δεν φαίνεται σωστή — παρακαλούμε ελέγξτε την.",
      email_too_long: "Η διεύθυνση email είναι πολύ μεγάλη (έως 320 χαρακτήρες).",
      phone_too_long: "Ο αριθμός τηλεφώνου είναι πολύ μεγάλος (έως 40 χαρακτήρες).",
      phone_line_break: "Παρακαλούμε γράψτε τον αριθμό τηλεφώνου σε μία γραμμή.",
      message_too_long: "Το μήνυμά σας είναι πολύ μεγάλο (έως 5000 χαρακτήρες).",
      contact_required: "Δώστε μια διεύθυνση email ή έναν αριθμό τηλεφώνου.",
    },
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
    done: "Спасибо — мы отметили ваш интерес к объекту",
    doneBy: "свяжется с вами.",
    error: "Не удалось сохранить ваш запрос. Попробуйте ещё раз.",
    gone: "Эта ссылка больше недоступна. Обратитесь к вашему агенту.",
    tooMany: "Слишком много запросов с этого подключения. Попробуйте через несколько минут.",
    problems: {
      name_required: "Пожалуйста, укажите ваше имя.",
      name_too_long: "Имя слишком длинное (не более 200 символов).",
      name_line_break: "Пожалуйста, укажите ваше имя в одну строку.",
      email_invalid: "Адрес эл. почты выглядит неверно — проверьте его, пожалуйста.",
      email_too_long: "Адрес эл. почты слишком длинный (не более 320 символов).",
      phone_too_long: "Номер телефона слишком длинный (не более 40 символов).",
      phone_line_break: "Пожалуйста, укажите номер телефона в одну строку.",
      message_too_long: "Сообщение слишком длинное (не более 5000 символов).",
      contact_required: "Укажите адрес эл. почты или номер телефона.",
    },
  },
};

const isVisitorCode = (code: unknown): code is VisitorProblemCode =>
  typeof code === "string" && (VISITOR_PROBLEM_CODES as ReadonlyArray<string>).includes(code);

/** The sentence for a code in a locale; the locale's generic sentence for any code the page does not know. */
export function interestProblemText(locale: InterestLocale, code: unknown): string {
  const t = INTEREST_COPY[locale];
  return isVisitorCode(code) ? t.problems[code] : t.error;
}
