import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { LlmGateway } from "../agents/llm";
import type { ChatRuntime } from "../agents/runtime";
import { VRT_MARKER, visualReport } from "../canvas/vrt-report";
import type { VrtResult } from "../canvas/render";
import { GitHubApi } from "../git/github";
import { createContainer } from "../server/container";

// Visual check in CI: render every tracked frame of a checked-out repo,
// compare each with its committed baseline (.cadence/vrt), and report the
// result on the pull request as a commit status and one updating comment.

export const STATUS_CONTEXT = "cadence/visual-review";

export interface CaptureReport {
  createdAt: string;
  canvases: { path: string; name: string; results: (VrtResult & { storyName: string })[] }[];
  /** Frames that changed or changed size against their baselines. */
  changed: number;
  /** Tracked frames with no baseline committed yet. */
  missing: number;
}

/** Visual check never runs agents; any attempt fails plainly. */
const noRuntime: ChatRuntime = {
  name: "none",
  start: () => {
    throw new Error("Visual check does not run agents");
  },
  complete: () => Promise.reject(new Error("Visual check does not run agents")),
};
const offline: LlmGateway = { configured: false, structured: async () => Promise.reject(new Error("offline")) };

/**
 * Renders and compares the repo's frames. Diff and current images are
 * copied into `outDir` (for the workflow to upload as an artifact).
 */
export async function captureRepo(root: string, outDir: string, opts: { canvases?: string[] } = {}): Promise<CaptureReport> {
  const repo = resolve(root);
  const data = mkdtempSync(join(tmpdir(), "cadence-visual-"));
  const c = createContainer({ dataDir: data, dbFile: ":memory:", runtime: noRuntime, llm: offline });
  try {
    const id = randomUUID();
    c.store.append({ aggregate: "workspace", type: "WorkspaceCreated", aggregateId: id, payload: { projectId: null, issueId: null, agentId: null, name: "visual check", branch: "ci", baseBranch: null, path: repo } }, "system");
    mkdirSync(outDir, { recursive: true });
    const report: CaptureReport = { createdAt: new Date().toISOString(), canvases: [], changed: 0, missing: 0 };
    for (const canvas of await c.canvases.list(id)) {
      if (opts.canvases?.length && !opts.canvases.includes(canvas.path)) continue;
      const results = await c.canvasRender.checkCanvas(id, canvas.path);
      for (const r of results) {
        for (const f of [r.currentFile, r.diffFile]) if (f && existsSync(f)) copyFileSync(f, join(outDir, basename(f)));
        if (r.status === "fail" || r.status === "size_changed") report.changed++;
        if (r.status === "new") report.missing++;
      }
      report.canvases.push({ path: canvas.path, name: canvas.name, results: results.filter((r) => r.status !== "disabled").map((r) => ({ ...r, currentFile: r.currentFile && basename(r.currentFile), diffFile: r.diffFile && basename(r.diffFile), storyName: canvas.storyboards.find((s) => s.id === r.storyId)?.name ?? r.storyId })) });
    }
    writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
    writeFileSync(join(outDir, "report.md"), visualReport(report.canvases, process.env.GITHUB_HEAD_REF || null));
    return report;
  } finally {
    await c.canvasDev.stopAll().catch(() => undefined);
    c.stop();
    c.db.close();
    rmSync(data, { recursive: true, force: true });
  }
}

/** The pull request a GitHub Actions run is for, from its event file. */
export function pullRequestFromEvent(env: NodeJS.ProcessEnv): { repo: string; number: number; sha: string } | null {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !env.GITHUB_EVENT_PATH || !existsSync(env.GITHUB_EVENT_PATH)) return null;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as { pull_request?: { number: number; head: { sha: string } } };
  return event.pull_request ? { repo, number: event.pull_request.number, sha: event.pull_request.head.sha } : null;
}

/** Sets the visual-review commit status and upserts the report comment on the pull request. */
export async function reportToGitHub(report: CaptureReport, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): Promise<{ state: "success" | "failure"; comment: string | null }> {
  const pr = pullRequestFromEvent(env);
  const token = env.GITHUB_TOKEN;
  if (!pr || !token) throw new Error("Run this in a pull_request workflow with GITHUB_TOKEN set");
  const gh = new GitHubApi(token, fetchImpl);
  const state = report.changed > 0 ? "failure" : "success";
  const runUrl = env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${pr.repo}/actions/runs/${env.GITHUB_RUN_ID}` : null;
  const all = report.canvases.reduce((n, c) => n + c.results.length, 0);
  const description = report.changed ? `${report.changed} of ${all} frames changed; review them, then accept new baselines` : `${all} frames match${report.missing ? `; ${report.missing} have no baseline yet` : ""}`;
  await gh.setStatus(pr.repo, pr.sha, { state, context: STATUS_CONTEXT, description, targetUrl: runUrl });
  const body = `${visualReport(report.canvases, env.GITHUB_HEAD_REF || null)}${runUrl ? `\n\nImages: [workflow run artifacts](${runUrl})` : ""}`;
  const comment = await gh.upsertComment(pr.repo, pr.number, VRT_MARKER, body);
  return { state, comment: comment.url };
}
