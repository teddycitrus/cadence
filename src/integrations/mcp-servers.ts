import { ValidationError } from "../core/errors";
import type { SecretStore } from "./secrets";

// MCP servers the team adds for its chats and agents (a database, a docs
// search, an internal API). They can carry tokens in env vars or headers, so
// they live in the secret store and browsers only see the variable names.

export interface McpServerConfig {
  /** Becomes the tool prefix (mcp__<name>__tool), so letters, digits, - and _. */
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  /** On in new chats unless someone turns it off there. */
  defaultOn: boolean;
}

/** What browsers see: secret values replaced by a mark. */
export type McpServerView = Omit<McpServerConfig, "env" | "headers"> & { envKeys: string[]; headerKeys: string[] };

const KEY = "mcpServers";
const NAME = /^[a-zA-Z][\w-]{0,40}$/;
/** Cadence's own servers; a team server with one of these names would shadow them. */
const RESERVED = new Set(["cadence", "cadence_board", "cadence-board"]);
const SECRET_MARK = "********";

export class McpServers {
  constructor(private secrets: SecretStore) {}

  all(): McpServerConfig[] {
    try {
      return JSON.parse(this.secrets.get(KEY) ?? "[]") as McpServerConfig[];
    } catch {
      return [];
    }
  }

  list(): McpServerView[] {
    return this.all().map(({ env, headers, ...rest }) => ({ ...rest, envKeys: Object.keys(env), headerKeys: Object.keys(headers) }));
  }

  /** Adds or replaces a server. Secret values sent back as the mark keep their saved value. */
  save(input: McpServerConfig, previousName = input.name): McpServerView[] {
    if (!NAME.test(input.name) || RESERVED.has(input.name.toLowerCase())) throw new ValidationError("Name the server with a letter, then letters, digits, - or _ (up to 41 characters), and not \"cadence\"");
    if (input.transport === "stdio" && !input.command.trim()) throw new ValidationError("A local server needs a command to run");
    if (input.transport === "http") {
      let u: URL;
      try {
        u = new URL(input.url);
      } catch {
        throw new ValidationError("A remote server needs its URL");
      }
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new ValidationError("The server URL must be http or https");
    }
    const all = this.all();
    const before = all.find((s) => s.name === previousName);
    if (input.name !== previousName && all.some((s) => s.name === input.name)) throw new ValidationError(`There is already a server named ${input.name}`);
    const keep = (next: Record<string, string>, prev: Record<string, string> = {}) => Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v === SECRET_MARK ? (prev[k] ?? "") : v]));
    const clean: McpServerConfig = {
      name: input.name,
      transport: input.transport,
      command: input.transport === "stdio" ? input.command.trim() : "",
      args: input.transport === "stdio" ? input.args : [],
      env: input.transport === "stdio" ? keep(input.env, before?.env) : {},
      url: input.transport === "http" ? input.url : "",
      headers: input.transport === "http" ? keep(input.headers, before?.headers) : {},
      defaultOn: input.defaultOn,
    };
    this.secrets.set(KEY, JSON.stringify([...all.filter((s) => s.name !== previousName), clean]));
    return this.list();
  }

  remove(name: string): McpServerView[] {
    this.secrets.set(KEY, JSON.stringify(this.all().filter((s) => s.name !== name)));
    return this.list();
  }

  /** The servers a chat uses: its own choice, or the defaults. */
  forChat(chosen: string[] | null | undefined): McpServerConfig[] {
    return this.all().filter((s) => (chosen ? chosen.includes(s.name) : s.defaultOn));
  }
}

export const SECRET_PLACEHOLDER = SECRET_MARK;

/** In the shape the Claude Agent SDK takes. */
export function forClaude(servers: McpServerConfig[]): Record<string, { type: "stdio"; command: string; args: string[]; env: Record<string, string> } | { type: "http"; url: string; headers: Record<string, string> }> {
  return Object.fromEntries(servers.map((s) => [s.name, s.transport === "stdio" ? { type: "stdio" as const, command: s.command, args: s.args, env: s.env } : { type: "http" as const, url: s.url, headers: s.headers }]));
}

/** In the shape ACP's session/new takes; remote servers only when the harness speaks MCP over HTTP. */
export function forAcp(servers: McpServerConfig[], http: boolean): Record<string, unknown>[] {
  return servers
    .filter((s) => s.transport === "stdio" || http)
    .map((s) =>
      s.transport === "stdio"
        ? { name: s.name, command: s.command, args: s.args, env: Object.entries(s.env).map(([name, value]) => ({ name, value })) }
        : { type: "http", name: s.name, url: s.url, headers: Object.entries(s.headers).map(([name, value]) => ({ name, value })) },
    );
}
