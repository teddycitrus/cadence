import { exec, execFile } from "node:child_process";

// What this machine needs for Cadence to build software: Node to run projects
// and their dev servers, Git for workspaces, and an AI model for agents, by
// signing in with an account or adding an API key (Cadence ships Claude Code,
// so nothing else needs installing for it).

export interface Requirement {
  id: "node" | "git" | "ai";
  label: string;
  required: boolean;
  installed: boolean;
  version: string | null;
  /** Why it matters, shown under the row. */
  why: string;
  installUrl: string;
}

const SPECS: Omit<Requirement, "installed" | "version">[] = [
  { id: "node", label: "Node.js", required: true, why: "Runs your projects, canvases, and dev servers.", installUrl: "https://nodejs.org/en/download" },
  { id: "git", label: "Git", required: true, why: "Each workspace is its own Git branch and worktree.", installUrl: "https://git-scm.com/downloads" },
  { id: "ai", label: "An AI model", required: true, why: "Sign in with your Claude account or add an API key; agents and chats run on it.", installUrl: "https://console.anthropic.com/settings/keys" },
];

/** Whether agents have a model to run on, and how (shown in place of a version). Null when none is set up. */
export type ModelAccess = () => Promise<string | null>;

/** Runs `<program> --version` and returns the first version number it prints, or null when it is missing. */
export type VersionProbe = (program: string) => Promise<string | null>;

export const probeVersion: VersionProbe = (program) =>
  new Promise((resolve) => {
    // On Windows the npm-installed CLIs are .cmd shims, which need a shell; the program name is a fixed constant here.
    // One command string when a shell is used (Node warns about separate arguments with a shell).
    const done = (err: Error | null, stdout: string | Buffer) => {
      if (err) return resolve(null);
      resolve(/\d+\.\d+(?:\.\d+)?/.exec(String(stdout))?.[0] ?? (String(stdout).trim().slice(0, 40) || null));
    };
    if (process.platform === "win32") exec(`${program} --version`, { timeout: 8000, windowsHide: true }, done);
    else execFile(program, ["--version"], { timeout: 8000 }, done);
  });

/** Checks each requirement in parallel. */
export async function checkRequirements(probe: VersionProbe = probeVersion, access: ModelAccess = async () => null): Promise<Requirement[]> {
  return Promise.all(
    SPECS.map(async (s) => {
      const version = s.id === "ai" ? await access() : await probe(s.id);
      return { ...s, installed: version !== null, version };
    }),
  );
}
