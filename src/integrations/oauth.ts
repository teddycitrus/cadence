import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ValidationError } from "../core/errors";
import type { McpTokens } from "./mcp-tokens";
import type { SecretStore } from "./secrets";

// OAuth 2.1 for the MCP endpoint, so chat apps that only take a connector URL
// (ChatGPT, claude.ai, Claude mobile) can sign in: dynamic client
// registration, the authorization code flow with PKCE (S256 only), and a
// consent page in Cadence. Approving mints a personal MCP token for the person
// who approved, so everything the connector does is attributed to them and
// revocable in Settings like any other token.

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  createdAt: string;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  memberId: string;
  scope: string;
  expires: number;
}

const KEY = "oauthClients";
const CODE_TTL_MS = 10 * 60_000;
const MAX_CLIENTS = 200;

/** Redirects must be https, or http to this machine (desktop apps and tests). */
export function allowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
}

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export class OAuthServer {
  private codes = new Map<string, PendingCode>();

  constructor(
    private secrets: SecretStore,
    private tokens: McpTokens,
  ) {}

  private clients(): OAuthClient[] {
    try {
      return JSON.parse(this.secrets.get(KEY) ?? "[]") as OAuthClient[];
    } catch {
      return [];
    }
  }

  client(id: string): OAuthClient | null {
    return this.clients().find((c) => c.id === id) ?? null;
  }

  /** RFC 7591 dynamic registration for public clients (no secret; PKCE protects the code). */
  register(input: { client_name?: unknown; redirect_uris?: unknown }): OAuthClient {
    const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (!uris.length || uris.length > 10 || !uris.every(allowedRedirect)) throw new ValidationError("redirect_uris must be https URLs (or http on localhost)");
    const name = (typeof input.client_name === "string" ? input.client_name : "MCP client").trim().slice(0, 80) || "MCP client";
    const client: OAuthClient = { id: `cmc_${randomUUID()}`, name, redirectUris: uris, createdAt: new Date().toISOString() };
    this.secrets.set(KEY, JSON.stringify([...this.clients(), client].slice(-MAX_CLIENTS)));
    return client;
  }

  /** Checks an authorization request before the consent page shows it. */
  validate(q: Record<string, unknown>): { client: OAuthClient; redirectUri: string; challenge: string; state: string | null; scope: string } {
    const str = (k: string) => (typeof q[k] === "string" ? (q[k] as string) : "");
    if (str("response_type") !== "code") throw new ValidationError("response_type must be code");
    const client = this.client(str("client_id"));
    if (!client) throw new ValidationError("Unknown client_id; register the client first");
    const redirectUri = str("redirect_uri") || (client.redirectUris.length === 1 ? client.redirectUris[0]! : "");
    if (!client.redirectUris.includes(redirectUri)) throw new ValidationError("redirect_uri is not registered for this client");
    if (str("code_challenge_method") !== "S256" || !/^[\w-]{43,128}$/.test(str("code_challenge"))) throw new ValidationError("PKCE with code_challenge_method S256 is required");
    return { client, redirectUri, challenge: str("code_challenge"), state: str("state") || null, scope: str("scope") || "mcp" };
  }

  /** The person approved: a one-time code for the client's redirect. */
  approve(q: Record<string, unknown>, memberId: string): string {
    const v = this.validate(q);
    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, { clientId: v.client.id, redirectUri: v.redirectUri, challenge: v.challenge, memberId, scope: v.scope, expires: Date.now() + CODE_TTL_MS });
    const u = new URL(v.redirectUri);
    u.searchParams.set("code", code);
    if (v.state) u.searchParams.set("state", v.state);
    return u.toString();
  }

  /** The person declined: the client's redirect with access_denied. */
  deny(q: Record<string, unknown>): string {
    const v = this.validate(q);
    const u = new URL(v.redirectUri);
    u.searchParams.set("error", "access_denied");
    if (v.state) u.searchParams.set("state", v.state);
    return u.toString();
  }

  /** Swaps a code (once) for an access token: a personal MCP token named after the client. */
  exchange(body: Record<string, unknown>): { access_token: string; token_type: "Bearer"; scope: string } {
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    if (str("grant_type") !== "authorization_code") throw new OAuthError("unsupported_grant_type");
    const pending = this.codes.get(str("code"));
    this.codes.delete(str("code"));
    if (!pending || pending.expires < Date.now()) throw new OAuthError("invalid_grant");
    if (pending.clientId !== str("client_id") || pending.redirectUri !== str("redirect_uri")) throw new OAuthError("invalid_grant");
    if (s256(str("code_verifier")) !== pending.challenge) throw new OAuthError("invalid_grant");
    const client = this.client(pending.clientId)!;
    const { token } = this.tokens.create(`${client.name} (connector)`.slice(0, 60), pending.memberId);
    return { access_token: token, token_type: "Bearer", scope: pending.scope };
  }
}

export class OAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Discovery documents (RFC 8414 and RFC 9728), for an issuer at `base`. */
export function oauthMetadata(base: string) {
  return {
    authorizationServer: {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    },
    protectedResource: { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"], scopes_supported: ["mcp"] },
  };
}
