import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { ValidationError } from "../core/errors";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { git } from "../git/git";

const exec = promisify(execFile);

// The workspace's files, for the Files tab: a tree from git (tracked and new,
// minus ignored), and reading and writing one file at a time.

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface FileContent {
  path: string;
  /** Null for binary or oversized files, which the editor does not open. */
  text: string | null;
  size: number;
  reason: "binary" | "too_large" | null;
}

/** A path inside the workspace, never into .git or node_modules, and never through a link that leaves it. */
export function resolveIn(root: string, rel: string): { full: string; clean: string } {
  const clean = normalize(rel.replace(/\\/g, "/")).split(sep).join("/").replace(/^\.\//, "");
  const parts = clean.split("/");
  if (!rel.trim() || clean === "." || clean.startsWith("..") || clean.startsWith("/") || /^[a-zA-Z]:/.test(clean) || parts.includes("..") || parts.includes(".git") || parts.includes("node_modules")) {
    throw new ValidationError(`Invalid path "${rel}"`);
  }
  const full = join(root, clean);
  // The deepest part that exists must still be inside the workspace once links are followed.
  let probe = full;
  while (!existsSync(probe) && probe !== root) probe = dirname(probe);
  const real = realpathSync(probe);
  const realRoot = realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new ValidationError(`"${rel}" leads outside the workspace`);
  return { full, clean };
}

const IMAGE = /(?:^|\/)(?:public|static)\/(.+\.(?:png|jpe?g|gif|webp|avif|svg))$/i;

/**
 * Images the app serves from its root (a public/ or static/ folder, also in
 * nested packages), as the URLs a CSS fill uses, with the repo path.
 */
export async function listImages(root: string): Promise<{ url: string; path: string }[]> {
  return (await listFiles(root)).flatMap((path) => {
    const m = IMAGE.exec(path);
    return m && !path.includes("node_modules/") ? [{ url: `/${m[1]}`, path }] : [];
  }).slice(0, 500);
}

export async function listFiles(root: string): Promise<string[]> {
  const out = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard"], true);
  // ls-files keeps deleted-but-tracked files until they are staged; hide them.
  return out
    .split("\n")
    .filter((p) => p && !p.split("/").includes("node_modules") && existsSync(join(root, p)))
    .sort();
}

const looksBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

export function readWorkspaceFile(root: string, rel: string): FileContent {
  const { full, clean } = resolveIn(root, rel);
  if (!existsSync(full) || !statSync(full).isFile()) throw new ValidationError(`${clean} not found`);
  const size = statSync(full).size;
  if (size > MAX_FILE_BYTES) return { path: clean, text: null, size, reason: "too_large" };
  const buf = readFileSync(full);
  if (looksBinary(buf)) return { path: clean, text: null, size, reason: "binary" };
  return { path: clean, text: buf.toString("utf8"), size, reason: null };
}

export function writeWorkspaceFile(root: string, rel: string, text: string, o: { create?: boolean } = {}): FileContent {
  const { full, clean } = resolveIn(root, rel);
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new ValidationError("File is too large to save from the editor");
  if (o.create && existsSync(full)) throw new ValidationError(`${clean} already exists`);
  if (!o.create && !existsSync(full)) throw new ValidationError(`${clean} not found`);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  return { path: clean, text, size: Buffer.byteLength(text), reason: null };
}

export function renameWorkspaceFile(root: string, from: string, to: string): string {
  const a = resolveIn(root, from);
  const b = resolveIn(root, to);
  if (!existsSync(a.full)) throw new ValidationError(`${a.clean} not found`);
  if (existsSync(b.full)) throw new ValidationError(`${b.clean} already exists`);
  mkdirSync(dirname(b.full), { recursive: true });
  renameSync(a.full, b.full);
  return relative(root, b.full).split(sep).join("/");
}

export function deleteWorkspaceFile(root: string, rel: string): void {
  const { full, clean } = resolveIn(root, rel);
  if (!existsSync(full) || !statSync(full).isFile()) throw new ValidationError(`${clean} not found`);
  rmSync(full);
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/** Text search across the workspace (tracked and new files, not ignored ones), like an editor's find in files. */
export async function searchFiles(root: string, query: string, o: { regex?: boolean; word?: boolean; matchCase?: boolean } = {}): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  if (!query) return { hits: [], truncated: false };
  // Perl-style regexes (\w, \d, lookarounds) like an editor's; plain POSIX ones where git lacks PCRE.
  const run = (mode: string) => exec("git", ["grep", "--untracked", "-n", "-I", "--no-color", "--max-count=50", mode, ...(o.word ? ["-w"] : []), ...(o.matchCase ? [] : ["-i"]), "-e", query, "--", ".", ":!node_modules"], { cwd: root, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  let out = "";
  try {
    out = (await run(o.regex ? "-P" : "-F")).stdout;
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    if (o.regex && /perl|pcre/i.test(e.stderr ?? "")) out = await run("-E").then((r) => r.stdout, (e2: { stdout?: string }) => e2.stdout ?? "");
    else if (e.code === 1) out = "";
    else throw new ValidationError(`Search failed: ${(e.stderr ?? "").trim().slice(0, 200) || "invalid pattern"}`);
  }
  const hits: SearchHit[] = [];
  for (const row of out.split("\n")) {
    const m = /^(.+?):(\d+):(.*)$/.exec(row);
    if (!m) continue;
    hits.push({ path: m[1]!, line: Number(m[2]), text: m[3]!.slice(0, 300) });
    if (hits.length >= 500) return { hits, truncated: true };
  }
  return { hits, truncated: false };
}
