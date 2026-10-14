import { describe, expect, it } from "vitest";
import {
  BRANDING_MAX_BYTES,
  DOCUMENT_FILE_HINT,
  DOCUMENT_TOO_LARGE_ADVICE,
  DOCUMENT_UPLOAD_UNCONFIRMED_TEXT,
  UPLOAD_LIMIT_TEXT,
  UPLOAD_REQUEST_BUDGET_BYTES,
  fitsUploadBudget,
  formatMegabytes,
  uploadSizeRefusal,
} from "./upload";

const MB = 1024 * 1024;
const fileOf = (bytes: number, name = "deed.pdf", type = "application/pdf") =>
  new File([new Uint8Array(bytes)], name, { type });

/**
 * One measured limit for every browser upload (T-upload-size-honest). Vercel
 * answers 413 to a request body over ~4.5 MB before any app code runs —
 * MEASURED on production 2026-08-30 (DECISIONS T-media-import: 3 MB → 200,
 * 5/8/20 MB → 413) — and Next 16 then throws on the client, which lands the
 * user on the error boundary. So nothing over the budget is ever sent.
 */
describe("the request budget", () => {
  it("sits under the measured ~4.5 MB platform 413, with headroom for the rest of the body", () => {
    expect(UPLOAD_REQUEST_BUDGET_BYTES).toBeLessThan(4_500_000);
    expect(UPLOAD_REQUEST_BUDGET_BYTES).toBeGreaterThan(3_000_000);
  });

  it("a file AT the budget fits; one byte over does not", () => {
    expect(fitsUploadBudget(UPLOAD_REQUEST_BUDGET_BYTES)).toBe(true);
    expect(fitsUploadBudget(UPLOAD_REQUEST_BUDGET_BYTES + 1)).toBe(false);
    expect(fitsUploadBudget(0)).toBe(true);
  });

  it("the branding cap is the server's own (lib/actions/settings.ts) and below the budget", () => {
    expect(BRANDING_MAX_BYTES).toBe(2 * MB);
    expect(BRANDING_MAX_BYTES).toBeLessThan(UPLOAD_REQUEST_BUDGET_BYTES);
  });
});

describe("formatMegabytes — one decimal, in the repo's MB (1024 × 1024, the unit of every server cap)", () => {
  it("formats to one decimal", () => {
    expect(formatMegabytes(5 * MB)).toBe("5.0 MB");
    expect(formatMegabytes(1.5 * MB)).toBe("1.5 MB");
    expect(formatMegabytes(0)).toBe("0.0 MB");
  });

  it("rounds a LIMIT down and a SIZE up, so a limit is never overstated", () => {
    // 3_500_000 bytes is 3.34 MB: stated as 3.3, never 3.4
    expect(formatMegabytes(UPLOAD_REQUEST_BUDGET_BYTES, "down")).toBe("3.3 MB");
    expect(formatMegabytes(2 * MB, "down")).toBe("2.0 MB");
    expect(formatMegabytes(2 * MB + 1, "up")).toBe("2.1 MB");
    expect(formatMegabytes(2 * MB, "up")).toBe("2.0 MB");
  });

  it("a refused size always reads LARGER than the limit it broke (no '3.3 MB is over the 3.3 MB limit')", () => {
    for (const limit of [UPLOAD_REQUEST_BUDGET_BYTES, BRANDING_MAX_BYTES]) {
      for (let bytes = limit + 1; bytes < limit + 400_000; bytes += 997) {
        const size = parseFloat(formatMegabytes(bytes, "up"));
        const cap = parseFloat(formatMegabytes(limit, "down"));
        expect(size, `${bytes} vs ${limit}`).toBeGreaterThan(cap);
      }
    }
  });
});

describe("the label the forms show is derived from the budget", () => {
  it("UPLOAD_LIMIT_TEXT is the budget, rounded down", () => {
    expect(UPLOAD_LIMIT_TEXT).toBe(formatMegabytes(UPLOAD_REQUEST_BUDGET_BYTES, "down"));
    expect(UPLOAD_LIMIT_TEXT).toBe("3.3 MB");
  });

  it("the document hint names the types and the real limit — not the undeliverable 15 MB", () => {
    expect(DOCUMENT_FILE_HINT).toContain(UPLOAD_LIMIT_TEXT);
    expect(DOCUMENT_FILE_HINT).toMatch(/PDF/);
    expect(DOCUMENT_FILE_HINT).not.toMatch(/15/);
  });
});

describe("uploadSizeRefusal — the pre-submit gate every upload form runs", () => {
  const advice = DOCUMENT_TOO_LARGE_ADVICE;

  it("lets through what it cannot judge: nothing chosen, a text field, an empty file input", () => {
    // the server answers these in its own words ("Choose a file to upload")
    expect(uploadSizeRefusal(null, UPLOAD_REQUEST_BUDGET_BYTES, advice)).toBeNull();
    expect(uploadSizeRefusal("not a file", UPLOAD_REQUEST_BUDGET_BYTES, advice)).toBeNull();
    expect(uploadSizeRefusal(fileOf(0, ""), UPLOAD_REQUEST_BUDGET_BYTES, advice)).toBeNull();
  });

  it("lets through a file at the budget", () => {
    expect(uploadSizeRefusal(fileOf(UPLOAD_REQUEST_BUDGET_BYTES), UPLOAD_REQUEST_BUDGET_BYTES, advice)).toBeNull();
  });

  it("refuses one byte over, naming the file, its size, the real limit, and what to do", () => {
    const text = uploadSizeRefusal(
      fileOf(UPLOAD_REQUEST_BUDGET_BYTES + 1, "title-deed.pdf"),
      UPLOAD_REQUEST_BUDGET_BYTES,
      advice,
    );
    expect(text).not.toBeNull();
    expect(text).toContain("title-deed.pdf");
    expect(text).toContain("3.4 MB");
    expect(text).toContain("3.3 MB");
    expect(text).toMatch(/nothing was uploaded/i);
    expect(text).toContain(advice);
  });

  it("a caller's own larger limit never lifts the request budget (15 MB was the documents' promise)", () => {
    const text = uploadSizeRefusal(fileOf(5 * MB), 15 * MB, advice);
    expect(text).not.toBeNull();
    expect(text).toContain("3.3 MB");
    expect(text).not.toContain("15");
  });

  it("a smaller limit (branding's 2 MB) is the one enforced and named", () => {
    expect(uploadSizeRefusal(fileOf(BRANDING_MAX_BYTES, "logo.png", "image/png"), BRANDING_MAX_BYTES, "x")).toBeNull();
    const text = uploadSizeRefusal(fileOf(BRANDING_MAX_BYTES + 1, "logo.png", "image/png"), BRANDING_MAX_BYTES, "x");
    expect(text).toContain("2.0 MB");
    expect(text).toContain("2.1 MB");
  });
});

describe("what the document forms say", () => {
  it("the advice keeps the original: compress or split the PDF, or use a smaller image — never 're-encode'", () => {
    expect(DOCUMENT_TOO_LARGE_ADVICE).toMatch(/compress/i);
    expect(DOCUMENT_TOO_LARGE_ADVICE).toMatch(/split/i);
    expect(DOCUMENT_TOO_LARGE_ADVICE).toMatch(/smaller/i);
  });

  it("an upload whose request never came back is an UNKNOWN outcome, not a failure", () => {
    expect(DOCUMENT_UPLOAD_UNCONFIRMED_TEXT).toMatch(/could not confirm/i);
    expect(DOCUMENT_UPLOAD_UNCONFIRMED_TEXT).toMatch(/before uploading it again/i);
  });
});
