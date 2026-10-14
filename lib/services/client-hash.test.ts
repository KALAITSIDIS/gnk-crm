import { afterEach, describe, expect, it, vi } from "vitest";
import { extractSha256Hex, sha256Hex } from "./hash";
import {
  VERIFY_HASH_FAILED_TEXT,
  VERIFY_NO_ANSWER_TEXT,
  sha256HexInBrowser,
  verifyInBrowser,
  verifyRequestBody,
} from "./client-hash";
import type { VerifyReportState } from "@/lib/actions/reports";

/**
 * The verify-a-report form hashes the chosen PDF in the browser and posts ONLY
 * the digest (T-upload-size-honest): a report PDF over ~4.5 MB used to die at
 * the platform 413 before `verifyEvidenceReport` ran. The digest must be
 * exactly what the action's digest path matches against the
 * evidence_report_generated payloads — lowercase hex, 64 characters, the
 * format `sha256Hex` writes and `extractSha256Hex` returns.
 */
const pdf = (text: string, name = "evidence.pdf") =>
  new File([new TextEncoder().encode(text)], name, { type: "application/pdf" });

describe("sha256HexInBrowser (Web Crypto)", () => {
  it("matches the known SHA-256 vectors", async () => {
    expect(await sha256HexInBrowser(new Blob([]))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256HexInBrowser(new Blob(["abc"]))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is byte-for-byte the server's sha256Hex, and passes the action's own digest parser unchanged", async () => {
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 31 + 7) % 256);
    const hex = await sha256HexInBrowser(new Blob([bytes]));
    expect(hex).toBe(sha256Hex(bytes));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(extractSha256Hex(hex)).toBe(hex);
  });

  it("hashes a PDF far past the old 20 MB cap — the digest path has no size limit", async () => {
    const big = new Uint8Array(25 * 1024 * 1024).fill(0x25);
    expect(await sha256HexInBrowser(new Blob([big]))).toBe(sha256Hex(big));
  });

  describe("without Web Crypto", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("says so instead of sending the file", async () => {
      vi.stubGlobal("crypto", undefined);
      await expect(sha256HexInBrowser(new Blob(["abc"]))).rejects.toThrow(/browser/i);
    });
  });
});

describe("verifyRequestBody — what the verify form sends", () => {
  it("a chosen PDF becomes its digest, and the file itself is NOT in the body", async () => {
    const file = pdf("%PDF-1.4 report body");
    const form = new FormData();
    form.set("file", file);
    form.set("sha256", "");
    const body = await verifyRequestBody(form);
    expect([...body.keys()]).toEqual(["sha256"]);
    expect(body.get("sha256")).toBe(sha256Hex(new Uint8Array(await file.arrayBuffer())));
  });

  it("a chosen PDF wins over a pasted digest — the action's own precedence", async () => {
    const file = pdf("%PDF-1.4 another");
    const form = new FormData();
    form.set("file", file);
    form.set("sha256", "a".repeat(64));
    const body = await verifyRequestBody(form);
    expect(body.get("sha256")).toBe(sha256Hex(new Uint8Array(await file.arrayBuffer())));
    expect(body.has("file")).toBe(false);
  });

  it("with no file chosen, a pasted digest is passed through as typed — the action parses loose paste", async () => {
    const pasted = `  Report SHA-256: ${"AB".repeat(32)} (footer)  `;
    const form = new FormData();
    form.set("file", new File([], "", { type: "application/octet-stream" })); // an empty file input
    form.set("sha256", pasted);
    const body = await verifyRequestBody(form);
    expect([...body.keys()]).toEqual(["sha256"]);
    expect(body.get("sha256")).toBe(pasted);
  });

  it("with neither, the body is empty and the action answers in its own words (noInput)", async () => {
    const body = await verifyRequestBody(new FormData());
    expect([...body.keys()]).toEqual([]);
  });
});

/**
 * The verify form's action, run in the browser (verify-report.tsx passes it to
 * useActionState with the real server action as `verify`). Every way it can
 * end is an answer on the form — a throw here would land on the route's error
 * boundary, which is what the form was changed to stop.
 */
describe("verifyInBrowser — the verify form's action", () => {
  const initial: VerifyReportState = { error: null, result: null };
  const matched: VerifyReportState = {
    error: null,
    result: { matched: true, sha256: "x", generatedAt: "2026-10-01T09:00:00Z", reportHash: null, rows: 3 },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the server action receives only the digest — never the PDF — and its answer is shown as given", async () => {
    const file = pdf("%PDF-1.4 the report");
    const form = new FormData();
    form.set("file", file);
    form.set("sha256", "");
    const verify = vi.fn<(prev: VerifyReportState, body: FormData) => Promise<VerifyReportState>>(async () => matched);
    expect(await verifyInBrowser(initial, form, { verify })).toBe(matched);
    expect(verify).toHaveBeenCalledTimes(1);
    const [prev, body] = verify.mock.calls[0]!;
    expect(prev).toBe(initial);
    expect([...body.keys()]).toEqual(["sha256"]);
    expect(body.get("sha256")).toBe(sha256Hex(new Uint8Array(await file.arrayBuffer())));
  });

  it("a server action that REJECTS is an answer on the form, not a throw — and it is reported", async () => {
    const lost = new Error("An unexpected response was received from the server.");
    const onRejected = vi.fn();
    const form = new FormData();
    form.set("sha256", "a".repeat(64));
    const state = await verifyInBrowser(initial, form, {
      verify: async () => {
        throw lost;
      },
      onRejected,
    });
    expect(state).toEqual({ error: VERIFY_NO_ANSWER_TEXT, result: null });
    expect(onRejected).toHaveBeenCalledWith(lost);
  });

  it("a rejection says to RELOAD — an expired session or a stale deploy fails the same way on every retry", () => {
    // 'Not authenticated' from getCurrentProfile, or Next's
    // UnrecognizedActionError after a deploy: a plain "try again" loops
    expect(VERIFY_NO_ANSWER_TEXT).toMatch(/reload the page/i);
    expect(VERIFY_NO_ANSWER_TEXT).toMatch(/nothing was changed/i);
  });

  it("a reporter that throws does not make the action throw", async () => {
    const form = new FormData();
    form.set("sha256", "a".repeat(64));
    const state = await verifyInBrowser(initial, form, {
      verify: async () => {
        throw new Error("lost");
      },
      onRejected: () => {
        throw new Error("reporter down");
      },
    });
    expect(state).toEqual({ error: VERIFY_NO_ANSWER_TEXT, result: null });
  });

  it("a PDF this browser cannot hash is an answer that says to paste the digest — nothing is sent", async () => {
    vi.stubGlobal("crypto", undefined);
    const form = new FormData();
    form.set("file", pdf("%PDF-1.4 the report"));
    const verify = vi.fn(async () => matched);
    const onRejected = vi.fn();
    expect(await verifyInBrowser(initial, form, { verify, onRejected })).toEqual({
      error: VERIFY_HASH_FAILED_TEXT,
      result: null,
    });
    expect(VERIFY_HASH_FAILED_TEXT).toMatch(/paste/i);
    expect(verify).not.toHaveBeenCalled();
    // a local limitation, not a lost request: not reported
    expect(onRejected).not.toHaveBeenCalled();
  });
});
