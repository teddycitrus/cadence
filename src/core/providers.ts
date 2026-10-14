// Agent harnesses Cadence can run chats and agents through. Shared with the
// web client, so no Node imports here.

import { ValidationError } from "./errors";

export const PROVIDER_IDS = ["claude-code", "codex", "cursor", "grok", "opencode"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** "native" runs through the Claude Agent SDK; "acp" speaks the Agent Client Protocol over stdio. */
  protocol: "native" | "acp";
  /** The command that starts the harness's ACP server. People can override it in Settings > Providers. */
  defaultCommand: string | null;
  /** The harness's own terminal UI resuming a session, for CLI mode. `{session}` is replaced. */
  defaultCliCommand: string | null;
  /** Environment variables a bring-your-own key goes into. */
  keyEnvs: string[];
  /** An OpenAI-compatible base URL can be set for this harness. */
  baseUrlEnv: string | null;
  /** Models known before the harness reports its own list. "default" lets the harness pick. */
  models: string[];
  install: string;
}

/** A harness as admins see it in Settings > Providers. Key values never leave the server. */
export interface ProviderStatus extends ProviderInfo {
  command: string | null;
  cliCommand: string | null;
  /** Which key and base-URL variables are set (names only). */
  envSet: string[];
  /** Per model: which variables override the harness-wide ones for chats on that model (names only). */
  modelEnvSet: Record<string, string[]>;
  models: string[];
  /** Whether the launch command's program was found on this machine. */
  installed: boolean;
}

/** What everyone may see about a harness: no commands or keys. */
export interface ProviderSummary {
  id: ProviderId;
  label: string;
  models: string[];
  installed: boolean;
}

export const CLAUDE_MODELS = ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-4-5"];

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    protocol: "native",
    defaultCommand: null,
    defaultCliCommand: null,
    keyEnvs: ["ANTHROPIC_API_KEY"],
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    models: CLAUDE_MODELS,
    install: "Cadence includes Claude Code; sign in with your Claude account or add an Anthropic key",
  },
  {
    id: "codex",
    label: "Codex",
    protocol: "acp",
    defaultCommand: "npx -y @agentclientprotocol/codex-acp",
    defaultCliCommand: "codex resume {session}",
    keyEnvs: ["OPENAI_API_KEY"],
    baseUrlEnv: "OPENAI_BASE_URL",
    models: ["default"],
    install: "Cadence starts Codex through npx (Node.js needed); sign in with your ChatGPT account or add an OpenAI key",
  },
  {
    id: "cursor",
    label: "Cursor",
    protocol: "acp",
    defaultCommand: "cursor-agent acp",
    defaultCliCommand: "cursor-agent --resume {session}",
    keyEnvs: ["CURSOR_API_KEY"],
    baseUrlEnv: null,
    models: ["default"],
    install: "Install the Cursor CLI (curl https://cursor.com/install -fsS | bash), then sign in here or add a Cursor key",
  },
  {
    id: "grok",
    label: "Grok",
    protocol: "acp",
    defaultCommand: "grok agent stdio",
    defaultCliCommand: "grok --resume {session}",
    keyEnvs: ["XAI_API_KEY"],
    baseUrlEnv: null,
    models: ["default"],
    install: "Install Grok Build (npm install -g @xai-official/grok, or the installer from x.ai/cli), then sign in here or add an xAI key",
  },
  {
    id: "opencode",
    label: "OpenCode",
    protocol: "acp",
    defaultCommand: "opencode acp",
    defaultCliCommand: "opencode --session {session}",
    keyEnvs: ["OPENCODE_API_KEY", "OPENROUTER_API_KEY"],
    baseUrlEnv: null,
    models: ["default"],
    install: "npm install -g opencode-ai, then sign in here or add a provider key",
  },
];

export const providerInfo = (id: string): ProviderInfo => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]!;

export const isProviderId = (id: string): id is ProviderId => (PROVIDER_IDS as readonly string[]).includes(id);

/** A model id a provider accepts: Claude ids for Claude Code, anything plain for the others. */
export function validModel(provider: string, model: string): boolean {
  if (provider === "claude-code") return /^claude-[a-z0-9-]+$/.test(model);
  // Some harnesses put the reasoning level in the id, like gpt-6-luna[high].
  return /^[A-Za-z0-9._:/@[\]-]{1,120}$/.test(model);
}

export function checkModel(provider: string, model: string): void {
  if (!validModel(provider, model)) throw new ValidationError(`"${model}" is not a ${providerInfo(provider).label} model`);
}

/**
 * Which harness and model something new runs on: what was asked for, else the
 * team's default harness. A harness other than the default starts on its own
 * default model, since another harness's model ids mean nothing to it.
 */
export function chooseHarness(settings: { defaultProvider?: ProviderId; defaultModel: string }, input: { provider?: string; model?: string }): { provider: ProviderId; model: string } {
  const fallback: ProviderId = settings.defaultProvider ?? "claude-code";
  const asked = input.provider ?? fallback;
  if (!isProviderId(asked)) throw new ValidationError(`Unknown provider "${asked}"`);
  const model = input.model ?? (asked === fallback ? settings.defaultModel : asked === "claude-code" ? CLAUDE_MODELS[0]! : "default");
  checkModel(asked, model);
  return { provider: asked, model };
}
