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
 * client-image.ts, the digest and the verify form's action in client-hash.ts);
 * this file pins that the forms USE them — no jsdom here, so the components
 * are read as source, each pattern scoped to the element it is about. What
 * the forms PRINT as their limit is rendered in upload-form-labels.test.ts.
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

/**
 * Scoped to ONE element, so a handler on some other element of the file (or
 * the name in an import) does not satisfy it: the <form> tag whose submit is
 * the hook's handler, and the file input whose own onChange is the hook's size
 * check. `[^>]*` stays inside the tag (these tags hold no arrow function).
 */
const FORM_SUBMITS_THROUGH_HOOK = /<form\b[^>]*\bonSubmit=\{\w+\.onSubmit\}/;
const FILE_INPUT_CHECKS_SIZE = /<(?:input|Input)\b(?=[^>]*\btype="file")[^>]*\bonChange=\{\w+\.onFileChange\}/;
/** A lost request is reported where the error boundary used to report it. */
const REPORTS_TO_SENTRY = /onRejected:\s*\(\w+\)\s*=>\s*\{?\s*Sentry\.captureException\(\w+/;

const DOCUMENT_FORMS = [
  {
    file: ["components", "features", "properties", "documents-tab.tsx"],
    action: "uploadPropertyDocument",
    label: /<Label htmlFor="doc_file">File \(\{DOCUMENT_FILE_HINT\}\)<\/Label>/,
  },
  {
    file: ["components", "features", "contacts", "documents-tab.tsx"],
    action: "uploadContactDocument",
    label: /<Label htmlFor="doc_file">File \(\{DOCUMENT_FILE_HINT\}\)<\/Label>/,
  },
  {
    file: ["components", "features", "properties", "mandate-panel.tsx"],
    action: "uploadMandateDocument",
    label: />\{DOCUMENT_FILE_HINT\} · private bucket\.<\/p>/,
  },
] as const;

describe("the document upload forms gate the size and catch a lost answer", () => {
  for (const { file, action, label } of DOCUMENT_FORMS) {
    const name = file.join("/");

    it(`${name}: submits ${action} through useUploadForm, never straight through useActionState`, () => {
      const src = code(...file);
      expect(src).toMatch(new RegExp(`useUploadForm\\(\\{[\\s\\S]*?action:\\s*${action}\\b`));
      expect(src).not.toMatch(new RegExp(`useActionState\\(\\s*${action}\\b`));
      // the form is submitted by the hook's handler, and the file is checked when chosen
      expect(src).toMatch(FORM_SUBMITS_THROUGH_HOOK);
      expect(src).toMatch(FILE_INPUT_CHECKS_SIZE);
    });

    it(`${name}: states the REAL limit, derived from the budget — no undeliverable 15 MB`, () => {
      const src = code(...file);
      // in the MARKUP, not merely imported (an unused import is only a lint warning)
      expect(src).toMatch(label);
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

  it("the hook reports a lost request, as the error boundary it no longer reaches did", () => {
    // a platform 413 never reaches the server's logs — this is the one signal
    // that the request budget is set too high
    const src = code("components", "features", "shared", "use-upload-form.ts");
    expect(src).toMatch(/submitUpload\([\s\S]*?onRejected:/);
    expect(src).toMatch(REPORTS_TO_SENTRY);
  });
});

describe("the branding upload is gated at its own cap", () => {
  it("org-forms.tsx: BrandingUpload goes through useUploadForm with BRANDING_MAX_BYTES", () => {
    const src = code("components", "features", "settings", "org-forms.tsx");
    expect(src).toMatch(/useUploadForm\(\{[\s\S]*?action:\s*uploadBranding\b[\s\S]*?limit:\s*BRANDING_MAX_BYTES/);
    expect(src).not.toMatch(/useActionState\(\s*uploadBranding\b/);
    expect(src).toMatch(FORM_SUBMITS_THROUGH_HOOK);
    expect(src).toMatch(FILE_INPUT_CHECKS_SIZE);
  });

  it("settings.ts refuses at the same constant — one cap, not two literals", () => {
    const src = code("lib", "actions", "settings.ts");
    expect(src).toMatch(/file\.size > BRANDING_MAX_BYTES/);
    expect(src).not.toMatch(/2 \* 1024 \* 1024/);
  });
});

describe("verify-a-report posts a digest, never the PDF", () => {
  it("verify-report.tsx runs verifyInBrowser (hash, digest-only body, every failure an answer) and never calls the action itself", () => {
    // the behaviour is unit-tested in lib/services/client-hash.test.ts; this
    // pins that the form uses it, with the real action as its `verify` step
    const src = code("components", "features", "reports", "verify-report.tsx");
    expect(src).toMatch(/verifyInBrowser\(\s*\w+\s*,\s*\w+\s*,\s*\{[\s\S]*?verify:\s*verifyEvidenceReport\b/);
    expect(src).toMatch(/useActionState\(\s*\w+\s*,\s*initialState\s*\)/);
    expect(src).not.toMatch(/verifyEvidenceReport\(/);
    expect(src).not.toMatch(/useActionState\(\s*verifyEvidenceReport\b/);
    expect(src).toMatch(REPORTS_TO_SENTRY);
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

  it("media-tab.tsx brings every photo under the budget before it is sent", () => {
    // without this step every phone photo over the budget is posted whole and
    // meets the platform's 413 — and the small JPEG of the e2e photo case
    // never needs the resize, so nothing else would notice
    const src = code("components", "features", "properties", "media-tab.tsx");
    expect(src).toMatch(/uploadOneByOne\([\s\S]*?prepare:\s*downscaleForUpload\b/);
  });

  it("media-tab.tsx reports a lost request, as the error boundary it no longer reaches did", () => {
    const src = code("components", "features", "properties", "media-tab.tsx");
    expect(src).toMatch(/uploadOneByOne\([\s\S]*?onRejected:/);
    expect(src).toMatch(REPORTS_TO_SENTRY);
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
