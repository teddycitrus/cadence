import { z } from "zod";
import { define, type BoardTool } from "../agents/board-tools";
import type { Queries } from "../core/queries";
import type { PullRequestService } from "../git/pull-requests";
import type { WorkspaceService } from "../workspaces/service";
import type { CanvasRenderer, VrtResult } from "./render";
import type { CanvasService } from "./service";

export const VRT_MARKER = "cadence-visual-check";

const STATUS: Record<VrtResult["status"], string> = { pass: "unchanged", fail: "changed", new: "new (no baseline yet)", size_changed: "size changed", disabled: "not checked" };

/**
 * The visual check as a pull request comment: which frames changed
 * against their committed baselines, worst first.
 */
export function visualReport(canvases: { path: string; name: string; results: (VrtResult & { storyName: string })[] }[], branch: string | null): string {
  const all = canvases.flatMap((c) => c.results.map((r) => ({ ...r, canvas: c })));
  const changed = all.filter((r) => r.status === "fail" || r.status === "size_changed");
  const fresh = all.filter((r) => r.status === "new");
  const lines = [
    "### Visual check",
    "",
    changed.length
      ? `${changed.length} of ${all.length} frame${all.length === 1 ? "" : "s"} changed against their baselines${branch ? ` on \`${branch}\`` : ""}. Review them on the canvas, then accept the new baselines if the change is intended.`
      : `All ${all.length} frame${all.length === 1 ? "" : "s"} match their baselines${fresh.length ? `, except ${fresh.length} without a baseline yet` : ""}.`,
    "",
    "| Canvas | Frame | Result | Pixels changed |",
    "|---|---|---|---|",
  ];
  const rank = (r: VrtResult) => ({ size_changed: 0, fail: 1, new: 2, pass: 3, disabled: 4 })[r.status];
  for (const r of all.sort((a, b) => rank(a) - rank(b))) {
    lines.push(`| ${r.canvas.name} (\`${r.canvas.path}\`) | ${r.storyName} | ${STATUS[r.status]} | ${r.status === "fail" ? `${(r.diffRatio * 100).toFixed(2)}%` : "-"} |`);
  }
  if (!all.length) lines.push("| - | No frames | - | - |");
  return lines.join("\n");
}

export interface VisualDeps {
  workspaces: WorkspaceService;
  canvases: CanvasService;
  canvasRender: CanvasRenderer;
  prs: PullRequestService;
}

/** Runs the visual check on a workspace's canvases and reports it on the workspace's pull request. */
export async function postVisualsToPr(d: VisualDeps, workspaceId: string): Promise<{ url: string; updated: boolean; changed: number }> {
  const ws = d.workspaces.workspaceOrThrow(workspaceId);
  const canvases = [];
  for (const canvas of await d.canvases.list(workspaceId)) {
    const results = await d.canvasRender.checkCanvas(workspaceId, canvas.path);
    canvases.push({ path: canvas.path, name: canvas.name, results: results.map((r) => ({ ...r, storyName: canvas.storyboards.find((s) => s.id === r.storyId)?.name ?? r.storyId })) });
  }
  const r = await d.prs.comment(workspaceId, VRT_MARKER, visualReport(canvases, ws.branch));
  return { url: r.url, updated: r.updated, changed: canvases.flatMap((x) => x.results).filter((x) => x.status === "fail" || x.status === "size_changed").length };
}

/**
 * A pull request's visual check in one read: the cadence/visual-review status
 * from CI (or the latest local check), and the report comment's table.
 */
export function visualReviewStatusTool(d: () => Pick<VisualDeps, "prs">, q: Queries): BoardTool {
  return define({
    name: "visual_review_status",
    description: "Read a pull request's visual check: the cadence/visual-review commit status from CI and the report comment listing which frames changed. Defaults to this workspace's pull request; or pass an issue key or a PR number.",
    shape: { issue: z.string().optional(), pr: z.number().int().positive().optional() },
    run: async (a, ctx) => {
      const prs = d().prs;
      const issue = a.issue ? q.issue(a.issue) : null;
      if (a.issue && !issue) throw new Error(`Issue ${a.issue} not found`);
      const pr = a.pr ? q.pullRequests().find((p) => p.number === a.pr) : issue ? q.pullRequests().find((p) => p.issueId === issue.id) : ctx.workspaceId ? await prs.forWorkspace(ctx.workspaceId) : null;
      if (!pr) return "No pull request found.";
      await prs.refresh(pr.id).catch(() => undefined);
      const fresh = q.pullRequest(pr.id)!;
      const status = fresh.checkRuns.find((r) => r.name === "cadence/visual-review");
      const comment = await (await prs.api()).findComment(fresh.repo, fresh.number, VRT_MARKER);
      return [
        `#${fresh.number} ${fresh.title} (${fresh.url})`,
        `Visual check status: ${status ? `${status.conclusion ?? status.status}${status.url ? ` (${status.url})` : ""}` : "none yet (no CI run; canvas_post_visuals_to_pr posts a local check)"}`,
        comment ? `Report (updated ${comment.updatedAt.slice(0, 16).replace("T", " ")}):\n${comment.body}` : "No report comment yet.",
      ].join("\n");
    },
  });
}

/** The same report as an agent tool, for PR reviewers and builders. */
export function visualPrTool(d: () => VisualDeps): BoardTool {
  return define({
    name: "canvas_post_visuals_to_pr",
    description: "Run the visual check on every canvas in this workspace and post the result on its pull request (replacing the previous report). Use after UI changes once a PR is open.",
    shape: {},
    run: async (_a, ctx) => {
      if (!ctx.workspaceId) throw new Error("This works from a workspace chat");
      const r = await postVisualsToPr(d(), ctx.workspaceId);
      return `${r.updated ? "Updated" : "Posted"} the visual check on the pull request (${r.changed} frame${r.changed === 1 ? "" : "s"} changed): ${r.url}`;
    },
  });
}
