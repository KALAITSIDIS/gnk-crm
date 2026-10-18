import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRANDING_FILES, BRANDING_FOLDER, BRANDING_USE, brandingPublicUrl, readBrandingFiles } from "./branding";

/**
 * The branding reader (A07): one listing for Settings → Organization and the
 * Settings overview, which tells a failed listing from an empty folder — the
 * organization page used to read a failed listing as "Not uploaded yet."
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

type Listing = { data: unknown; error: { message: string } | null };

function admin(listing: Listing | Error) {
  const asked: Array<{ bucket: string; folder?: string; path?: string }> = [];
  const client = {
    storage: {
      from: (bucket: string) => ({
        list: async (folder: string) => {
          asked.push({ bucket, folder });
          if (listing instanceof Error) throw listing;
          return listing;
        },
        getPublicUrl: (path: string) => {
          asked.push({ bucket, path });
          return { data: { publicUrl: `https://storage.test/${bucket}/${path}` } };
        },
      }),
    },
  } as never;
  return { client, asked };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readBrandingFiles", () => {
  it("lists the one branding folder of the media bucket and reports each uploaded kind with its updated_at", async () => {
    const a = admin({
      data: [
        { name: "logo.png", updated_at: "2026-10-01T10:00:00Z" },
        { name: "something-else.png", updated_at: "x" },
      ],
      error: null,
    });
    await expect(readBrandingFiles(a.client)).resolves.toEqual({ ok: true, files: { logo: "2026-10-01T10:00:00Z" } });
    expect(a.asked).toEqual([{ bucket: "media", folder: "branding" }]);
  });

  it("an empty folder is an answer: nothing uploaded", async () => {
    await expect(readBrandingFiles(admin({ data: [], error: null }).client)).resolves.toEqual({ ok: true, files: {} });
  });

  it("an error, a hollow answer or a throw is { ok: false } — never 'nothing uploaded'", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(readBrandingFiles(admin({ data: null, error: { message: "denied" } }).client)).resolves.toEqual({ ok: false });
    await expect(readBrandingFiles(admin({ data: null, error: null }).client)).resolves.toEqual({ ok: false });
    await expect(readBrandingFiles(admin(new Error("socket hang up")).client)).resolves.toEqual({ ok: false });
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("builds the public URL from the fixed path, cache-busted by the file's own updated_at", () => {
    const a = admin({ data: [], error: null });
    expect(brandingPublicUrl(a.client, "watermark", "2026-10-01T10:00:00Z")).toBe(
      "https://storage.test/media/branding/watermark.png?v=2026-10-01T10%3A00%3A00Z",
    );
  });
});

describe("the paths are the writer's", () => {
  it("uploadBranding writes, and the photo pipeline reads, exactly the paths this reader lists", () => {
    const settings = readFileSync(join(root, "lib/actions/settings.ts"), "utf-8");
    const media = readFileSync(join(root, "lib/actions/media.ts"), "utf-8");
    expect(settings).toContain(`logo: "${BRANDING_FOLDER}/${BRANDING_FILES.logo}"`);
    expect(settings).toContain(`watermark: "${BRANDING_FOLDER}/${BRANDING_FILES.watermark}"`);
    expect(media).toContain(`const WATERMARK_PATH = "${BRANDING_FOLDER}/${BRANDING_FILES.watermark}"`);
  });
});

describe("what each file does, in words both pages print", () => {
  it("the logo promises nothing that is not built", () => {
    expect(BRANDING_USE.logo).toMatch(/no document or report prints it yet/);
    expect(BRANDING_USE.logo).not.toMatch(/used on documents/);
  });

  it("the watermark says when it is applied and that earlier photos stay as they are", () => {
    expect(BRANDING_USE.watermark).toMatch(/public and partner listings/);
    expect(BRANDING_USE.watermark).toMatch(/not re-processed/);
  });

  it("nothing in the shipped code reads the logo — when something starts to, these words must change with it", () => {
    // the logo's path appears in its writer (uploadBranding) and this reader, nowhere else
    const hits = sourceFiles(["app", "components", "lib"])
      .filter((f) => {
        const src = readFileSync(join(root, f), "utf-8");
        return src.includes("logo.png") || src.includes("BRANDING_FILES.logo");
      })
      .sort();
    expect(hits).toEqual(["lib/actions/settings.ts", "lib/services/branding.ts"]);
  });
});

function sourceFiles(dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(next);
    }
  };
  dirs.forEach(walk);
  return out;
}
