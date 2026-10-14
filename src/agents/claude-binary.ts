import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { findOnPath } from "../core/path-search";

// Which `claude` to run for sign-in and CLI mode: CADENCE_CLAUDE_CLI when set,
// else one installed on PATH (the person's own Claude Code), else the copy the
// Agent SDK ships with, so neither needs a separate install.

/** The Agent SDK's own Claude Code binary for this platform, or null. */
function bundled(): string | null {
  const require = createRequire(import.meta.url);
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  for (const pkg of [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}-musl`]) {
    try {
      const file = join(dirname(require.resolve(`${pkg}/package.json`)), exe);
      if (existsSync(file)) return file;
    } catch {
      // not installed for this platform
    }
  }
  return null;
}

export function claudeBinary(): string {
  return process.env.CADENCE_CLAUDE_CLI || findOnPath("claude") || bundled() || "claude";
}

export interface ClaudeAccount {
  loggedIn: boolean;
  /** "claude.ai" for a subscription, or how else it signs in (an API key, a cloud provider). */
  method: string | null;
  email: string | null;
  plan: string | null;
}

/** Who Claude Code is signed in as here (`claude auth status`), or null if that could not be read. */
export function claudeAccount(): Promise<ClaudeAccount | null> {
  return new Promise((resolve) => {
    execFile(claudeBinary(), ["auth", "status", "--json"], { timeout: 15_000, windowsHide: true, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(claudeBinary()) }, (_err, stdout) => {
      try {
        const s = JSON.parse(String(stdout)) as { loggedIn?: boolean; authMethod?: string; email?: string; subscriptionType?: string };
        resolve({ loggedIn: Boolean(s.loggedIn), method: s.authMethod ?? null, email: s.email ?? null, plan: s.subscriptionType ?? null });
      } catch {
        resolve(null);
      }
    });
  });
}
