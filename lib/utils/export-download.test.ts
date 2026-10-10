import { describe, expect, it } from "vitest";
import { EXPORT_FAILED_MESSAGE, EXPORT_TOO_MANY_MESSAGE } from "@/lib/constants/export";
import {
  EXPORT_SESSION_ENDED_MESSAGE,
  csvFilenameOf,
  exportRefusalMessage,
  isCsvAnswer,
} from "./export-download";

/** A Response as fetch hands it over after following redirects. */
function answer(body: BodyInit | null, init: ResponseInit, after?: { url: string }): Response {
  const res = new Response(body, init);
  if (after) {
    Object.defineProperty(res, "redirected", { value: true });
    Object.defineProperty(res, "url", { value: after.url });
  }
  return res;
}
const csv = (status = 200) =>
  answer("﻿Name\r\n", {
    status,
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="contacts-2026-10-10.csv"' },
  });
const json = (status: number, body: unknown) =>
  answer(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("isCsvAnswer — only a real CSV is saved", () => {
  it("a 200 text/csv is a CSV", () => expect(isCsvAnswer(csv())).toBe(true));

  it.each([
    ["the ceiling's refusal", json(422, { error: EXPORT_TOO_MANY_MESSAGE, reason: "too_many" })],
    ["a failed export", json(500, { error: EXPORT_FAILED_MESSAGE, reason: "failed" })],
    ["a crashed route (empty 500)", answer(null, { status: 500 })],
    ["a sign-in page reached through the proxy's redirect", answer("<html>", { status: 200, headers: { "content-type": "text/html" } }, { url: "http://x/login" })],
    ["a redirected 200 that even claims text/csv", answer("x", { status: 200, headers: { "content-type": "text/csv" } }, { url: "http://x/login" })],
  ])("%s is not", (_, res) => expect(isCsvAnswer(res)).toBe(false));
});

describe("exportRefusalMessage — what the user is told", () => {
  it("the route's own reason: too many records, with the ceiling and what to do", async () => {
    const message = await exportRefusalMessage(json(422, { error: EXPORT_TOO_MANY_MESSAGE, reason: "too_many" }));
    expect(message).toBe(EXPORT_TOO_MANY_MESSAGE);
    expect(message).toMatch(/More than 10,000 records match/);
    expect(message).toMatch(/Nothing was downloaded — narrow the filters/);
  });

  it("the route's own reason: failed", async () => {
    expect(await exportRefusalMessage(json(500, { error: EXPORT_FAILED_MESSAGE, reason: "failed" }))).toBe(
      EXPORT_FAILED_MESSAGE,
    );
  });

  it.each(["/login", "/login/verify", "/security"])("a redirect to %s says the session ended", async (path) => {
    const res = answer("<html>", { status: 200, headers: { "content-type": "text/html" } }, { url: `http://x${path}?enrol=required` });
    expect(await exportRefusalMessage(res)).toBe(EXPORT_SESSION_ENDED_MESSAGE);
  });

  it.each([
    ["an empty 500 (a thrown audit write)", answer(null, { status: 500 })],
    ["an HTML error page", answer("<html>", { status: 502, headers: { "content-type": "text/html" } })],
    ["JSON without a message", json(500, { reason: "failed" })],
    ["JSON with a blank message", json(500, { error: "  " })],
    ["JSON that is not JSON", answer("{", { status: 500, headers: { "content-type": "application/json" } })],
    ["a JSON null", json(500, null)],
  ])("the generic failure for %s", async (_, res) => {
    expect(await exportRefusalMessage(res)).toBe(EXPORT_FAILED_MESSAGE);
  });
});

describe("csvFilenameOf", () => {
  it("takes the route's filename", () => {
    expect(csvFilenameOf('attachment; filename="deals-sale-2026-10-10.csv"')).toBe("deals-sale-2026-10-10.csv");
  });
  it("falls back when there is none", () => {
    expect(csvFilenameOf(null)).toBe("export.csv");
    expect(csvFilenameOf("attachment")).toBe("export.csv");
  });
});
