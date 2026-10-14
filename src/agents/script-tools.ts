import { z } from "zod";
import type { AgentCommands } from "../core/agent-commands";
import type { Queries } from "../core/queries";
import type { Project } from "../core/types";
import { scriptsFor, upsertCommand } from "../projects/scripts";
import { define, type BoardTool } from "./board-tools";
import { actingMember as memberOf, projectFrom as projectOf } from "./tool-context";

const Scope = z.enum(["org", "user"]).optional().describe('"org" (shared with everyone, the default) or "user" (only the person you work for)');
const ProjectArg = z.string().optional().describe("Project name or id; defaults to this workspace's project");

/** Run-button commands and workspace prep commands, shared and personal. */
export function scriptTools(q: Queries, agents: AgentCommands): BoardTool[] {
  const write = (project: Project, scope: "org" | "user", member: string | null, patch: { setupScript?: string | null; commands?: Project["commands"] }) => {
    if (scope === "org") agents.updateProject(project.id, patch);
    else {
      if (!member) throw new Error("Personal scripts need a person; use scope org");
      agents.setPersonalScripts(project.id, member, patch);
    }
  };
  return [
    define({
      name: "scripts_list",
      description: "The project's Run-button commands and workspace prep commands: shared ones (sharedCommands, sharedPrep) and the ones private to the person you work for (myCommands, myPrep). New workspaces run the shared prep command, then the personal one, with CADENCE_SOURCE_PATH set to the source checkout.",
      shape: { project: ProjectArg },
      run: (a, ctx) => JSON.stringify(scriptsFor(projectOf(q, ctx, a.project), memberOf(q, ctx)), null, 2),
    }),
    define({
      name: "scripts_configure",
      description: "Add or replace a named Run-button command (build, test, lint, dev) for the project. Upserts by name in the chosen scope. Not for workspace setup; use scripts_set_setup for that.",
      shape: { name: z.string().regex(/^[a-z0-9_-]{1,32}$/).describe("Lowercase name, like test or dev"), command: z.string().min(1).max(500), scope: Scope, project: ProjectArg },
      run: (a, ctx) => {
        const project = projectOf(q, ctx, a.project);
        const member = memberOf(q, ctx);
        const scope = a.scope ?? "org";
        const current = scope === "org" ? project.commands : scriptsFor(project, member).myCommands;
        write(project, scope, member, { commands: upsertCommand(current, { name: a.name, command: a.command }) });
        return `Saved ${scope === "org" ? "shared" : "personal"} command ${a.name}.`;
      },
    }),
    define({
      name: "scripts_delete",
      description: "Remove a named Run-button command from the project.",
      shape: { name: z.string().min(1), scope: Scope, project: ProjectArg },
      run: (a, ctx) => {
        const project = projectOf(q, ctx, a.project);
        const member = memberOf(q, ctx);
        const scope = a.scope ?? "org";
        const current = scope === "org" ? project.commands : scriptsFor(project, member).myCommands;
        if (!current.some((c) => c.name === a.name)) throw new Error(`No ${scope === "org" ? "shared" : "personal"} command named ${a.name}`);
        write(project, scope, member, { commands: current.filter((c) => c.name !== a.name) });
        return `Removed command ${a.name}.`;
      },
    }),
    define({
      name: "scripts_set_setup",
      description: "Set the command that runs when a new workspace is created for this project (an empty command clears it). Typical: install dependencies, or link .env with `ln -sf $CADENCE_SOURCE_PATH/.env .env` (on Windows: `mklink .env %CADENCE_SOURCE_PATH%\\.env`).",
      shape: { command: z.string().max(2000), scope: Scope, project: ProjectArg },
      run: (a, ctx) => {
        const project = projectOf(q, ctx, a.project);
        write(project, a.scope ?? "org", memberOf(q, ctx), { setupScript: a.command.trim() || null });
        return a.command.trim() ? "Prep command saved." : "Prep command cleared.";
      },
    }),
  ];
}
