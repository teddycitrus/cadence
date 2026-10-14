import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Checkpoints: the whole working copy (tracked, new, and deleted files; not
// ignored ones) as a git tree, taken when a message is sent. Restoring puts
// the files back exactly as they were. A private index is used, so the
// person's own staging area is never touched.

const exec = promisify(execFile);

async function git(dir: string, args: string[], index: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: dir, env: { ...process.env, GIT_INDEX_FILE: index }, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return stdout.trim();
}

const tempIndex = () => join(tmpdir(), `cadence-checkpoint-${randomUUID()}`);

/** The working copy as a tree id, or null when the folder is not a git work tree. */
export async function snapshotTree(dir: string): Promise<string | null> {
  const index = tempIndex();
  try {
    await git(dir, ["add", "-A", "."], index);
    return await git(dir, ["write-tree"], index);
  } catch {
    return null;
  } finally {
    rmSync(index, { force: true });
  }
}

/** Puts the working copy back to a checkpoint: changed files restored, files added since removed. */
export async function restoreTree(dir: string, tree: string): Promise<{ restored: number; removed: number }> {
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new Error("Not a checkpoint");
  const index = tempIndex();
  try {
    const wanted = new Set((await git(dir, ["ls-tree", "-r", "--name-only", "-z", tree], index)).split("\0").filter(Boolean));
    // What is there now (in a scratch index, so ignored files stay out of it).
    await git(dir, ["add", "-A", "."], index);
    const present = (await git(dir, ["ls-files", "-z"], index)).split("\0").filter(Boolean);
    let removed = 0;
    for (const p of present) {
      if (wanted.has(p)) continue;
      try {
        unlinkSync(join(dir, p));
        removed++;
      } catch {
        // already gone
      }
    }
    await git(dir, ["read-tree", tree], index);
    await git(dir, ["checkout-index", "-a", "-f"], index);
    return { restored: wanted.size, removed };
  } finally {
    rmSync(index, { force: true });
  }
}
