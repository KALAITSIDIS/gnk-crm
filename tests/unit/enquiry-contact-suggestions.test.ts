import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// the dialog's hooks and action, outside a Next app: rendering must not need either
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
const linkLeadContact = vi.hoisted(() => vi.fn());
vi.mock("@/lib/actions/leads", () => ({ linkLeadContact }));

const { EnquiryContactSuggestions } = await import("@/components/features/leads/enquiry-contact-suggestions");
type State = Parameters<typeof EnquiryContactSuggestions>[0]["state"];

/**
 * The "Possible existing contact" panel on an inbox row
 * (T-enquiry-contact-suggestions), rendered the way the server renders it.
 *
 * Every state must SAY something — an empty space would read as "no match"
 * when the lookup failed — and rendering must never call the link action.
 * The phone-layout, recovery and dedup e2e specs find rows and buttons by
 * name, so the panel must not render a button called Close, Log, Less or
 * More…, nor any dialog content until someone opens it.
 */
const keys = { email: "maria@example.invalid", phoneE164: "+35799123456" };
const history = [
  { id: "l1", received_at: "2026-09-20T09:00:00Z", status: "contacted", assigned_agent_id: "agent-1", property: { id: "p1", reference: "PAF0003" } },
  { id: "l2", received_at: "2026-08-02T09:00:00Z", status: "converted", assigned_agent_id: null, property: null },
];
const one = (over: Partial<Extract<State, { status: "matches" }>> = {}): State => ({
  status: "matches",
  keys,
  candidates: [
    {
      contact: { id: "c-1", name: "Maria Georgiou" },
      evidence: { email: true, phone: "primary" },
      matchedOn: "email_and_phone",
      history,
      moreHistory: false,
    },
  ],
  moreCandidates: false,
  split: null,
  ...over,
});

/** the markup with React's entity escapes undone, so assertions read like the page */
const render = (state: State, canLink = true) =>
  renderToStaticMarkup(
    createElement(EnquiryContactSuggestions, {
      leadId: "lead-1",
      state,
      canLink,
      agentLabels: { "agent-1": "Nikos Agent" },
    }),
  )
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

const buttonNames = (html: string) =>
  [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, "").trim());

describe("EnquiryContactSuggestions", () => {
  it("names the candidate, the reason, and the earlier linked enquiries — before anyone clicks anything", () => {
    const html = render(one());
    expect(html).toContain("Possible existing contact");
    expect(html).toMatch(/href="\/contacts\/c-1"[^>]*>Maria Georgiou</);
    expect(html).toContain("Same e-mail and phone");
    expect(html).toContain("2 recent enquiries · latest 20 Sept 2026");
    // folded in a native disclosure: readable before hydration, compact on a phone
    expect(html).toMatch(/<details[^>]*><summary/);
    expect(html).toContain("20 Sept 2026");
    expect(html).toMatch(/href="\/properties\/p1"[^>]*>PAF0003</);
    expect(html).toContain("Contacted");
    expect(html).toContain("Nikos Agent");
    expect(html).toContain("No listing");
    expect(html).toContain("Unassigned");
    expect(html).toContain("Converted");
  });

  it("offers Review and link only to someone who may link — and renders no dialog content until it is opened", () => {
    const html = render(one());
    expect(buttonNames(html)).toEqual(["Review and link"]);
    expect(html).not.toContain("Link to Maria Georgiou");
    expect(html).not.toContain('role="dialog"');
    expect(buttonNames(render(one(), false))).toEqual([]);
    expect(linkLeadContact).not.toHaveBeenCalled();
  });

  it("renders no button the inbox specs find by name", () => {
    const names = buttonNames(render(one()));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).not.toMatch(/^(Close|Log|Less)$|More…/);
  });

  it("lists both contacts and names the split when the e-mail and the phone point at different people", () => {
    const html = render({
      status: "matches",
      keys,
      candidates: [
        { contact: { id: "c-b", name: "Maria Papa" }, evidence: { email: true, phone: null }, matchedOn: "email", history: [], moreHistory: false },
        { contact: { id: "c-a", name: "Maria Georgiou" }, evidence: { email: false, phone: "primary" }, matchedOn: "phone", history: [], moreHistory: false },
      ],
      moreCandidates: false,
      split: { emailMatches: ["Maria Papa"], phoneMatches: ["Maria Georgiou"] },
    });
    expect(html).toContain("2 possible existing contacts");
    expect(html).toContain("The e-mail matches Maria Papa, but the phone matches Maria Georgiou.");
    expect(buttonNames(html)).toEqual(["Review and link", "Review and link"]);
    expect(html).toContain("No enquiries are linked to this contact yet.");
    // two buttons, each naming its contact for a screen reader
    expect(html).toContain('aria-label="Review and link Maria Papa"');
    expect(html).toContain('aria-label="Review and link Maria Georgiou"');
  });

  it("says when only the most recent enquiries are shown", () => {
    const base = one();
    if (base.status !== "matches") throw new Error("unreachable");
    const html = render({ ...base, candidates: [{ ...base.candidates[0]!, moreHistory: true }] });
    expect(html).toContain("Showing the 3 most recent only.");
    expect(html).toContain("2+ recent enquiries");
  });

  it.each([
    [{ status: "no_match", keys } as State, "No active contact has this enquiry's e-mail or phone.", "text-text-3"],
    [{ status: "unavailable" } as State, "Could not check for an existing contact — refresh to try again.", "text-warning"],
    [{ status: "no_identifiers" } as State, "No usable e-mail or phone in this enquiry to match against contacts.", "text-text-3"],
    [{ status: "unreadable" } as State, "This enquiry's details could not be read — link the contact by hand.", "text-text-3"],
  ])("says what happened when there is no candidate: %#", (state, text, tone) => {
    const html = render(state);
    expect(html).toContain(text);
    expect(html).toContain(tone);
    expect(buttonNames(html)).toEqual([]);
  });
});
