import { inflateSync } from "node:zlib";

/**
 * Test-only: recover the text a generated PDF actually DRAWS, by decoding the
 * glyph ids in its content streams through the PDF's own ToUnicode CMaps.
 *
 * This is what a viewer's copy/paste and text search see — which is not the
 * same as what the page looks like. A glyph with no ToUnicode entry (e.g. an
 * `fi` ligature the renderer never mapped back to "f"+"i") renders fine but is
 * invisible to extraction; we surface those as U+FFFD so a test can assert on
 * them instead of silently losing characters.
 *
 * Each embedded subset has its own glyph-id space, so the decoder resolves
 * /Fn -> font object -> /ToUnicode and follows the active `Tf` per stream.
 * Latin-1 keeps one char per byte, so string offsets are byte offsets.
 */
export function extractPdfText(pdf: Buffer): string {
  const raw = pdf.toString("latin1");

  // object number -> inflated stream body
  const streamOf = new Map<number, string>();
  for (const m of raw.matchAll(/(\d+) 0 obj/g)) {
    const objNum = Number(m[1]);
    const from = m.index! + m[0].length;
    const end = raw.indexOf("endobj", from);
    const si = raw.indexOf("stream", from);
    if (si === -1 || (end !== -1 && si > end)) continue;
    let start = si + 6;
    if (raw[start] === "\r") start++;
    if (raw[start] === "\n") start++;
    const ei = raw.indexOf("endstream", start);
    if (ei === -1) continue;
    try {
      streamOf.set(objNum, inflateSync(pdf.subarray(start, ei)).toString("latin1"));
    } catch {
      // not deflate (embedded font program) — irrelevant here
    }
  }

  const parseCmap = (body: string | undefined): Map<number, string> => {
    const map = new Map<number, string>();
    if (!body) return map;
    for (const block of body.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const [, code, uni] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        let out = "";
        for (let i = 0; i < uni.length; i += 4) {
          out += String.fromCharCode(parseInt(uni.slice(i, i + 4), 16));
        }
        map.set(parseInt(code, 16), out);
      }
    }
    return map;
  };

  // /Fn -> its glyph map, via the font object's /ToUnicode reference
  const fontMaps = new Map<string, Map<number, string>>();
  for (const res of raw.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) {
    for (const [, name, objNum] of res[1].matchAll(/\/(F\d+)\s+(\d+) 0 R/g)) {
      const objBody = raw.slice(raw.indexOf(`${objNum} 0 obj`));
      const toUni = objBody.slice(0, 400).match(/\/ToUnicode\s+(\d+) 0 R/);
      if (toUni) fontMaps.set(name, parseCmap(streamOf.get(Number(toUni[1]))));
    }
  }

  const lines: string[] = [];
  for (const body of streamOf.values()) {
    if (!body.includes("TJ")) continue;
    let active: Map<number, string> | undefined;
    // walk font selections and text runs in document order
    for (const tok of body.matchAll(/\/(F\d+)\s+[\d.]+\s+Tf|\[([^\]]*)\]\s*TJ/g)) {
      if (tok[1]) {
        active = fontMaps.get(tok[1]);
        continue;
      }
      let line = "";
      for (const part of tok[2].matchAll(/<([0-9a-fA-F]+)>/g)) {
        const hex = part[1];
        for (let i = 0; i + 4 <= hex.length; i += 4) {
          const gid = parseInt(hex.slice(i, i + 4), 16);
          line += active?.get(gid) ?? "�";
        }
      }
      if (line) lines.push(line);
    }
  }
  return lines.join("\n");
}
