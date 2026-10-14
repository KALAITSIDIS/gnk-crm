import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every browser upload is held to ONE measured request budget
 * (lib/constants/upload.ts; T-upload-size-honest). Vercel answers a body over
 * ~4.5 MB with a platform 413 before any app code runs (MEASURED 2026-08-30,
 * DECISIONS T-media-import), Next 16 then throws on the client, and a form
 * that hands a server action straight to useActionState lands the user on the
 * error boundary. The behaviour lives in tested modules (the gate and the
 * submit in lib/services/client-upload.ts, the photo resize in
 * client-image.ts, the digest in client-hash.ts); this file pins that the
 * forms USE them — no jsdom here, so the components are read as source.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf-8");

/** Code, not commentary. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = (...parts: string[]) => stripComments(read(...parts));

function filesUnder(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return filesUnder(full, pattern);
    return pattern.test(name) ? [full] : [];
  });
}

const DOCUMENT_FORMS = [
  { file: ["components", "features", "properties", "documents-tab.tsx"], action: "uploadPropertyDocument" },
  { file: ["components", "features", "contacts", "documents-tab.tsx"], action: "uploadContactDocument" },
  { file: ["components", "features", "properties", "mandate-panel.tsx"], action: "uploadMandateDocument" },
] as const;

describe("the document upload forms gate the size and catch a lost answer", () => {
  for (const { file, action } of DOCUMENT_FORMS) {
    const name = file.join("/");

    it(`${name}: submits ${action} through useUploadForm, never straight through useActionState`, () => {
      const src = code(...file);
      expect(src).toMatch(new RegExp(`useUploadForm\\(\\{[\\s\\S]*?action:\\s*${action}\\b`));
      expect(src).not.toMatch(new RegExp(`useActionState\\(\\s*${action}\\b`));
      // the form is submitted by the hook's handler, and the file is checked when chosen
      expect(src).toMatch(/onSubmit=\{\w+\.onSubmit\}/);
      expect(src).toMatch(/onChange=\{\w+\.onFileChange\}/);
    });

    it(`${name}: states the REAL limit, derived from the budget — no undeliverable 15 MB`, () => {
      const src = code(...file);
      expect(src).toContain("DOCUMENT_FILE_HINT");
      expect(src).not.toMatch(/15\s*MB/i);
    });
  }

  it("the hook prevents the native submit, refuses before sending, and goes through submitUpload", () => {
    const src = code("components", "features", "shared", "use-upload-form.ts");
    expect(src).toContain("event.preventDefault()");
    expect(src).toMatch(/uploadSizeRefusal\(/);
    expect(src).toMatch(/submitUpload\(/);
    // an unknown outcome stays on screen and the page is re-read (the outcome-actions idiom)
    expect(src).toMatch(/case "unconfirmed"[\s\S]*?router\.refresh\(\)/);
  });
});

describe("the branding upload is gated at its own cap", () => {
  it("org-forms.tsx: BrandingUpload goes through useUploadForm with BRANDING_MAX_BYTES", () => {
    const src = code("components", "features", "settings", "org-forms.tsx");
    expect(src).toMatch(/useUploadForm\(\{[\s\S]*?action:\s*uploadBranding\b[\s\S]*?limit:\s*BRANDING_MAX_BYTES/);
    expect(src).not.toMatch(/useActionState\(\s*uploadBranding\b/);
  });

  it("settings.ts refuses at the same constant — one cap, not two literals", () => {
    const src = code("lib", "actions", "settings.ts");
    expect(src).toMatch(/file\.size > BRANDING_MAX_BYTES/);
    expect(src).not.toMatch(/2 \* 1024 \* 1024/);
  });
});

describe("verify-a-report posts a digest, never the PDF", () => {
  it("verify-report.tsx hashes in the browser and sends only verifyRequestBody's result", () => {
    const src = code("components", "features", "reports", "verify-report.tsx");
    expect(src).toMatch(/verifyRequestBody\(/);
    expect(src).toMatch(/verifyEvidenceReport\(\s*\w+\s*,\s*body\s*\)/);
    expect(src).not.toMatch(/useActionState\(\s*verifyEvidenceReport\b/);
  });
});

describe("the media tab never sticks on 'Uploading'", () => {
  it("media-tab.tsx sends through uploadOneByOne and resets the uploading state in a finally", () => {
    const src = code("components", "features", "properties", "media-tab.tsx");
    expect(src).toMatch(/uploadOneByOne\(/);
    expect(src).toMatch(/finally\s*\{[^}]*setUploading\(false\)/);
    // the action is called only as the loop's send step
    const calls = src.match(/uploadPropertyMedia\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(src).toMatch(/send:\s*\(\w+\)\s*=>\s*\{[\s\S]*?uploadPropertyMedia\(/);
  });
});

describe("one budget, one definition", () => {
  it("the 3.5 MB budget is written once, in lib/constants/upload.ts", () => {
    const offenders: string[] = [];
    for (const dir of ["app", "components", "lib"]) {
      for (const file of filesUnder(join(root, dir), /\.(ts|tsx)$/)) {
        if (/\.test\.ts$/.test(file)) continue;
        const rel = relative(root, file).replace(/\\/g, "/");
        if (rel === "lib/constants/upload.ts") continue;
        const src = stripComments(readFileSync(file, "utf-8"));
        if (/3_500_000|UPLOAD_REQUEST_BUDGET_BYTES\s*=/.test(src)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every file input in the app is one of the gated forms — a new one must be gated before it ships", () => {
    const found = new Set<string>();
    for (const dir of ["app", "components"]) {
      for (const file of filesUnder(join(root, dir), /\.tsx$/)) {
        if (/type="file"/.test(stripComments(readFileSync(file, "utf-8")))) {
          found.add(relative(root, file).replace(/\\/g, "/"));
        }
      }
    }
    expect([...found].sort()).toEqual([
      "components/features/contacts/documents-tab.tsx",
      "components/features/properties/documents-tab.tsx",
      "components/features/properties/mandate-panel.tsx",
      "components/features/properties/media-tab.tsx",
      "components/features/reports/verify-report.tsx",
      "components/features/settings/org-forms.tsx",
    ]);
  });
});
