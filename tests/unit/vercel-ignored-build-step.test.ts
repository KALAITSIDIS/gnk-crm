import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Vercel's Ignored Build Step, pinned to what it must and must not skip.
 *
 * WHY. The team's Functions Storage read 10.87 GB of the Hobby plan's 10 GB
 * on 2026-09-21, and Vercel's changelog of 2026-09-16 says a team over that
 * cap "can be blocked from deploying". The metric is the function bundles of
 * every deployment Vercel still holds — including the 30-day recovery period
 * after a deployment is deleted or expires — so the only levers are fewer
 * deployments and smaller bundles. On the day of the reading, 10 of the 30
 * retained gnk-crm deployments (a third) were the preview AND the production
 * build of a `docs/handoff-*` branch: an identical 22 MB bundle rebuilt
 * because HANDOFF.md changed. `ignoreCommand` in vercel.json stops exactly
 * those: it exits 0 (skip) when every changed file is under docs/ or is a
 * markdown file, and non-zero (build) for anything else.
 *
 * WHAT THIS TEST PROVES. It runs the command string from vercel.json — the
 * real tokens, not a re-typed copy — against throwaway git repositories, so
 * the dangerous edit (a pathspec that skips a CODE push) fails here before it
 * reaches Vercel. The command must stay anchored to `HEAD^ HEAD`: on a merge
 * commit that compares against the previous main, so a production deploy is
 * only ever skipped when the whole PR was docs; and on a repository with no
 * parent commit `git diff` exits 128, which is "build" — the safe default.
 *
 * Known gap, accepted: a branch pushed with several commits at once is judged
 * by its LAST commit only (Vercel's own documented example has the same
 * shape). That can skip a preview, never a production deploy.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const vercelJson = JSON.parse(readFileSync(join(root, "vercel.json"), "utf-8")) as {
  ignoreCommand?: string;
};

/**
 * Vercel runs the command through `sh -c`; here it is split into argv and run
 * WITHOUT a shell, so the same tokens are exercised on a Windows checkout and
 * on the Linux build container alike. The tokens are plain words and
 * single-quoted pathspecs — nothing a shell would expand.
 */
function argv(command: string): string[] {
  return command
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/^'(.*)'$/, "$1"));
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function commit(cwd: string, files: Record<string, string>, message: string): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), content);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
}

/** What Vercel would do at HEAD of `cwd`: exit 0 is "skip the build". */
function verdict(cwd: string): "skip" | "build" {
  const [cmd, ...args] = argv(vercelJson.ignoreCommand!);
  const r = spawnSync(cmd!, args, { cwd, encoding: "utf-8" });
  return r.status === 0 ? "skip" : "build";
}

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gnk-ignore-step-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

const BASE = {
  "app/page.tsx": "export default () => null;\n",
  "docs/10_INFRASTRUCTURE.md": "# infra\n",
  "docs/03_DATABASE_SCHEMA.sql": "-- schema copy\n",
  "HANDOFF.md": "# handoff\n",
  "supabase/migrations/0001_init.sql": "select 1;\n",
  "vercel.json": "{}\n",
};

describe("vercel.json ignoreCommand (the Ignored Build Step)", () => {
  const repos: string[] = [];
  afterAll(() => {
    for (const r of repos) rmSync(r, { recursive: true, force: true });
  });

  it("exists and is anchored to HEAD^ HEAD, the shape that judges a merge against the previous main", () => {
    expect(vercelJson.ignoreCommand, "vercel.json must carry ignoreCommand").toBeDefined();
    expect(vercelJson.ignoreCommand).toMatch(/^git diff --quiet HEAD\^ HEAD -- /);
  });

  describe("against a throwaway repository", () => {
    let repo: string;
    beforeAll(() => {
      repo = freshRepo();
      repos.push(repo);
      commit(repo, BASE, "base");
    });

    it("BUILDS when there is no parent commit (git exits 128 — the safe default)", () => {
      expect(verdict(repo)).toBe("build");
    });

    it("SKIPS a commit that only touches docs/ and root markdown", () => {
      commit(repo, { "docs/10_INFRASTRUCTURE.md": "# infra v2\n", "HANDOFF.md": "# handoff v2\n" }, "docs");
      expect(verdict(repo)).toBe("skip");
    });

    it("SKIPS nested markdown, non-markdown files under docs/, and markdown outside docs/", () => {
      commit(
        repo,
        {
          "docs/superpowers/specs/2026-09-21-x.md": "spec\n",
          "docs/03_DATABASE_SCHEMA.sql": "-- schema copy v2\n",
          "tests/README.md": "readme\n",
          "CLAUDE.md": "rules\n",
        },
        "more docs",
      );
      expect(verdict(repo)).toBe("skip");
    });

    it("BUILDS when a code file changes alongside docs", () => {
      commit(repo, { "app/page.tsx": "export default () => 1;\n", "HANDOFF.md": "# v3\n" }, "code+docs");
      expect(verdict(repo)).toBe("build");
    });

    it("BUILDS for a migration-only change (deliberately outside the skip list)", () => {
      commit(repo, { "supabase/migrations/0002_more.sql": "select 2;\n" }, "migration");
      expect(verdict(repo)).toBe("build");
    });

    it("BUILDS when vercel.json itself changes", () => {
      commit(repo, { "vercel.json": '{"regions":["fra1"]}\n' }, "vercel.json");
      expect(verdict(repo)).toBe("build");
    });
  });

  describe("on merge commits (what a production deploy sees)", () => {
    let repo: string;
    beforeAll(() => {
      repo = freshRepo();
      repos.push(repo);
      commit(repo, BASE, "base");
    });

    function mergeBranch(name: string, files: Record<string, string>): void {
      git(repo, "checkout", "-q", "-b", name);
      commit(repo, files, name);
      git(repo, "checkout", "-q", "main");
      git(repo, "merge", "-q", "--no-ff", "-m", `Merge ${name}`, name);
    }

    it("BUILDS the merge of a branch that changed code, even if its LAST commit was docs-only", () => {
      git(repo, "checkout", "-q", "-b", "feat/x");
      commit(repo, { "app/page.tsx": "export default () => 2;\n" }, "code");
      commit(repo, { "HANDOFF.md": "# after code\n" }, "docs on top");
      git(repo, "checkout", "-q", "main");
      git(repo, "merge", "-q", "--no-ff", "-m", "Merge feat/x", "feat/x");
      expect(verdict(repo)).toBe("build");
    });

    it("SKIPS the merge of a docs-only branch", () => {
      mergeBranch("docs/handoff-x", { "HANDOFF.md": "# recorded\n", "docs/DECISIONS.md": "decided\n" });
      expect(verdict(repo)).toBe("skip");
    });
  });
});
