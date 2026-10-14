import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeTempDir } from "./temp-dir";

export interface GitFixture {
  root: string;
  repo: string;
  dataDir: string;
  cleanup(): void;
}

/** Creates a throwaway git repo with one commit on main. */
export function createGitFixture(files: Record<string, string> = { "README.md": "# demo\n", "src/math.js": "export const add = (a, b) => a - b;\n" }): GitFixture {
  const root = mkdtempSync(join(tmpdir(), "cadence-test-"));
  const repo = join(root, "repo");
  const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "pipe" });
  // Keep checkouts byte-for-byte on Windows too.
  run("config", "core.autocrlf", "false");
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  run("add", "-A");
  run("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "initial");
  return {
    root,
    repo,
    dataDir: join(root, "data"),
    cleanup: () => removeTempDir(root),
  };
}

export function gitOut(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}
