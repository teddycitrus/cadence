import { randomBytes } from "node:crypto";
import type { BoardTool, ToolContext } from "./board-tools";

interface Entry {
  tools: BoardTool[];
  ctx: ToolContext;
}

/**
 * Hands a session's board tools to a harness running in another process.
 * Each session gets a random token for Cadence's own /mcp endpoint, valid
 * until the session ends, which resolves to that session's tools and actor.
 */
export class ToolBridge {
  private entries = new Map<string, Entry>();
  /** Where this server listens, set once it is up (http://127.0.0.1:port). */
  baseUrl: string | null = null;
  /** Added to the endpoint URL, naming the organization (e.g. "?org=..."). */
  query = "";

  register(tools: BoardTool[], ctx: ToolContext): { url: string; token: string; dispose: () => void } | null {
    if (!this.baseUrl) return null;
    const token = `cbs_${randomBytes(24).toString("base64url")}`;
    this.entries.set(token, { tools, ctx });
    return { url: `${this.baseUrl}/mcp${this.query}`, token, dispose: () => this.entries.delete(token) };
  }

  lookup(bearer: string | undefined): Entry | null {
    return bearer?.startsWith("cbs_") ? (this.entries.get(bearer) ?? null) : null;
  }

  get size(): number {
    return this.entries.size;
  }
}
