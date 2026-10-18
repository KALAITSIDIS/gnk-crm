import {
  CONVERSATION_OUTCOMES,
  DEFAULT_CONVERSATION_OUTCOME,
  type ConversationOutcome,
} from "@/lib/validators/conversation";

const OUTCOME_LABELS: Record<ConversationOutcome, string> = {
  spoke: "Spoke",
  message_sent: "Message sent, no reply yet",
  client_replied: "Client replied",
};

/**
 * "What happened" on the three Log-conversation dialogs (A06-b, 0155): the
 * inbox's Log, a contact's Log contact and a deal's Log contact. Native radios
 * in a fieldset, so the choice posts with the form whatever the dialog does,
 * and a screen reader announces the group by its legend.
 *
 * "Spoke" is preselected — the claim every conversation logged before this
 * field made. Whatever is chosen is the agent's own claim; nothing reads a
 * messaging app (Do-Not-Build), and a WhatsApp or Telegram button click is
 * never one of these (it is "link click only").
 *
 * The module chrome is English by convention; the timeline lines these
 * produce come from `events.*` in en, el and ru.
 */
export function ConversationOutcomeField({ idPrefix }: { idPrefix: string }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium text-text-1">What happened</legend>
      {CONVERSATION_OUTCOMES.map((outcome) => (
        <label key={outcome} htmlFor={`${idPrefix}-${outcome}`} className="flex items-start gap-2 text-sm text-text-1">
          <input
            type="radio"
            id={`${idPrefix}-${outcome}`}
            name="outcome"
            value={outcome}
            defaultChecked={outcome === DEFAULT_CONVERSATION_OUTCOME}
            className="mt-1 accent-primary"
          />
          <span>{OUTCOME_LABELS[outcome]}</span>
        </label>
      ))}
    </fieldset>
  );
}
