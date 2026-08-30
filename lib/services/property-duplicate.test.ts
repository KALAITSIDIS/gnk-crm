import { describe, expect, it } from "vitest";
import {
  findAddressMatch,
  findRegistrationMatch,
  normaliseAddress,
  normaliseRegistrationNo,
  type DuplicateCandidate,
  type RegistrationCandidate,
} from "./property-duplicate";

const candidate = (over: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({
  id: "p1",
  reference: "PAF0007",
  address: "12 Poseidonos Avenue",
  title: { en: "Seafront villa" },
  status: "available",
  ...over,
});

describe("normaliseAddress", () => {
  it("treats punctuation and street-type words as noise", () => {
    expect(normaliseAddress("12, Poseidonos Avenue")).toBe(
      normaliseAddress("12 poseidonos ave."),
    );
  });

  it("KEEPS the house number — it is usually the whole signal", () => {
    // dropping it would make every address on a street match every other one
    expect(normaliseAddress("12 Poseidonos")).not.toBe(normaliseAddress("14 Poseidonos"));
  });

  it("collapses whitespace and case", () => {
    expect(normaliseAddress("  12   POSEIDONOS  ")).toBe("12 poseidonos");
  });

  it("survives an address that is only noise", () => {
    expect(normaliseAddress("Street")).toBe("");
    expect(normaliseAddress("")).toBe("");
  });
});

describe("findAddressMatch", () => {
  it("finds the same address written differently", () => {
    const m = findAddressMatch([candidate()], "12, poseidonos ave");
    expect(m).toMatchObject({ reference: "PAF0007", label: "Seafront villa" });
  });

  it("does not match a different house number on the same street", () => {
    expect(findAddressMatch([candidate()], "14 Poseidonos Avenue")).toBeNull();
  });

  it("ignores candidates with no address at all", () => {
    expect(findAddressMatch([candidate({ address: null })], "12 Poseidonos Avenue")).toBeNull();
  });

  it("refuses to match on too little — a bare number is not evidence", () => {
    expect(findAddressMatch([candidate({ address: "12" })], "12")).toBeNull();
  });

  it("falls back to the address when the candidate has no English title", () => {
    const m = findAddressMatch([candidate({ title: null })], "12 Poseidonos Avenue");
    expect(m!.label).toBe("12 Poseidonos Avenue");
  });

  it("still reports a retired property — a withdrawn duplicate is still a duplicate", () => {
    const m = findAddressMatch([candidate({ status: "withdrawn" })], "12 Poseidonos Avenue");
    expect(m!.status).toBe("withdrawn");
  });

  it("returns the first match and stops", () => {
    const m = findAddressMatch(
      [candidate({ id: "a", reference: "PAF0001" }), candidate({ id: "b", reference: "PAF0002" })],
      "12 Poseidonos Avenue",
    );
    expect(m!.reference).toBe("PAF0001");
  });

  it("is null-safe on an empty candidate list", () => {
    expect(findAddressMatch([], "12 Poseidonos Avenue")).toBeNull();
  });
});

describe("findRegistrationMatch (0077, DB-05)", () => {
  const reg = (over: Partial<RegistrationCandidate> = {}): RegistrationCandidate => ({
    id: "p1",
    reference: "PAF0001",
    registration_no: "0/12345",
    title: { en: "Sea-view plot" },
    status: "available",
    ...over,
  });

  it("case and internal spacing are typist noise — '0 / 12345' matches '0/12345'", () => {
    const m = findRegistrationMatch([reg()], "0 / 12345");
    expect(m).not.toBeNull();
    expect(m!.reference).toBe("PAF0001");
  });

  it("different numbers never match — no fuzziness on a legal identifier", () => {
    expect(findRegistrationMatch([reg()], "0/12346")).toBeNull();
  });

  it("candidates without a registration number are skipped, not matched on empty", () => {
    expect(findRegistrationMatch([reg({ registration_no: null })], "0/12345")).toBeNull();
  });

  it("a too-short target is not evidence of anything", () => {
    expect(findRegistrationMatch([reg({ registration_no: "12" })], "12")).toBeNull();
  });

  it("normalisation uppercases and strips ALL whitespace", () => {
    expect(normaliseRegistrationNo(" k a 51/29 w2 ")).toBe("KA51/29W2");
  });
});
