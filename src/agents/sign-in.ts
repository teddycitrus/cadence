import { findOnPath } from "../core/path-search";
import type { ProviderId } from "../core/providers";
import { claudeBinary } from "./claude-binary";

// How each harness signs in with a person's own account (a Claude or ChatGPT
// subscription, a Cursor or xAI login), run in a terminal inside Cadence. API
// keys are the other way in, entered in Settings > Providers.

export interface SignInCommand {
  file: string;
  args: string[];
  title: string;
}

/** The program and arguments that start a harness's own sign-in, or null when it has none here. */
export function signInCommand(id: ProviderId): SignInCommand | null {
  switch (id) {
    case "claude-code":
      return { file: claudeBinary(), args: ["auth", "login"], title: "Sign in to Claude" };
    case "codex":
      // codex-acp runs through npx; the Codex CLI's login is there too when it is not installed.
      return findOnPath("codex") ? { file: "codex", args: ["login"], title: "Sign in to Codex" } : { file: "npx", args: ["-y", "@openai/codex", "login"], title: "Sign in to Codex" };
    case "cursor":
      return findOnPath("cursor-agent") ? { file: "cursor-agent", args: ["login"], title: "Sign in to Cursor" } : null;
    case "grok":
      // Grok Build signs in on its first run.
      return findOnPath("grok") ? { file: "grok", args: [], title: "Sign in to Grok" } : null;
    case "opencode":
      return findOnPath("opencode") ? { file: "opencode", args: ["auth", "login"], title: "Sign in to OpenCode" } : null;
  }
}
