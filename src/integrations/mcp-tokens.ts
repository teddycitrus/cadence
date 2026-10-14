import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { NotFoundError } from "../core/errors";
import type { SecretStore } from "./secrets";

export interface McpToken {
  id: string;
  name: string;
  /** The first characters, so people can tell tokens apart. */
  prefix: string;
  /** The person the token acts for. Tokens made before this existed belong to the owner. */
  memberId: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface Stored extends McpToken {
  hash: string;
}

const KEY = "mcpTokens";
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Personal access tokens that let agents outside Cadence (a cloud agent, a
 * teammate's IDE) use the board tools over MCP. Only hashes are kept; the
 * token itself is shown once, at creation.
 */
export class McpTokens {
  constructor(private secrets: SecretStore) {}

  private all(): Stored[] {
    const raw = this.secrets.get(KEY);
    return raw ? (JSON.parse(raw) as Stored[]).map((t) => ({ ...t, memberId: t.memberId ?? "me" })) : [];
  }

  private write(list: Stored[]): void {
    this.secrets.set(KEY, list.length ? JSON.stringify(list) : null);
  }

  /** Everyone's tokens, or with `memberId` only that person's. */
  list(memberId?: string): McpToken[] {
    return this.all()
      .filter((t) => !memberId || t.memberId === memberId)
      .map(({ hash: _h, ...t }) => t);
  }

  create(name: string, memberId = "me"): { token: string; info: McpToken } {
    const token = `cad_${randomBytes(24).toString("base64url")}`;
    const info: McpToken = { id: randomUUID(), name: name.trim().slice(0, 60) || "MCP client", prefix: token.slice(0, 8), memberId, createdAt: new Date().toISOString(), lastUsedAt: null };
    this.write([...this.all(), { ...info, hash: hash(token) }]);
    return { token, info };
  }

  revoke(id: string): void {
    const list = this.all();
    if (!list.some((t) => t.id === id)) throw new NotFoundError("Token not found");
    this.write(list.filter((t) => t.id !== id));
  }

  /** The token's record if the bearer value matches one, recording when it was used. */
  verify(bearer: string | undefined): McpToken | null {
    if (!bearer?.startsWith("cad_")) return null;
    const h = Buffer.from(hash(bearer));
    const list = this.all();
    const match = list.find((t) => {
      const other = Buffer.from(t.hash);
      return other.length === h.length && timingSafeEqual(other, h);
    });
    if (!match) return null;
    const now = new Date().toISOString();
    // Write at most once a minute per token.
    if (!match.lastUsedAt || Date.parse(now) - Date.parse(match.lastUsedAt) > 60_000) {
      match.lastUsedAt = now;
      this.write(list);
    }
    const { hash: _h, ...info } = match;
    return info;
  }
}
