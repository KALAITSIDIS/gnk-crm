import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeObjectsBestEffort, removeObjectsOrFail, type StorageLike } from "./storage";

/**
 * A fake bucket: `removed` is what remove() will claim; `present` is what
 * exists() will answer for anything not claimed; a path in `existsErrors`
 * makes exists() fail for it.
 */
function fake(opts: {
  removed?: string[];
  present?: string[];
  removeError?: string;
  existsErrors?: string[];
}) {
  const calls: string[] = [];
  const from = () => ({
    remove: async (paths: string[]) => {
      calls.push(`remove:${paths.join(",")}`);
      if (opts.removeError) return { data: null, error: { message: opts.removeError } };
      return { data: (opts.removed ?? []).map((name) => ({ name })), error: null };
    },
    exists: async (path: string) => {
      calls.push(`exists:${path}`);
      if ((opts.existsErrors ?? []).includes(path)) {
        return { data: false, error: { message: "boom" } };
      }
      return { data: (opts.present ?? []).includes(path), error: null };
    },
  });
  return { storage: { from } as unknown as StorageLike, calls };
}

describe("removeObjectsOrFail proves absence", () => {
  it("resolves when the API claims every path", async () => {
    const { storage, calls } = fake({ removed: ["a", "b"] });
    await expect(removeObjectsOrFail(storage, "documents", ["a", "b"])).resolves.toBeUndefined();
    expect(calls).toEqual(["remove:a,b"]);
  });

  it("treats an unclaimed path as done only once exists() says it is gone — the re-run case", async () => {
    // supabase-js reports a missing object as data, not an error: a path that
    // was already removed by a half-finished first run simply does not appear.
    const { storage, calls } = fake({ removed: ["a"], present: [] });
    await expect(removeObjectsOrFail(storage, "documents", ["a", "b"])).resolves.toBeUndefined();
    expect(calls).toEqual(["remove:a,b", "exists:b"]);
  });

  it("throws, naming the object, when a path survives", async () => {
    const { storage } = fake({ removed: ["a"], present: ["b"] });
    await expect(removeObjectsOrFail(storage, "documents", ["a", "b"])).rejects.toThrow(
      "storage object survived removal: documents/b",
    );
  });

  it("throws when the API itself fails", async () => {
    const { storage } = fake({ removeError: "permission denied" });
    await expect(removeObjectsOrFail(storage, "documents", ["a"])).rejects.toThrow(
      "storage remove failed (documents): permission denied",
    );
  });

  it("throws when absence cannot be confirmed", async () => {
    const { storage } = fake({ removed: [], existsErrors: ["a"] });
    await expect(removeObjectsOrFail(storage, "documents", ["a"])).rejects.toThrow(
      "could not confirm removal of documents/a",
    );
  });

  it("does nothing for an empty list", async () => {
    const { storage, calls } = fake({});
    await removeObjectsOrFail(storage, "documents", []);
    expect(calls).toEqual([]);
  });
});

describe("removeObjectsBestEffort", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs a failure and swallows it — for cleanup after an action that already failed", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { storage } = fake({ removed: [], present: ["a"] });
    await expect(
      removeObjectsBestEffort(storage, "documents", ["a"], "test: cleanup"),
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledOnce();
    expect(String(err.mock.calls[0]![0])).toContain("test: cleanup");
  });
});

/**
 * THE BINDING. Every removal goes through this module, so the choice between
 * "must succeed" and "best effort" is made by name at each site, and no site
 * can go back to awaiting remove() and checking nothing.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("no call site removes storage objects on its own", () => {
  it("every storage.from(...).remove( in lib/ and app/ lives in lib/services/storage.ts", () => {
    const offenders: string[] = [];
    for (const dir of ["lib", "app"]) {
      for (const file of sourceFiles(join(root, dir))) {
        const rel = relative(root, file).replace(/\\/g, "/");
        if (rel === "lib/services/storage.ts") continue;
        const src = stripComments(readFileSync(file, "utf-8"));
        if (/\.from\(\s*["'][a-z_-]+["']\s*\)\s*\.remove\(/.test(src)) offenders.push(rel);
      }
    }
    expect(offenders, "use removeObjectsOrFail / removeObjectsBestEffort from lib/services/storage").toEqual([]);
  });
});
