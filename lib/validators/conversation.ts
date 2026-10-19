import { z } from "zod";

/**
 * What the desk says happened in a logged conversation (A06-b, migration 0155):
 * the "What happened" choice on the three Log-conversation dialogs — the
 * inbox's Log, a contact's Log contact, a deal's Log contact.
 *
 * It is the agent's own claim, made deliberately in a dialog. Nothing is
 * synchronised from WhatsApp, e-mail or anything else (no messaging API —
 * Do-Not-Build), and a chat-link click never sets it: a click is "link click
 * only" (A06-a). The same three words are the CHECK on
 * `interaction_notes.outcome` and `log_conversation(p_outcome)`'s own test.
 *
 * Every outcome is still a logged conversation: the clock rules do not look
 * at it (a lead's first_response_at, a deal's last_contact_at) — a message the
 * agent says they sent IS the agency's response.
 */
export const CONVERSATION_OUTCOMES = ["spoke", "message_sent", "client_replied"] as const;
export type ConversationOutcome = (typeof CONVERSATION_OUTCOMES)[number];

/** The dialogs' default — the claim every conversation logged before 0155 made. */
export const DEFAULT_CONVERSATION_OUTCOME: ConversationOutcome = "spoke";

/**
 * The form field. Optional: a form that does not post it (a page rendered
 * before the field existed) logs the conversation with no outcome, stored as
 * NULL — "not said" — exactly as before 0155. Anything else posted is refused,
 * never coerced to a default.
 */
export const conversationOutcomeField = z.preprocess(
  (v) => (v === "" || v === null ? undefined : v),
  z.enum(CONVERSATION_OUTCOMES, { message: "Choose what happened" }).optional(),
);
