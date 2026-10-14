import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

// Small facts git keeps in plain files (the commit HEAD points at, the stash
// list), read directly: starting a git process costs far more than reading a
// file, on Windows especially. Each returns undefined when the layout is not
// the classic one (the reftable format, a missing or odd ref) so the caller
// asks git instead, and results always match git's.

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The repository's shared folder: a linked worktree's git folder names it in `commondir`. */
function commonDir(gitDir: string): string {
  try {
    const rel = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    return isAbsolute(rel) ? rel : resolve(gitDir, rel);
  } catch {
    return gitDir;
  }
}

const classic = (common: string) => !existsSync(join(common, "reftable"));

/** The commit a ref name points at, from its loose file or packed-refs. */
function resolveRef(gitDir: string, common: string, ref: string, depth = 0): string | null | undefined {
  if (depth > 5 || !/^refs\/[^\0\s]+$/.test(ref) || ref.includes("..")) return undefined;
  // Per-worktree refs (refs/bisect, refs/worktree) live in the worktree's own folder; the rest are shared.
  const own = /^refs\/(bisect|worktree|rewritten)\//.test(ref);
  try {
    const loose = readFileSync(join(own ? gitDir : common, ref), "utf8").trim();
    if (SHA.test(loose)) return loose;
    if (loose.startsWith("ref: ")) return resolveRef(gitDir, common, loose.slice(5).trim(), depth + 1);
    return undefined;
  } catch {
    // not loose: look in packed-refs
  }
  let packed: string;
  try {
    packed = readFileSync(join(common, "packed-refs"), "utf8");
  } catch {
    return null;
  }
  for (const line of packed.split("\n")) {
    if (line.endsWith(` ${ref}`) || line.endsWith(` ${ref}\r`)) {
      const sha = line.slice(0, line.indexOf(" "));
      return SHA.test(sha) ? sha : undefined;
    }
  }
  return null;
}

/** HEAD's commit; null for a branch with no commits yet; undefined to ask git. */
export function readHead(gitDir: string): string | null | undefined {
  const common = commonDir(gitDir);
  if (!classic(common)) return undefined;
  let head: string;
  try {
    head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return undefined;
  }
  if (SHA.test(head)) return head;
  if (!head.startsWith("ref: ")) return undefined;
  return resolveRef(gitDir, common, head.slice(5).trim());
}

/** Stash messages, newest first (as `git stash list --format=%gs`); undefined to ask git. */
export function readStashes(gitDir: string): string[] | undefined {
  const common = commonDir(gitDir);
  if (!classic(common)) return undefined;
  let log: string;
  try {
    log = readFileSync(join(common, "logs", "refs", "stash"), "utf8");
  } catch {
    // No reflog: no stashes, unless a stash ref exists anyway (then git knows better).
    return existsSync(join(common, "refs", "stash")) ? undefined : [];
  }
  // Each line is "<old> <new> <who> <when> <zone>\t<message>"; git lists the newest first.
  const entries = log.split("\n").filter(Boolean);
  const messages: string[] = [];
  for (const line of entries) {
    const tab = line.indexOf("\t");
    if (tab < 0) return undefined;
    messages.push(line.slice(tab + 1).replace(/\r$/, ""));
  }
  return messages.reverse();
}
