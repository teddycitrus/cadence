import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ValidationError } from "../core/errors";
import { git } from "../git/git";
import { starterFiles, type StarterKind } from "./templates";

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "project";

/** A folder under `parent` named after `name`, not yet taken. */
function freeDir(parent: string, name: string): string {
  mkdirSync(parent, { recursive: true });
  let dir = join(parent, slugify(name));
  for (let n = 2; existsSync(dir); n++) dir = join(parent, `${slugify(name)}-${n}`);
  return dir;
}

/** git URLs Cadence will clone: https, ssh, scp-style (git@host:owner/repo), or file:// for local mirrors. */
const GIT_URL = /^(https:\/\/[\w.-]+(:\d+)?\/[\w./~-]+|ssh:\/\/[\w.@-]+(:\d+)?\/[\w./~-]+|[\w.-]+@[\w.-]+:[\w./~-]+|file:\/\/\/[\w./:~ -]+)$/;

/** The repository's name from its URL (owner/repo.git -> repo). */
export function repoName(url: string): string {
  return basename(url.replace(/\/+$/, "").replace(/\.git$/, "").replace(/^.*:/, "")) || "repository";
}

/**
 * Clones a repository into the data dir's repos folder for a new project.
 * Prompts are off, so a private repo without credentials fails quickly
 * instead of waiting for a password.
 */
export async function cloneRepo(reposDir: string, url: string, name?: string): Promise<string> {
  const clean = url.trim();
  if (!GIT_URL.test(clean) || clean.startsWith("-")) throw new ValidationError("Use an https or ssh git URL, like https://github.com/owner/repo.git");
  const dir = freeDir(reposDir, name || repoName(clean));
  await new Promise<void>((resolve, reject) => {
    let err = "";
    const child = spawn("git", ["clone", "--", clean, dir], { cwd: dirname(dir), env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }, windowsHide: true });
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    child.on("error", (e) => reject(new ValidationError(`git is not available: ${e.message}`)));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new ValidationError(`Could not clone ${clean}: ${err.trim().split("\n").at(-1) ?? "git failed"}`))));
  });
  return dir;
}

/** Runs a command and resolves with its output, or rejects with the last lines of it. */
function run(command: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = "";
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    child.stdout.on("data", (d: Buffer) => (out = (out + d.toString()).slice(-4000)));
    child.stderr.on("data", (d: Buffer) => (out = (out + d.toString()).slice(-4000)));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new ValidationError(`${command} failed: ${out.trim().split("\n").slice(-4).join("\n")}`))));
  });
}

/**
 * A new git repository for the Generate page: starter files for the kind of
 * project, one commit on main, and (for prototypes) dependencies installed.
 */
export async function scaffoldProject(projectsDir: string, kind: StarterKind, name: string, opts: { install?: boolean } = {}): Promise<string> {
  const dir = freeDir(projectsDir, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(starterFiles(kind, name))) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "user.name=Cadence", "-c", "user.email=cadence@local", "commit", "-q", "-m", `Start ${name}`]);
  if (kind === "prototype" && opts.install !== false) await run("npm install --no-audit --no-fund", dir);
  return dir;
}

/** The folder has files but no repository; the person can choose to start one there. */
export class NotGitError extends ValidationError {}

/**
 * A folder as a project: the repository it is in (its top level), or a new
 * one. An empty folder is started right away; one with files only when asked
 * (`initialize`), since everything in it gets committed.
 */
export async function openFolder(path: string, opts: { initialize?: boolean } = {}): Promise<{ path: string; initialized: boolean }> {
  if (!existsSync(path)) throw new ValidationError(`${path} does not exist`);
  const top = await git(path, ["rev-parse", "--show-toplevel"], true);
  if (top) return { path: resolve(top), initialized: false };
  if (readdirSync(path).length > 0 && !opts.initialize) throw new NotGitError(`${path} is not a git repository yet`);
  await git(path, ["init", "-q", "-b", "main"]);
  if (!existsSync(join(path, ".gitignore"))) writeFileSync(join(path, ".gitignore"), "node_modules\n.env\n.env.*\n");
  await git(path, ["add", "-A"]);
  await git(path, ["-c", "user.name=Cadence", "-c", "user.email=cadence@local", "commit", "-q", "--allow-empty", "-m", "Start project"]);
  return { path, initialized: true };
}
