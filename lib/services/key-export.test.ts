import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";
import { keyCsvColumns, type KeyExportRow } from "./key-export";

const base: KeyExportRow = {
  key_code: "534543534",
  description: "Front door + gate",
  status: "checked_out",
  current_holder_name: "Nino Charalambous",
  properties: { reference: "GNK-PAF-0001" },
};

const line = (csv: string, i = 1) => csv.replace(/^﻿/, "").split("\r\n")[i];

describe("keyCsvColumns", () => {
  it("names every column in the header", () => {
    expect(line(toCsv(keyCsvColumns(), []), 0)).toBe(
      "Key code,Property,Description,Status,Holder",
    );
  });

  it("writes the key with its property and holder", () => {
    const csv = toCsv(keyCsvColumns(), [base]);
    expect(line(csv)).toBe("534543534,GNK-PAF-0001,Front door + gate,checked_out,Nino Charalambous");
  });

  it("leaves holder and property blank for an in-office key with no property", () => {
    const csv = toCsv(keyCsvColumns(), [
      { ...base, status: "in_office", current_holder_name: null, properties: null },
    ]);
    expect(line(csv)).toBe("534543534,,Front door + gate,in_office,");
  });
});
