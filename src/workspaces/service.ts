import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors";
import type { EventStore } from "../core/event-store";
import type { Queries } from "../core/queries";
import type { Actor, Agent, Issue, Project, Workspace } from "../core/types";
import { carryUncommitted, type CarryResult } from "../git/carry-over";
import { addWorktree, currentBranch, aheadBehind, branchExists, changes, git, deleteBranch, diffAgainst, diffFile, freeBranchName, isGitRepo, removeWorktree, type FileChange } from "../git/git";
import { currentActor, memberIdOf } from "../auth/context";
import { scriptEnv, setupCommand } from "../projects/scripts";

export function slug(text: string, max = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, max);
}

export function issueBranch(issue: Issue): string {
  return `cadence/${issue.key.toLowerCase()}-${slug(issue.title)}`;
}

function runScript(script: string, cwd: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(script, { cwd, shell: true, windowsHide: true, env: { ...process.env, CI: "1", ...env } });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out = (out + d.toString()).slice(-4000)));
    child.stderr.on("data", (d: Buffer) => (out = (out + d.toString()).slice(-4000)));
    child.on("close", (code) => resolve(`Setup script exited with ${code}.\n${out}`.trim()));
    child.on("error", (err) => resolve(`Setup script failed to start: ${err.message}`));
  });
}

export interface WorkspaceStatus {
  branch: string | null;
  baseBranch: string | null;
  files: FileChange[];
  ahead: number;
  behind: number;
  onDisk: boolean;
}

/**
 * Workspaces are git worktrees, one branch each. An issue gets its own
 * workspace; people can open ad hoc ones; each agent has a home workspace
 * for runs that are not about an issue.
 */
export class WorkspaceService {
  private creating = new Map<string, Promise<Workspace>>();

  constructor(
    private store: EventStore,
    private q: Queries,
    private dataDir: string,
    private newId: () => string = randomUUID,
  ) {}

  workspaceOrThrow(id: string): Workspace {
    const ws = this.q.workspace(id);
    if (!ws) throw new NotFoundError(`Workspace ${id} not found`);
    return ws;
  }

  /** Variables for scripts and terminals in a workspace (source checkout, workspace path). */
  scriptEnvFor(ws: Workspace): Record<string, string> {
    const project = ws.projectId ? this.q.project(ws.projectId) : null;
    return project ? scriptEnv(project, ws.path) : {};
  }

  /** The person whose personal scripts apply: the actor, or an agent's owner. */
  private memberFor(actor: Actor): string | null {
    if (actor.startsWith("agent:")) return this.q.agent(actor.slice(6))?.ownerId ?? null;
    return memberIdOf(actor);
  }

  private projectFor(projectId: string | null): Project | null {
    if (projectId) {
      const p = this.q.project(projectId);
      if (!p) throw new NotFoundError(`Project ${projectId} not found`);
      return p;
    }
    const all = this.q.projects();
    return all.length === 1 ? all[0]! : null;
  }

  /** Serializes creation per key so two triggers cannot build the same worktree twice. */
  private once(key: string, fn: () => Promise<Workspace>): Promise<Workspace> {
    const pending = this.creating.get(key);
    if (pending) return pending;
    const p = fn().finally(() => this.creating.delete(key));
    this.creating.set(key, p);
    return p;
  }

  /** What each new workspace brought over from the project folder, until its creator reads it. */
  private carried = new Map<string, CarryResult>();

  /** Reads (once) what a new workspace brought over of the project folder's uncommitted work. */
  takeCarried(workspaceId: string): CarryResult | null {
    const r = this.carried.get(workspaceId) ?? null;
    this.carried.delete(workspaceId);
    return r;
  }

  private async create(input: { project: Project | null; issueId: string | null; agentId: string | null; name: string; branch: string | null; dirName: string; existingBranch?: boolean; carry?: boolean }, actor: Actor, log?: (m: string) => void): Promise<Workspace> {
    const id = this.newId();
    let carriedNow: CarryResult | null = null;
    let path: string;
    let branch = input.branch;
    if (input.project && branch) {
      if (!(await isGitRepo(input.project.path))) throw new ValidationError(`${input.project.path} is not a git repository`);
      path = join(this.dataDir, "worktrees", input.project.id, input.dirName);
      // A new workspace never adopts a branch that already exists (another board, a
      // teammate, an old run); opening a branch on purpose uses it as is.
      if (!input.existingBranch) branch = await freeBranchName(input.project.path, branch);
      await addWorktree(input.project.path, path, branch, input.project.baseBranch);
      // A person's new workspace starts with what they see in the project folder, uncommitted work included.
      // Agents' workspaces start from the last commit, so a pull request never sweeps up someone's local edits.
      if (input.carry && !input.existingBranch && (await currentBranch(input.project.path).catch(() => null)) === input.project.baseBranch) {
        carriedNow = await carryUncommitted(input.project.path, path);
      }
      const setup = setupCommand(input.project, this.memberFor(actor));
      if (setup) {
        // Evaluated first: `log?.(await ...)` would skip the script when there is no logger.
        const out = await runScript(setup, path, scriptEnv(input.project, path));
        log?.(out);
      }
    } else {
      path = join(this.dataDir, "scratch", input.dirName);
      mkdirSync(path, { recursive: true });
    }
    this.store.append(
      {
        aggregate: "workspace",
        type: "WorkspaceCreated",
        aggregateId: id,
        payload: { projectId: input.project?.id ?? null, issueId: input.issueId, agentId: input.agentId, name: input.name, branch, baseBranch: input.project?.baseBranch ?? null, path },
      },
      actor,
    );
    if (carriedNow && (carriedNow.copied || carriedNow.deleted || carriedNow.skipped)) this.carried.set(id, carriedNow);
    return this.workspaceOrThrow(id);
  }

  /** The issue's workspace, created on first use (or restored if archived). */
  forIssue(issue: Issue, actor: Actor, log?: (m: string) => void): Promise<Workspace> {
    return this.once(`issue:${issue.id}`, async () => {
      const existing = this.q.workspacesForIssue(issue.id)[0];
      if (existing) {
        if (existing.archived) await this.restore(existing.id, actor);
        else await this.ensureOnDisk(existing);
        return this.workspaceOrThrow(existing.id);
      }
      const project = this.projectFor(issue.projectId);
      const branch = project ? issueBranch(issue) : null;
      return this.create({ project, issueId: issue.id, agentId: null, name: `${issue.key} ${issue.title}`, branch, dirName: issue.key }, actor, log);
    });
  }

  /** Where an agent works when a run is not about a specific issue. */
  homeForAgent(agent: Agent, actor: Actor, log?: (m: string) => void): Promise<Workspace> {
    return this.once(`agent:${agent.id}`, async () => {
      const existing = this.q.workspaces(false).find((w) => w.agentId === agent.id && !w.issueId);
      if (existing) {
        await this.ensureOnDisk(existing);
        return existing;
      }
      const project = this.projectFor(agent.projectId);
      const branch = project ? `cadence/agent-${slug(agent.name, 30)}` : null;
      return this.create({ project, issueId: null, agentId: agent.id, name: `${agent.name} home`, branch, dirName: `agent-${slug(agent.name, 30)}-${agent.id.slice(0, 6)}` }, actor, log);
    });
  }

  /**
   * A workspace on an existing branch of a project: the live one if there is
   * one, else a new worktree for it. The base branch is checked out in the
   * project folder itself, so work on it starts a fresh branch from it.
   */
  forBranch(projectId: string, branch: string, actor: Actor): Promise<Workspace> {
    return this.once(`branch:${projectId}:${branch}`, async () => {
      const project = this.projectFor(projectId);
      if (!project) throw new NotFoundError("Project not found");
      if (branch === project.baseBranch) return this.createInProject(project.id, `${branch} canvases`, actor);
      if (!(await branchExists(project.path, branch))) throw new NotFoundError(`Branch ${branch} not found`);
      const existing = this.q.workspaces(true).find((w) => w.projectId === project.id && w.branch === branch);
      if (existing) {
        if (existing.archived) await this.restore(existing.id, actor);
        else await this.ensureOnDisk(existing);
        return this.workspaceOrThrow(existing.id);
      }
      return this.create({ project, issueId: null, agentId: null, name: branch, branch, existingBranch: true, dirName: `${slug(branch, 30) || "branch"}-${randomBytes(2).toString("hex")}` }, actor);
    });
  }

  /** A new ad hoc workspace on a fresh branch. */
  async createInProject(projectId: string | null, name: string, actor: Actor): Promise<Workspace> {
    const project = this.projectFor(projectId);
    const suffix = randomBytes(2).toString("hex");
    const branch = project ? `cadence/${slug(name, 30) || "workspace"}-${suffix}` : null;
    const person = actor === "user" || actor.startsWith("member:");
    return this.create({ project, issueId: null, agentId: null, name, branch, dirName: `${slug(name, 30) || "workspace"}-${suffix}`, carry: person }, actor);
  }

  async ensureOnDisk(ws: Workspace): Promise<void> {
    if (existsSync(ws.path)) return;
    const project = ws.projectId ? this.q.project(ws.projectId) : null;
    if (project && ws.branch) await addWorktree(project.path, ws.path, ws.branch, ws.baseBranch ?? project.baseBranch);
    else mkdirSync(ws.path, { recursive: true });
  }

  update(id: string, patch: { name?: string; pinned?: boolean }, actor: Actor = currentActor()): Workspace {
    this.workspaceOrThrow(id);
    this.store.append({ aggregate: "workspace", type: "WorkspaceUpdated", aggregateId: id, payload: patch }, actor);
    return this.workspaceOrThrow(id);
  }

  private assertIdle(ws: Workspace): void {
    if (this.q.chatsForWorkspace(ws.id).some((c) => c.status === "running" || c.status === "waiting")) {
      throw new ConflictError("A chat in this workspace is still running; stop it first");
    }
  }

  /** Removes the worktree from disk but keeps the branch, so it can be restored. */
  async archive(id: string, actor: Actor = currentActor()): Promise<void> {
    const ws = this.workspaceOrThrow(id);
    this.assertIdle(ws);
    const project = ws.projectId ? this.q.project(ws.projectId) : null;
    if (project && ws.branch) await removeWorktree(project.path, ws.path);
    this.store.append({ aggregate: "workspace", type: "WorkspaceArchived", aggregateId: id, payload: {} }, actor);
  }

  async restore(id: string, actor: Actor = currentActor()): Promise<void> {
    const ws = this.workspaceOrThrow(id);
    await this.ensureOnDisk(ws);
    this.store.append({ aggregate: "workspace", type: "WorkspaceRestored", aggregateId: id, payload: {} }, actor);
  }

  /** Permanently removes the worktree, and the branch if asked. */
  async remove(id: string, deleteBranchToo: boolean, actor: Actor = currentActor()): Promise<void> {
    const ws = this.workspaceOrThrow(id);
    this.assertIdle(ws);
    const project = ws.projectId ? this.q.project(ws.projectId) : null;
    if (project && ws.branch) {
      await removeWorktree(project.path, ws.path);
      if (deleteBranchToo) await deleteBranch(project.path, ws.branch);
    }
    this.store.append({ aggregate: "workspace", type: "WorkspaceDeleted", aggregateId: id, payload: {} }, actor);
  }

  /** A ref to compare with instead of the base branch, if it names a real commit. */
  private async against(ws: Workspace, ref?: string): Promise<string | null> {
    if (!ref) return ws.baseBranch;
    if (!/^[\w./-]{1,200}$/.test(ref) || ref.startsWith("-") || ref.includes("..")) throw new ValidationError(`Invalid branch "${ref}"`);
    if (!(await git(ws.path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], true))) throw new ValidationError(`No branch or commit named "${ref}"`);
    return ref;
  }

  async status(id: string, ref?: string): Promise<WorkspaceStatus> {
    const ws = this.workspaceOrThrow(id);
    const onDisk = existsSync(ws.path);
    if (!onDisk || !ws.branch) return { branch: ws.branch, baseBranch: ws.baseBranch, files: [], ahead: 0, behind: 0, onDisk };
    const base = await this.against(ws, ref);
    const [files, counts] = await Promise.all([changes(ws.path, base), base ? aheadBehind(ws.path, base) : Promise.resolve({ ahead: 0, behind: 0 })]);
    return { branch: ws.branch, baseBranch: base, files, ...counts, onDisk };
  }

  async diff(id: string, path?: string, ref?: string): Promise<string> {
    const ws = this.workspaceOrThrow(id);
    if (!existsSync(ws.path) || !ws.branch) return "";
    const base = await this.against(ws, ref);
    if (path) {
      if (path.includes("..")) throw new ValidationError("Invalid path");
      return diffFile(ws.path, base, path);
    }
    return base ? diffAgainst(ws.path, base) : "";
  }
}
