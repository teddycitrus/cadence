import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { define, type BoardTool, type ToolContext } from "../agents/board-tools";
import type { Queries } from "../core/queries";
import type { CanvasService } from "../canvas/service";
import type { WorkspaceService } from "../workspaces/service";
import { doctor, WORKFLOW_PATH, workflowYaml } from "./workflow";

const workspaceOf = (ctx: ToolContext) => {
  if (!ctx.workspaceId) throw new Error("Visual check setup works from a workspace session");
  return ctx.workspaceId;
};

/** Setting up visual check in CI: diagnose the setup, and write the workflow. */
export function visualReviewTools(canvases: CanvasService, workspaces: WorkspaceService, q: Queries): BoardTool[] {
  return [
    define({
      name: "visual_review_doctor",
      description: "Check this repository's visual check setup one layer at a time: the GitHub workflow, installable dependencies, tracked frames, committed baselines, and the GitHub side. Each row says ok, not ok, or cannot check (null), with the fix. Run it before visual_review_init.",
      shape: {},
      run: async (_a, ctx) => {
        const ws = workspaces.workspaceOrThrow(workspaceOf(ctx));
        const tracked = (await canvases.list(ws.id)).flatMap((c) => c.storyboards.filter((s) => s.vrt.enabled).map((s) => ({ path: c.path, storyId: s.id })));
        const project = ws.projectId ? q.project(ws.projectId) : null;
        const rows = doctor(ws.path, tracked, { repo: project?.githubRepo ?? null, variableSet: null });
        return rows.map((r) => `- ${r.ok === null ? "?" : r.ok ? "ok" : "NOT OK"} ${r.check}: ${r.detail}${!r.ok && r.fix ? ` (fix: ${r.fix})` : ""}`).join("\n");
      },
    }),
    define({
      name: "visual_review_init",
      description: `Write ${WORKFLOW_PATH}, the GitHub Actions workflow that captures tracked frames on every pull request, sets a cadence/visual-review status, and keeps one report comment updated. Never overwrites an existing file. Commit it with the baselines; then set the CADENCE_REPOSITORY repository variable.`,
      shape: {},
      run: (_a, ctx) => {
        const ws = workspaces.workspaceOrThrow(workspaceOf(ctx));
        const file = join(ws.path, WORKFLOW_PATH);
        if (existsSync(file)) return `${WORKFLOW_PATH} already exists; left it alone. Run visual_review_doctor to check it.`;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, workflowYaml(ws.path));
        return `Wrote ${WORKFLOW_PATH}. Next: commit it with .cadence/vrt, and set the repository variable CADENCE_REPOSITORY (owner/name of the Cadence repository) under Settings > Secrets and variables > Actions > Variables.`;
      },
    }),
  ];
}
