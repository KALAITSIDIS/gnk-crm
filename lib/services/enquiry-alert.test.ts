import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bodyFor, classifyProviderFailure, sendEnquiryAlert } from "./enquiry-alert";

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

/**
 * 0101: the sender answers in the outbox's vocabulary. It still never throws
 * and never sends twice on its own — but the WORD it returns now decides
 * whether the worker retries, gives up, or waits for a human, so each class
 * of answer is pinned.
 */
describe("what a provider answer means", () => {
  it("a server error, a rate limit, a timeout-class status and a concurrent-key clash are worth another try", () => {
    expect(classifyProviderFailure(500, "application_error")).toEqual({ category: "transient", result: "application_error" });
    expect(classifyProviderFailure(503, "service_unavailable")).toEqual({ category: "transient", result: "service_unavailable" });
    expect(classifyProviderFailure(429, "rate_limit_exceeded")).toEqual({ category: "transient", result: "rate_limit_exceeded" });
    expect(classifyProviderFailure(408, null)).toEqual({ category: "transient", result: "408" });
    expect(classifyProviderFailure(409, "concurrent_idempotent_requests")).toEqual({
      category: "transient",
      result: "concurrent_idempotent_requests",
    });
  });

  it("a validation, key or permission refusal will not change on its own", () => {
    expect(classifyProviderFailure(422, "validation_error")).toEqual({ category: "permanent", result: "validation_error" });
    expect(classifyProviderFailure(401, "missing_api_key")).toEqual({ category: "permanent", result: "missing_api_key" });
    expect(classifyProviderFailure(403, "validation_error")).toEqual({ category: "permanent", result: "validation_error" });
    expect(classifyProviderFailure(400, null)).toEqual({ category: "permanent", result: "400" });
  });

  it("a key reused with a different payload is a conflict — the key is burnt, not the enquiry", () => {
    expect(classifyProviderFailure(409, "invalid_idempotent_request")).toEqual({
      category: "conflict",
      result: "invalid_idempotent_request",
    });
  });

  it("never lets a provider's words grow past what the row may hold", () => {
    expect(classifyProviderFailure(500, "x".repeat(300)).result).toHaveLength(80);
  });
});

describe("arming and sending", () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.RESEND_API_KEY = "re_test";
    process.env.ENQUIRY_ALERT_TO = "info@kalaitsidis.com";
  });
  afterEach(() => {
    process.env = { ...OLD };
  });

  it("SKIPS without configuration, and never throws — the enquiry is already saved", async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.ENQUIRY_ALERT_TO;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(sendEnquiryAlert(base)).resolves.toEqual({ outcome: "skipped" });
    expect(warn.mock.calls[0]?.[0]).toContain("SKIPPED");
  });

  it("skips when only half of it is configured", async () => {
    delete process.env.ENQUIRY_ALERT_TO;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(sendEnquiryAlert(base)).resolves.toEqual({ outcome: "skipped" });
  });

  it("sends once configured, replying to the buyer, and hands back the provider's id", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "re_abc123" }), { status: 200 }));

    await expect(sendEnquiryAlert(base)).resolves.toEqual({ outcome: "accepted", providerMessageId: "re_abc123" });

    const [, init] = fetchMock.mock.calls[0]!;
    const sent = JSON.parse(String(init!.body));
    expect(sent.to).toEqual(["info@kalaitsidis.com"]);
    expect(sent.reply_to, "a reply from a phone must reach the buyer").toBe("buyer@example.com");
    expect(sent.subject).toBe("Website enquiry from A Buyer — PAF0001");
  });

  it("accepts without an id when the provider's body is not what we expect", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
    await expect(sendEnquiryAlert(base)).resolves.toEqual({ outcome: "accepted", providerMessageId: null });
  });

  it("sends the idempotency key it was given, and none when it was not", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
    await sendEnquiryAlert(base, { idempotencyKey: "enquiry-desk-alert/job-1/1" });
    const headers = new Headers(fetchMock.mock.calls[0]![1]!.headers as HeadersInit);
    expect(headers.get("Idempotency-Key")).toBe("enquiry-desk-alert/job-1/1");

    await sendEnquiryAlert(base);
    const bare = new Headers(fetchMock.mock.calls[1]![1]!.headers as HeadersInit);
    expect(bare.get("Idempotency-Key")).toBeNull();
  });

  it("takes more than one recipient", async () => {
    process.env.ENQUIRY_ALERT_TO = "one@example.com, two@example.com";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await sendEnquiryAlert(base);
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(sent.to).toEqual(["one@example.com", "two@example.com"]);
  });

  it("reports a provider refusal as a permanent failure, by the provider's error NAME, without throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ statusCode: 422, name: "validation_error", message: "bad" }), { status: 422 }),
    );
    await expect(sendEnquiryAlert(base)).resolves.toEqual({
      outcome: "failed",
      category: "permanent",
      result: "validation_error",
      retryAfterSeconds: null,
    });
  });

  it("reports a rate limit as transient and carries Retry-After through", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ name: "rate_limit_exceeded" }), { status: 429, headers: { "retry-after": "30" } }),
    );
    await expect(sendEnquiryAlert(base)).resolves.toEqual({
      outcome: "failed",
      category: "transient",
      result: "rate_limit_exceeded",
      retryAfterSeconds: 30,
    });
  });

  it("never logs the provider's body, which can echo the address", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ name: "validation_error", message: "buyer@example.com is not allowed" }), {
        status: 403,
      }),
    );
    await sendEnquiryAlert(base);
    expect(JSON.stringify(error.mock.calls)).not.toContain("buyer@example.com");
    expect(JSON.stringify(error.mock.calls)).toContain("403");
  });

  it("survives the network being gone — transient, and the enquiry still stands", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(sendEnquiryAlert(base)).resolves.toEqual({
      outcome: "failed",
      category: "transient",
      result: "network",
      retryAfterSeconds: null,
    });
  });

  it("gives up on a provider that accepts the connection and never answers, and says the answer is unknown (INT-01)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
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
    await expect(sendEnquiryAlert(base, { timeoutMs: 20 })).resolves.toEqual({
      outcome: "failed",
      category: "timeout",
      result: "timeout",
      retryAfterSeconds: null,
    });
  });
});
