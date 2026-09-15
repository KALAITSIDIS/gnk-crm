import { briefChips } from "@/lib/services/enquiry-meta";

/**
 * A lead's message, whole, and its brief as chips (0098, audit LR-03).
 *
 * The inbox rendered `message` with a single-line `truncate`, and there is
 * no lead detail page, so a seller's ten-line brief or a buyer's budget block
 * was readable only in the alert e-mail — the desk was asked to work a lead
 * it could not read where it works it. The first line stays as the row's
 * one-line summary (for a website lead that is "Website enquiry"); the rest
 * opens in place. A <details> needs no JavaScript, so this renders on the
 * server and works before hydration, like the rest of the row.
 *
 * The chips are `briefChips(criteria)` — the structured answers 0098 puts in
 * `criteria` (budget band, area, timing, campaign), never the message.
 */
export function LeadMessage({
  message,
  criteria,
}: {
  message: string | null;
  criteria: unknown;
}) {
  const chips = briefChips(criteria);
  const text = message?.trim() ?? "";
  if (!text && chips.length === 0) return null;

  const nl = text.indexOf("\n");
  const first = nl === -1 ? text : text.slice(0, nl);
  const rest = nl === -1 ? "" : text.slice(nl + 1).trim();

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {chips.length > 0 ? (
        <ul className="flex flex-wrap gap-1" aria-label="Brief">
          {chips.map((c) => (
            <li key={c} className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-2">
              {c}
            </li>
          ))}
        </ul>
      ) : null}
      {text ? (
        rest ? (
          <details className="group min-w-0 text-sm text-text-2">
            <summary className="cursor-pointer list-none truncate [&::-webkit-details-marker]:hidden">
              {first}
              <span className="ml-1 text-xs text-text-3 group-open:hidden">· more</span>
            </summary>
            <p className="mt-1 whitespace-pre-line break-words">{rest}</p>
          </details>
        ) : (
          <p className="truncate text-sm text-text-2">{first}</p>
        )
      ) : null}
    </div>
  );
}
