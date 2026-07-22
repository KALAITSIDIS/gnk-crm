/*
 * Disable standard ligatures in a TrueType font, in place.
 *
 * WHY: @react-pdf/renderer shapes text with fontkit and then draws the
 * resulting glyphs itself, bypassing pdfkit's `encode()` — the only path that
 * records `glyph.codePoints` into the ToUnicode CMap. A substituted ligature
 * glyph (fi, ff, fl…) therefore lands in the embedded subset with NO ToUnicode
 * entry: the page LOOKS right, but copy/paste and text search silently lose
 * characters. A real production commission report extracted
 * "Lead corrected — ?rst-response reset". Evidence documents get searched and
 * quoted, so that is a defect (see DECISIONS T-audit-pdf-ligatures).
 *
 * react-pdf exposes no way to pass OpenType features (textkit hardcodes
 * `font.layout(str, undefined, …)`), so we remove the substitutions at the
 * source: rename the ligature FeatureRecord tags in GSUB to an inert
 * uppercase tag. Shapers look features up by tag, so an unknown tag is simply
 * never applied. The edit is byte-for-byte length preserving — no offsets
 * move, nothing else in the font changes.
 *
 * Noto is OFL WITHOUT a Reserved Font Name, so modifying and redistributing
 * under the same name is permitted; lib/assets/fonts/OFL.txt ships alongside.
 *
 * Usage: node scripts/fonts/disable-ligatures.mjs <font.ttf> [more.ttf...]
 */
import { readFileSync, writeFileSync } from "node:fs";

/** Standard/contextual/discretionary/historical/required ligature features. */
const LIGATURE_TAGS = ["liga", "clig", "dlig", "hlig", "rlig"];

function disableLigatures(file) {
  const buf = readFileSync(file);

  // --- table directory -----------------------------------------------------
  const numTables = buf.readUInt16BE(4);
  let gsubOffset = null;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString("latin1", rec, rec + 4) === "GSUB") {
      gsubOffset = buf.readUInt32BE(rec + 8);
      break;
    }
  }
  if (gsubOffset === null) return { file, renamed: 0, note: "no GSUB table" };

  // --- GSUB header: version, ScriptList, FeatureList, LookupList -----------
  const featureListOffset = gsubOffset + buf.readUInt16BE(gsubOffset + 6);
  const featureCount = buf.readUInt16BE(featureListOffset);

  // --- FeatureRecord[]: tag (4 bytes) + offset (2 bytes) -------------------
  const renamed = [];
  for (let i = 0; i < featureCount; i++) {
    const rec = featureListOffset + 2 + i * 6;
    const tag = buf.toString("latin1", rec, rec + 4);
    if (!LIGATURE_TAGS.includes(tag)) continue;
    // inert, still legible to a human inspecting the font
    buf.write(tag.toUpperCase(), rec, 4, "latin1");
    renamed.push(tag);
  }

  if (renamed.length) writeFileSync(file, buf);
  return { file, renamed: renamed.length, note: renamed.join(", ") || "none found" };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node scripts/fonts/disable-ligatures.mjs <font.ttf> [...]");
  process.exit(1);
}
for (const f of files) {
  const r = disableLigatures(f);
  console.log(`${r.file}: renamed ${r.renamed} feature(s) [${r.note}]`);
}
