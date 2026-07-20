import path from "node:path";
import { Font } from "@react-pdf/renderer";

/**
 * react-pdf's built-in fonts (Helvetica/Courier) encode Latin-1 only — Greek
 * and Cyrillic text (routine here: el/ru are first-class locales) renders
 * broken. Every PDF therefore embeds Noto Sans LGC (Latin+Greek+Cyrillic,
 * OFL-licensed, committed under lib/assets/fonts and force-traced into the
 * serverless bundle via next.config `outputFileTracingIncludes`).
 *
 * Courier remains acceptable ONLY for hex digests (pure ASCII).
 */

export const PDF_FONT = "NotoSans";

let registered = false;

/** Idempotent; call before any renderToBuffer. */
export function registerPdfFonts(): void {
  if (registered) return;
  const dir = path.join(process.cwd(), "lib", "assets", "fonts");
  Font.register({
    family: PDF_FONT,
    fonts: [
      { src: path.join(dir, "NotoSans-Regular.ttf"), fontWeight: 400 },
      { src: path.join(dir, "NotoSans-Bold.ttf"), fontWeight: 700 },
    ],
  });
  registered = true;
}
