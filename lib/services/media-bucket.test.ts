import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mediaBucketFor } from "./media-bucket";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Code, not commentary. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("which bucket a rendition lives in", () => {
  it("a photograph's renditions are public — publishing them is what they are for", () => {
    expect(mediaBucketFor("photo")).toBe("media");
  });

  it("a floor plan's are private — the one thing a seller may hold under confidentiality", () => {
    expect(mediaBucketFor("floor_plan")).toBe("documents");
  });

  it("anything that is not a photograph is private, including kinds nothing uploads yet", () => {
    expect(mediaBucketFor("video")).toBe("documents");
    expect(mediaBucketFor("virtual_tour")).toBe("documents");
    expect(mediaBucketFor("something_new")).toBe("documents");
  });
});

describe("the bucket is decided in one place", () => {
  const media = stripComments(readFileSync(join(root, "lib", "actions", "media.ts"), "utf-8"));

  it("lib/actions/media.ts names the public bucket once, for the watermark, and reads mediaBucketFor for every rendition", () => {
    // The literal is allowed exactly once: the org watermark lives in the
    // public bucket by design (Settings uploads it there). A second literal
    // next to a rendition path is the pre-2026-09-06 shape coming back.
    const literals = media.match(/\.from\("media"\)/g) ?? [];
    expect(literals, "one .from(\"media\") — the watermark").toHaveLength(1);
    expect(media).toContain("mediaBucketFor(");
    // and the private literal is used only for the ORIGINAL upload and its cleanup,
    // never for a rendition
    for (const line of media.split("\n")) {
      if (/\.from\("documents"\)/.test(line)) continue;
      if (/renditionPath\(/.test(line) && /\.from\("(media|documents)"\)/.test(line)) {
        throw new Error("a rendition path beside a bucket literal: " + line.trim());
      }
    }
  });

  it("the property page never builds a public URL for something that is not a photograph", () => {
    const page = stripComments(
      readFileSync(join(root, "app", "(app)", "properties", "[id]", "page.tsx"), "utf-8"),
    );
    // The page decides the URL per row through mediaBucketFor; the tab only renders it.
    expect(page).toContain("mediaBucketFor(");
    const tab = stripComments(
      readFileSync(
        join(root, "components", "features", "properties", "media-tab.tsx"),
        "utf-8",
      ),
    );
    expect(tab, "the tab renders the URL the page decided").not.toContain("publicMediaUrl(");
  });
});
