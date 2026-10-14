import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { AgentCommands } from "../core/agent-commands";
import type { Queries } from "../core/queries";
import { currentBranch, isGitRepo } from "../git/git";
import { define, type BoardTool } from "./board-tools";
import { actingMember } from "./tool-context";

/** Who and where an outside agent is: the organization, the person it acts for, the projects. */
export function hostTools(q: Queries, agents: AgentCommands, org: () => { id: string; name: string }): BoardTool[] {
  return [
    define({
      name: "cadence_whoami",
      description: "The Cadence organization this connection reaches, the person it acts for, their role, and the workspace it is bound to (if any). Call first when unsure where you are.",
      shape: {},
      run: (_a, ctx) => {
        const member = actingMember(q, ctx);
        const m = member ? q.member(member) : null;
        const ws = ctx.workspaceId ? q.workspace(ctx.workspaceId) : null;
        return [`Organization: ${org().name} (${org().id})`, `Acting for: ${m ? `${m.name} (${m.id === "me" ? "owner" : m.role})` : "nobody (system)"}`, ws ? `Workspace: ${ws.name} (id ${ws.id}${ws.branch ? `, branch ${ws.branch}` : ""})` : "Workspace: none (canvas tools need one; run from a workspace folder)"].join("\n");
      },
    }),
    define({
      name: "cadence_list_projects",
      description: "Projects (repositories) in this organization, with their local folder, base branch, GitHub repository, and open workspaces.",
      shape: {},
      run: () =>
        q
          .projects()
          .map((p) => {
            const ws = q.workspaces(false).filter((w) => w.projectId === p.id);
            return `- ${p.name} (id ${p.id}): ${p.path}, base ${p.baseBranch}${p.githubRepo ? `, GitHub ${p.githubRepo}` : ""}; ${ws.length} workspaces${ws.length ? `: ${ws.map((w) => `${w.name} (${w.id})`).join(", ")}` : ""}`;
          })
          .join("\n") || "No projects.",
    }),
    define({
      name: "cadence_register_project",
      description: "Add a local git repository on the Cadence host as a project (or return the one already registered for that folder). Owner and admins only.",
      shape: { path: z.string().min(1), name: z.string().min(1).max(100).optional(), github_repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional() },
      run: async (a, ctx) => {
        const member = actingMember(q, ctx);
        const role = member === "me" ? "owner" : member ? q.member(member)?.role : null;
        if (role !== "owner" && role !== "admin") throw new Error("Only the owner and admins can register projects");
        if (!isAbsolute(a.path)) throw new Error("Use an absolute path on the Cadence host");
        const path = resolve(a.path);
        const existing = q.projects().find((p) => resolve(p.path) === path);
        if (existing) return `Already registered as ${existing.name} (id ${existing.id}).`;
        if (!(await isGitRepo(path))) throw new Error(`${path} is not a git repository`);
        const p = agents.addProject({ name: a.name ?? path.replace(/^.*[\\/]/, ""), path, baseBranch: await currentBranch(path), githubRepo: a.github_repo ?? null });
        return `Registered ${p.name} (id ${p.id}).`;
      },
    }),
  ];
}
