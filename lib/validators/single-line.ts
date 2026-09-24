/**
 * One line, for a value the enquiry doors write onto ONE line of the header
 * block in `leads.message` (T-enquiry-identity-single-line, migration 0114).
 *
 * The block is how every consumer learns who the enquirer is — the desk
 * alert's Reply-To, "Possible existing contact", "Create contact", the
 * escalation (lib/services/lead-contact.ts reads it). A line break inside a
 * name, e-mail, phone or typed reference wrote a SECOND header line: another
 * label the reader took for the real one, or a blank that ended the header
 * early and hid the lines after it. So those values are refused with a line
 * break in them, at the route and in the database; the message, which is
 * written below the header, stays multiline.
 *
 * "A line break" is Unicode's MANDATORY breaks (UAX #14 classes BK, CR, LF
 * and NL): LF, VT, FF, CR, NEL, LINE SEPARATOR, PARAGRAPH SEPARATOR. Not only
 * the two a keyboard makes — U+2028 starts a new line in the inbox and in an
 * e-mail just as a newline does, and no name or number contains any of them.
 * Tabs and no-break spaces are not breaks and stay allowed.
 *
 * THE DATABASE HOLDS THE SAME SET: 0114's `v_breaks` in both functions, built
 * from chr() of these code points. supabase/tests/enquiry-single-line.test.ts
 * sends every one of them to both functions — change the two together.
 */
export const LINE_BREAK_CODE_POINTS = [0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029] as const;

const BREAKS: ReadonlySet<number> = new Set(LINE_BREAK_CODE_POINTS);

export function hasLineBreak(value: string): boolean {
  for (const ch of value) {
    if (BREAKS.has(ch.codePointAt(0)!)) return true;
  }
  return false;
}

/**
 * The zod refinement both doors' schemas spread into `.refine(...)`, right
 * after `.trim()`: JavaScript's trim removes a break at either END like a
 * space — every one of these but NEL, which it does not count as whitespace,
 * so a NEL is refused wherever it sits (as the database refuses it) — and an
 * EMBEDDED break is refused. Placed before the caps, so a long value with a
 * break is told about the break. `reason` lets a caller that maps issues to
 * codes (the proposal door) tell this apart from "required" without reading
 * the sentence.
 */
export const oneLine = (message: string) =>
  [(v: string) => !hasLineBreak(v), { message, params: { reason: "line_break" } }] as const;
