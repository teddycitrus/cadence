import { PROVIDERS, providerInfo, type ProviderId, type ProviderStatus, type ProviderSummary } from "../core/providers";
import type { SecretStore } from "../integrations/secrets";
import { findOnPath } from "../core/path-search";

export interface ProviderSettings {
  /** Overrides the harness's default launch command. */
  command: string | null;
  cliCommand: string | null;
  /** Env var name to value: bring-your-own keys and base URLs. Values never leave the server. */
  env: Record<string, string>;
  /** Keys for one model only (model id to env var to value), layered over `env` for chats on that model. */
  modelEnv: Record<string, Record<string, string>>;
  /** Models the harness reported the last time it ran. */
  models: string[];
}

export type { ProviderStatus } from "../core/providers";

const KEY = (id: string) => `provider:${id}`;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Splits a command line into program and arguments, honoring double quotes. */
export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  let started = false;
  for (const ch of command.trim()) {
    if (ch === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (started) parts.push(cur);
      cur = "";
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) parts.push(cur);
  return parts;
}

const pathCache = new Map<string, { found: boolean; at: number }>();

/** Whether a program is on PATH, remembered for a minute (the snapshot asks often). */
function onPath(program: string): boolean {
  if (/[\\/]/.test(program)) return true;
  const hit = pathCache.get(program);
  if (hit && Date.now() - hit.at < 60_000) return hit.found;
  const found = probe(program);
  pathCache.set(program, { found, at: Date.now() });
  return found;
}

/** Searched in-process; see core/path-search.ts. */
function probe(program: string): boolean {
  return findOnPath(program) !== null;
}

/**
 * Per-harness settings: launch command overrides and bring-your-own keys,
 * kept in the data dir's secret store rather than the event log.
 */
export class ProviderRegistry {
  constructor(private secrets: SecretStore) {}

  settings(id: ProviderId): ProviderSettings {
    const raw = this.secrets.get(KEY(id));
    const parsed = raw ? (JSON.parse(raw) as Partial<ProviderSettings>) : {};
    return { command: parsed.command ?? null, cliCommand: parsed.cliCommand ?? null, env: parsed.env ?? {}, modelEnv: parsed.modelEnv ?? {}, models: parsed.models ?? [] };
  }

  private save(id: ProviderId, s: ProviderSettings): void {
    this.secrets.set(KEY(id), JSON.stringify(s));
  }

  /** Updates a harness's settings. An env value of null removes that variable. */
  update(id: ProviderId, patch: { command?: string | null; cliCommand?: string | null; env?: Record<string, string | null>; modelEnv?: Record<string, Record<string, string | null>> }): ProviderStatus {
    const s = this.settings(id);
    if (patch.command !== undefined) s.command = patch.command?.trim() || null;
    if (patch.cliCommand !== undefined) s.cliCommand = patch.cliCommand?.trim() || null;
    for (const [name, value] of Object.entries(patch.env ?? {})) {
      if (!ENV_NAME.test(name)) throw new Error(`"${name}" is not an environment variable name`);
      if (value) s.env[name] = value;
      else delete s.env[name];
    }
    for (const [model, vars] of Object.entries(patch.modelEnv ?? {})) {
      const entry = { ...(s.modelEnv[model] ?? {}) };
      for (const [name, value] of Object.entries(vars)) {
        if (!ENV_NAME.test(name)) throw new Error(`"${name}" is not an environment variable name`);
        if (value) entry[name] = value;
        else delete entry[name];
      }
      if (Object.keys(entry).length) s.modelEnv[model] = entry;
      else delete s.modelEnv[model];
    }
    this.save(id, s);
    return this.status(id);
  }

  rememberModels(id: ProviderId, reported: string[]): void {
    // gpt-6-luna[low] .. [max] are one model; the chat's effort picks the level.
    const models = [...new Set(reported.map((m) => m.replace(/\[.+\]$/, "")))];
    const s = this.settings(id);
    if (JSON.stringify(s.models) === JSON.stringify(models)) return;
    this.save(id, { ...s, models });
  }

  command(id: ProviderId): string | null {
    return this.settings(id).command ?? providerInfo(id).defaultCommand;
  }

  cliCommand(id: ProviderId): string | null {
    return this.settings(id).cliCommand ?? providerInfo(id).defaultCliCommand;
  }

  /** The process environment for the harness: this server's, plus the saved keys, plus the model's own keys. */
  env(id: ProviderId, model?: string): NodeJS.ProcessEnv {
    const s = this.settings(id);
    return { ...process.env, ...s.env, ...(model ? s.modelEnv[model] : undefined) };
  }

  status(id: ProviderId): ProviderStatus {
    const info = providerInfo(id);
    const s = this.settings(id);
    const command = this.command(id);
    const program = command ? splitCommand(command)[0] : null;
    return {
      ...info,
      command,
      cliCommand: this.cliCommand(id),
      envSet: Object.keys(s.env),
      modelEnvSet: Object.fromEntries(Object.entries(s.modelEnv).map(([m, vars]) => [m, Object.keys(vars)])),
      models: [...new Set([...info.models, ...s.models])],
      installed: info.protocol === "native" ? true : Boolean(program && onPath(program)),
    };
  }

  all(): ProviderStatus[] {
    return PROVIDERS.map((p) => this.status(p.id));
  }

  summaries(): ProviderSummary[] {
    return this.all().map(({ id, label, models, installed }) => ({ id, label, models, installed }));
  }
}
