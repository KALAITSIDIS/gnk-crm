import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/nextjs";
import { ackBodyFor, ackSubjectFor, DESK_HOURS, sendEnquiryAck } from "./enquiry-ack";

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));

/**
 * The visitor's acknowledgement (0098, audit LR-06): until now a buyer who
 * filled in a brief at 22:00 got a thank-you panel and nothing else — no
 * confirmation, no reply window, no way to notice a mistyped address.
 */
const base = {
  name: "Maria Georgiou",
  email: "maria@example.com",
  propertyReference: "PAF0001",
  orgName: "GN Kalaitsidis Capital",
};

describe("what the enquirer reads", () => {
  it("names the listing, promises a personal reply and states the desk hours", () => {
    const body = ackBodyFor(base);
    expect(body).toContain("Maria");
    expect(body).toContain("PAF0001");
    expect(body).toMatch(/one of us will reply personally/i);
    expect(body).toContain(DESK_HOURS);
    expect(body).toContain("GN Kalaitsidis Capital");
  });

  it("uses the first name only, and copes with a single-word name", () => {
    expect(ackBodyFor({ ...base, name: "Igor" })).toMatch(/^Thank you, Igor\./);
    expect(ackBodyFor(base)).toMatch(/^Thank you, Maria\./);
  });

  it("says 'your enquiry' when no listing was named", () => {
    const body = ackBodyFor({ ...base, propertyReference: null });
    expect(body).not.toContain("about");
    expect(body).toMatch(/your enquiry has reached us/i);
  });

  it("carries no marketing and no tracking", () => {
    const body = ackBodyFor(base);
    expect(body).not.toMatch(/unsubscribe|newsletter|http/i);
  });

  it("subject names the listing and the firm", () => {
    expect(ackSubjectFor(base)).toBe("Your enquiry about PAF0001 — GN Kalaitsidis Capital");
    expect(ackSubjectFor({ ...base, propertyReference: null })).toBe(
      "Your enquiry — GN Kalaitsidis Capital",
    );
  });
});

describe("arming — never from the onboarding sender, never without an address", () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(Sentry.captureMessage).mockClear();
    process.env.RESEND_API_KEY = "re_test";
    process.env.ENQUIRY_ALERT_TO = "info@kalaitsidis.com, gn@kalaitsidis.com";
    process.env.ENQUIRY_ALERT_FROM = "GN Kalaitsidis Capital <hello@send.kalaitsidis.com>";
  });
  afterEach(() => {
    process.env = { ...OLD };
  });

  it("skips without a provider key", async () => {
    delete process.env.RESEND_API_KEY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(sendEnquiryAck(base)).resolves.toBe("skipped");
    expect(warn.mock.calls[0]?.[0]).toContain("SKIPPED");
  });

  it("skips without a real sending address — a client is never written to from onboarding@resend.dev", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.ENQUIRY_ALERT_FROM;
    await expect(sendEnquiryAck(base)).resolves.toBe("skipped");
    process.env.ENQUIRY_ALERT_FROM = "GNK website <onboarding@resend.dev>";
    await expect(sendEnquiryAck(base)).resolves.toBe("skipped");
  });

  it("skips when the enquirer gave no e-mail", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(sendEnquiryAck({ ...base, email: null })).resolves.toBe("skipped");
  });

  it("sends to the enquirer, from the desk's address, replying to the desk", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(sendEnquiryAck(base)).resolves.toBe("sent");
    const [, init] = fetchMock.mock.calls[0]!;
    const sent = JSON.parse(String(init!.body));
    expect(sent.to).toEqual(["maria@example.com"]);
    expect(sent.from).toBe("GN Kalaitsidis Capital <hello@send.kalaitsidis.com>");
    expect(sent.reply_to, "a reply goes to the desk's first address").toBe("info@kalaitsidis.com");
    expect(sent.subject).toBe("Your enquiry about PAF0001 — GN Kalaitsidis Capital");
    expect(init!.signal, "a stuck provider cannot hold the function").toBeDefined();
  });

  it("reports a provider failure without throwing, and tells Sentry without the person", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 403 }));
    await expect(sendEnquiryAck(base)).resolves.toBe("failed");
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const context = JSON.stringify(vi.mocked(Sentry.captureMessage).mock.calls[0]![1]);
    expect(context).toContain("403");
    expect(context).not.toContain("maria@example.com");
    expect(context).not.toContain("Maria");
  });

  it("survives the network being gone", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    await expect(sendEnquiryAck(base)).resolves.toBe("failed");
  });
});
