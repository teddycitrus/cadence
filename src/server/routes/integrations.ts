import { Router } from "express";
import { z } from "zod";
import type { Container } from "../container";
import { identityOf } from "../auth-middleware";
import { NotFoundError } from "../../core/errors";

/** Paste into api.slack.com/apps > Create New App > From a manifest. */
export const SLACK_MANIFEST = {
  display_information: { name: "Cadence", description: "Your Cadence agents in Slack", background_color: "#5e6a28" },
  features: { bot_user: { display_name: "Cadence", always_online: true } },
  oauth_config: {
    scopes: {
      bot: ["app_mentions:read", "channels:history", "channels:read", "groups:history", "groups:read", "chat:write", "chat:write.customize", "reactions:read", "reactions:write", "users:read"],
    },
  },
  settings: {
    event_subscriptions: { bot_events: ["app_mention", "message.channels", "message.groups", "reaction_added"] },
    interactivity: { is_enabled: false },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
};

const LinearConnect = z.object({ apiKey: z.string().trim().min(10).max(300) });
const LinearConfigure = z.object({ teamIds: z.array(z.string().min(1).max(100)).max(50), writeBack: z.boolean() }).partial();

const SlackConnect = z.object({ botToken: z.string().trim().min(10).max(300), appToken: z.string().trim().min(10).max(300) });

export function integrationRoutes(c: Container): Router {
  const r = Router();

  r.get("/", async (_req, res) => {
    const source = await c.github.source();
    res.json({ slack: c.slack.status(), linear: c.linear.status(), figma: { connected: c.figma.connected() }, github: { connected: source !== null, source } });
  });

  r.get("/slack/manifest", (_req, res) => {
    res.json(SLACK_MANIFEST);
  });

  r.post("/slack", async (req, res) => {
    const input = SlackConnect.parse(req.body);
    res.json(await c.slack.connect(input.botToken, input.appToken));
  });

  r.put("/slack/identity", (req, res) => {
    res.json(c.slack.setIdentity(z.object({ name: z.string().max(80).nullable(), iconUrl: z.string().max(1000).nullable() }).parse(req.body)));
  });

  r.delete("/slack", (_req, res) => {
    res.json(c.slack.disconnect());
  });

  r.get("/slack/channels", async (_req, res) => {
    res.json(await c.slack.api().channels());
  });

  /** The team's own MCP servers for chats and agents (admins; secret values never come back). */
  const McpServerInput = z.object({
    name: z.string().trim().min(1).max(41),
    transport: z.enum(["stdio", "http"]),
    command: z.string().max(500).default(""),
    args: z.array(z.string().max(1000)).max(50).default([]),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(100), z.string().max(5000)).default({}),
    url: z.string().max(1000).default(""),
    headers: z.record(z.string().regex(/^[A-Za-z0-9-]+$/).max(100), z.string().max(5000)).default({}),
    defaultOn: z.boolean().default(true),
  });
  r.get("/mcp-servers", (_req, res) => {
    res.json(c.mcpServers.list());
  });
  r.put("/mcp-servers/:name", (req, res) => {
    if (identityOf(res).role === "member") return void res.status(403).json({ error: "Only admins can change MCP servers" });
    res.json(c.mcpServers.save(McpServerInput.parse(req.body), req.params.name));
  });
  r.delete("/mcp-servers/:name", (req, res) => {
    if (identityOf(res).role === "member") return void res.status(403).json({ error: "Only admins can change MCP servers" });
    res.json(c.mcpServers.remove(req.params.name));
  });

  /** Your own tokens; the owner sees everyone's so they can revoke any. */
  r.get("/mcp-tokens", (_req, res) => {
    const who = identityOf(res);
    res.json(c.mcpTokens.list(who.role === "owner" ? undefined : who.memberId));
  });

  /** The token is in this response only; Cadence keeps just its hash. */
  r.post("/mcp-tokens", (req, res) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
    res.status(201).json(c.mcpTokens.create(name, identityOf(res).memberId));
  });

  r.delete("/mcp-tokens/:id", (req, res) => {
    const who = identityOf(res);
    if (who.role !== "owner" && !c.mcpTokens.list(who.memberId).some((t) => t.id === req.params.id)) throw new NotFoundError("Token not found");
    c.mcpTokens.revoke(req.params.id);
    res.json({ ok: true });
  });

  r.put("/figma", async (req, res) => {
    const { token } = z.object({ token: z.string().trim().max(300).nullable() }).parse(req.body);
    const handle = await c.figma.saveToken(token || null);
    res.json({ connected: c.figma.connected(), handle });
  });

  r.post("/linear", async (req, res) => {
    res.json(await c.linear.connect(LinearConnect.parse(req.body).apiKey));
  });

  r.patch("/linear", (req, res) => {
    res.json(c.linear.configure(LinearConfigure.parse(req.body)));
  });

  r.delete("/linear", (_req, res) => {
    res.json(c.linear.disconnect());
  });

  r.get("/linear/teams", async (_req, res) => {
    res.json(await c.linear.api().teams());
  });

  r.post("/linear/sync", async (_req, res) => {
    const changed = await c.linear.sync();
    res.json({ changed, status: c.linear.status() });
  });

  return r;
}
