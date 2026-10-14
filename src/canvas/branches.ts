import { git } from "../git/git";
import type { Project } from "../core/types";
import { parseCanvas, type CanvasFile } from "./parse";

// Canvases on project branches that have no live workspace, read straight
// from git, so the canvas home shows every branch's designs without checking
// anything out.

const CANVAS_FILE = /\.canvas\.(tsx|jsx|ts|js)$/;
const MAX_BRANCHES = 40;

export interface BranchCanvas extends CanvasFile {
  path: string;
  projectId: string;
  branch: string;
  updatedAt: string | null;
}

export async function branchCanvases(project: Project, skip: Set<string>): Promise<BranchCanvas[]> {
  const refs = await git(project.path, ["for-each-ref", "--sort=-committerdate", `--count=${MAX_BRANCHES}`, "--format=%(refname:short)%09%(committerdate:iso-strict)", "refs/heads"], true);
  const out: BranchCanvas[] = [];
  for (const line of refs.split("\n")) {
    const [branch, date] = line.split("\t");
    if (!branch || skip.has(branch)) continue;
    const files = (await git(project.path, ["ls-tree", "-r", "--name-only", branch], true)).split("\n").filter((p) => CANVAS_FILE.test(p) && !p.split("/").includes("node_modules"));
    for (const path of files) {
      const source = await git(project.path, ["show", `${branch}:${path}`], true);
      if (!source) continue;
      out.push({ ...parseCanvas(source, path), path, projectId: project.id, branch, updatedAt: date ?? null });
    }
  }
  return out;
}
