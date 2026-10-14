import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { allowedRedirect } from "../src/integrations/oauth";
import { bootTeam } from "./helpers/team";

describe("OAuth for connector-only chat apps", () => {
  it("only accepts https redirects, or http to this machine", () => {
    expect(allowedRedirect("https://chatgpt.com/connector/callback")).toBe(true);
    expect(allowedRedirect("http://127.0.0.1:6274/cb")).toBe(true);
    expect(allowedRedirect("http://evil.example/cb")).toBe(false);
    expect(allowedRedirect("javascript:alert(1)")).toBe(false);
    expect(allowedRedirect("https://a.example/cb#frag")).toBe(false);
  });

  it("registers, asks the person, swaps the code with PKCE, and the token works on /mcp", async () => {
    const team = await bootTeam();
    const origin = team.localBase.replace(/\/api$/, "");
    try {
      const unauth = await fetch(`${origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
      expect(unauth.status).toBe(401);
      expect(unauth.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`);
      const meta = (await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json()) as Record<string, string>;
      expect(meta.token_endpoint).toBe(`${origin}/oauth/token`);
      expect((await (await fetch(`${origin}/.well-known/oauth-protected-resource`)).json()).resource).toBe(`${origin}/mcp`);

      const reg = await fetch(meta.registration_endpoint!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: ["https://chatgpt.com/cb"] }) });
      expect(reg.status).toBe(201);
      const { client_id } = (await reg.json()) as { client_id: string };
      expect((await fetch(meta.registration_endpoint!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) })).status).toBe(400);

      const verifier = randomBytes(32).toString("base64url");
      const params = { response_type: "code", client_id, redirect_uri: "https://chatgpt.com/cb", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "xyz" };
      const auth = await fetch(`${meta.authorization_endpoint}?${new URLSearchParams(params)}`, { redirect: "manual" });
      expect(auth.status).toBe(302);
      expect(auth.headers.get("location")).toMatch(/^\/#\/oauth\?/);
      expect((await fetch(`${meta.authorization_endpoint}?${new URLSearchParams({ ...params, code_challenge_method: "plain" })}`, { redirect: "manual" })).status).toBe(400);

      // The signed-in owner sees who is asking and allows it.
      expect((await team.local("POST", "/oauth/request", params)).json.clientName).toBe("ChatGPT");
      const decided = await team.local("POST", "/oauth/decide", { params, allow: true });
      const back = new URL(decided.json.redirect);
      expect(back.origin + back.pathname).toBe("https://chatgpt.com/cb");
      expect(back.searchParams.get("state")).toBe("xyz");
      const code = back.searchParams.get("code")!;

      const token = (body: Record<string, string>) => fetch(meta.token_endpoint!, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
      expect((await token({ grant_type: "authorization_code", code, client_id, redirect_uri: "https://chatgpt.com/cb", code_verifier: "wrong".padEnd(43, "x") })).status).toBe(400);
      // A failed attempt burns the code, so the flow starts over.
      expect((await token({ grant_type: "authorization_code", code, client_id, redirect_uri: "https://chatgpt.com/cb", code_verifier: verifier })).status).toBe(400);
      const again = new URL((await team.local("POST", "/oauth/decide", { params, allow: true })).json.redirect).searchParams.get("code")!;
      const ok = await token({ grant_type: "authorization_code", code: again, client_id, redirect_uri: "https://chatgpt.com/cb", code_verifier: verifier });
      expect(ok.status).toBe(200);
      const { access_token, token_type } = (await ok.json()) as { access_token: string; token_type: string };
      expect(token_type).toBe("Bearer");

      const client = new Client({ name: "chatgpt", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${access_token}` } } }));
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("issues_list");
      await client.close();
      expect(team.c.mcpTokens.list("me").map((t) => t.name)).toContain("ChatGPT (connector)");

      const denied = new URL((await team.local("POST", "/oauth/decide", { params, allow: false })).json.redirect);
      expect(denied.searchParams.get("error")).toBe("access_denied");
    } finally {
      team.close();
    }
  });
});
