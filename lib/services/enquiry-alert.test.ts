import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/nextjs";
import { bodyFor, sendEnquiryAlert } from "./enquiry-alert";

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));

const base = {
  name: "A Buyer",
  email: "buyer@example.com",
  phone: "+357 99 123456",
  message: "Is the Coral Bay villa still available?",
  propertyReference: "PAF0001",
};

describe("what the desk actually receives", () => {
  it("leads with the person and both ways to reach them", () => {
    const body = bodyFor(base);
    expect(body).toContain("A Buyer enquired through the website.");
    expect(body).toContain("buyer@example.com");
    expect(body).toContain("+357 99 123456");
    expect(body).toContain("PAF0001");
    expect(body).toContain("Is the Coral Bay villa still available?");
  });

  it("says so when there is no message, rather than showing a gap", () => {
    expect(bodyFor({ ...base, message: null })).toContain("(no message)");
  });

  it("omits a contact line that does not exist", () => {
    const body = bodyFor({ ...base, phone: null });
    expect(body).not.toContain("Phone:");
    expect(body).toContain("Email:");
  });

  it("carries the link into the inbox, because the clock is the point", () => {
    const body = bodyFor(base);
    expect(body).toMatch(/\/leads/);
    expect(body).toContain("green under five minutes");
  });

  it("says where the enquiry came from when the site told us (0098, LR-02)", () => {
    const body = bodyFor({
      ...base,
      meta: { source_page: "/properties/PAF0001", utm_source: "instagram", utm_campaign: "spring-villas" },
    });
    expect(body).toContain("From:   /properties/PAF0001 · instagram · spring-villas");
  });

  it("omits the From line when there is nothing to say", () => {
    expect(bodyFor({ ...base, meta: null })).not.toContain("From:");
    expect(bodyFor({ ...base, meta: { consent_version: "2026-09-15" } })).not.toContain("From:");
  });
});

describe("arming", () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    process.env = { ...OLD };
  });

  it("SKIPS without configuration, and never throws — the enquiry is already saved", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.ENQUIRY_ALERT_TO;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(sendEnquiryAlert(base)).resolves.toBe("skipped");
    expect(warn.mock.calls[0]?.[0]).toContain("SKIPPED");
  });

  it("skips when only half of it is configured", async () => {
    process.env.RESEND_API_KEY = "re_test";
    delete process.env.ENQUIRY_ALERT_TO;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(sendEnquiryAlert(base)).resolves.toBe("skipped");
  });

  it("sends once configured, replying to the buyer rather than to nobody", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.ENQUIRY_ALERT_TO = "info@kalaitsidis.com";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(sendEnquiryAlert(base)).resolves.toBe("sent");

    const [, init] = fetchMock.mock.calls[0]!;
    const sent = JSON.parse(String(init!.body));
    expect(sent.to).toEqual(["info@kalaitsidis.com"]);
    expect(sent.reply_to, "a reply from a phone must reach the buyer").toBe("buyer@example.com");
    expect(sent.subject).toBe("Website enquiry from A Buyer — PAF0001");
  });

  it("takes more than one recipient", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.ENQUIRY_ALERT_TO = "one@example.com, two@example.com";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await sendEnquiryAlert(base);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(sent.to).toEqual(["one@example.com", "two@example.com"]);
  });

  it("REPORTS a provider failure without throwing it", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.ENQUIRY_ALERT_TO = "info@kalaitsidis.com";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 422 }));
    await expect(sendEnquiryAlert(base)).resolves.toBe("failed");
  });

  it("tells Sentry when a send fails, without the person (LR-07)", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.ENQUIRY_ALERT_TO = "info@kalaitsidis.com";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 403 }));
    vi.mocked(Sentry.captureMessage).mockClear();
    await expect(sendEnquiryAlert(base)).resolves.toBe("failed");
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [msg, ctx] = vi.mocked(Sentry.captureMessage).mock.calls[0]!;
    expect(String(msg)).toContain("enquiry-alert");
    const context = JSON.stringify(ctx);
    expect(context).toContain("403");
    expect(context).not.toContain("buyer@example.com");
    expect(context).not.toContain("A Buyer");
  });

  it("survives the network being gone — the enquiry must still stand", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.ENQUIRY_ALERT_TO = "info@kalaitsidis.com";
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    await expect(sendEnquiryAlert(base)).resolves.toBe("failed");
  });

  it("gives up on a provider that accepts the connection and never answers (INT-01)", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.ENQUIRY_ALERT_TO = "info@kalaitsidis.com";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // A fetch that honours its signal, as the real one does: it settles only
    // when aborted, or after 200 ms — whichever the timeout makes happen first.
    // A fetch with no signal at all is the defect, and fails here outright.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return reject(new Error("no signal was passed to fetch"));
          signal.addEventListener("abort", () => reject(signal.reason));
          setTimeout(() => resolve(new Response("{}", { status: 200 })), 200);
        }),
    );
    await expect(sendEnquiryAlert(base, { timeoutMs: 20 })).resolves.toBe("failed");
    const reported = String(error.mock.calls[0]?.[1] ?? error.mock.calls[0]?.[0]);
    expect(reported).toMatch(/timeout|abort/i);
  });
});
