import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { git } from "./git";

// A new worktree starts at the base branch's last commit, so work that is only
// in the project folder (new, changed, or deleted files not yet committed)
// would be missing. This brings it along. The project folder is only read.

export interface CarryResult {
  copied: number;
  deleted: number;
  /** Why nothing was brought over, when it was too much. */
  skipped: string | null;
}

const MAX_FILES = 5000;
const MAX_BYTES = 200 * 1024 * 1024;

/** Copies the uncommitted state of `from` (a checkout) into `to` (a fresh worktree of the same repo). Ignored files stay behind. */
export async function carryUncommitted(from: string, to: string): Promise<CarryResult> {
  const out = await git(from, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], true);
  const fields = out.split("\0").filter(Boolean);
  const copy: string[] = [];
  const remove: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    // Renames and copies are followed by the original path.
    if (code[0] === "R" || code[0] === "C") {
      const old = fields[++i];
      if (code[0] === "R" && old) remove.push(old);
    }
    if (code.includes("D")) remove.push(path);
    else copy.push(path);
  }
  // Paths come from git, but are checked to stay inside each folder all the same.
  const inside = (root: string, rel: string) => {
    const full = resolve(root, rel);
    const r = relative(root, full);
    return r && !r.startsWith("..") && !isAbsolute(r) ? full : null;
  };
  let bytes = 0;
  const files: string[] = [];
  for (const rel of copy) {
    const src = inside(from, rel);
    if (!src || !existsSync(src)) continue;
    const st = statSync(src);
    if (!st.isFile()) continue;
    bytes += st.size;
    files.push(rel);
  }
  if (files.length > MAX_FILES || bytes > MAX_BYTES) {
    return { copied: 0, deleted: 0, skipped: `${files.length} files (${Math.round(bytes / 1024 / 1024)} MB) of uncommitted work is too much to copy; commit it so new workspaces start with it` };
  }
  for (const rel of files) {
    const dest = inside(to, rel);
    if (!dest) continue;
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(from, rel), dest);
  }
  let deleted = 0;
  for (const rel of remove) {
    const dest = inside(to, rel);
    if (dest && existsSync(dest)) {
      rmSync(dest, { force: true });
      deleted++;
    }
  }
  return { copied: files.length, deleted, skipped: null };
}
