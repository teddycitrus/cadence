import type { PersonalScripts, Project, ProjectCommand } from "../core/types";

export type ScriptScope = "org" | "user";

const EMPTY: PersonalScripts = { setupScript: null, commands: [] };

export function personalScripts(project: Project, memberId: string | null): PersonalScripts {
  return (memberId && project.personal?.[memberId]) || EMPTY;
}

/** The shared and personal scripts one person sees for a project. */
export function scriptsFor(project: Project, memberId: string | null) {
  const mine = personalScripts(project, memberId);
  return { sharedPrep: project.setupScript, sharedCommands: project.commands, myPrep: mine.setupScript, myCommands: mine.commands };
}

/** The setup command for a new workspace: the shared script, then the person's own (`org && mine`). */
export function setupCommand(project: Project, memberId: string | null): string | null {
  const parts = [project.setupScript, personalScripts(project, memberId).setupScript].map((s) => s?.trim()).filter((s): s is string => Boolean(s));
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : parts.map((p) => `(${p})`).join(" && ");
}

/** Run commands for one person: shared ones first, then personal ones (a personal name wins). */
export function runCommandsFor(project: Project, memberId: string | null): (ProjectCommand & { scope: ScriptScope })[] {
  const mine = personalScripts(project, memberId).commands;
  const names = new Set(mine.map((c) => c.name));
  return [...project.commands.filter((c) => !names.has(c.name)).map((c) => ({ ...c, scope: "org" as const })), ...mine.map((c) => ({ ...c, scope: "user" as const }))];
}

/** Variables every project script gets: where the source checkout and the workspace live. */
export function scriptEnv(project: Project, workspacePath: string): Record<string, string> {
  return { CADENCE_SOURCE_PATH: project.path, CADENCE_WORKSPACE_PATH: workspacePath, CADENCE_PROJECT: project.name };
}

/** Inserts or replaces a named command, keeping the order. */
export function upsertCommand(list: ProjectCommand[], cmd: ProjectCommand): ProjectCommand[] {
  return list.some((c) => c.name === cmd.name) ? list.map((c) => (c.name === cmd.name ? cmd : c)) : [...list, cmd];
}

/** Snapshot copy of a project that keeps only the viewer's personal scripts. */
export function projectForViewer(project: Project, memberId: string | null): Project {
  const mine = memberId ? project.personal?.[memberId] : undefined;
  return { ...project, personal: mine ? { [memberId!]: mine } : {} };
}
