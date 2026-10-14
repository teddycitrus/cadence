#!/usr/bin/env node
// cadence-mcp: Cadence's tools for any local MCP host (Claude Code, Codex, Cursor).
// It speaks MCP over stdio and forwards every call to a Cadence server's /mcp
// endpoint with a personal access token. Run it from a workspace folder and the
// canvas and browser tools for that workspace come along.

import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const VERSION = "0.1.0";
const CONFIG = process.env.CADENCE_MCP_CONFIG || join(homedir(), ".cadence", "mcp.json");

const HELP = `cadence-mcp ${VERSION}

Usage:
  cadence-mcp [--toolsets issues,docs] [--readonly] [--workspace <id or folder>] [--org <id>]
      Serve Cadence's tools over stdio. The workspace defaults to the current folder.
  cadence-mcp login [--url <cadence url>] [--token <cad_...>]
      Save the server and token. Without --token, asks a Cadence on this machine for one.
  cadence-mcp token create [--name <label>] [--url <cadence url>]
      Mint a token from a Cadence on this machine (or with CADENCE_API_TOKEN) and print it.
  cadence-mcp whoami
      Show the organization, person, and workspace this connection reaches.

Environment: CADENCE_URL, CADENCE_AUTH_TOKEN, CADENCE_MCP_READONLY=1, CADENCE_MCP_CONFIG.
Toolsets: issues, docs, comments, agents, scripts, slack, linear, canvas, skills, browser, git, host.`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--readonly") out.readonly = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=", 2);
      out[k] = inline ?? argv[++i];
    } else out._.push(a);
  }
  return out;
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n");
  try {
    chmodSync(CONFIG, 0o600);
  } catch {
    // Windows keeps the file private to the user profile already
  }
}

const baseUrl = (args, cfg) => String(args.url || process.env.CADENCE_URL || cfg.url || "http://127.0.0.1:4317").replace(/\/+$/, "");

/** Asks the Cadence server for a new personal access token (local trust or CADENCE_API_TOKEN). */
async function createToken(url, name) {
  const headers = { "Content-Type": "application/json" };
  if (process.env.CADENCE_API_TOKEN) headers.Authorization = `Bearer ${process.env.CADENCE_API_TOKEN}`;
  const res = await fetch(`${url}/api/integrations/mcp-tokens`, { method: "POST", headers, body: JSON.stringify({ name }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Cadence answered ${res.status}. Create a token in Settings > Integrations and pass --token.`);
  return body.token;
}

function endpoint(url, args) {
  const u = new URL(`${url}/mcp`);
  const toolsets = args.toolsets || process.env.CADENCE_MCP_TOOLSETS;
  if (toolsets) u.searchParams.set("toolsets", toolsets);
  if (args.readonly || process.env.CADENCE_MCP_READONLY === "1") u.searchParams.set("readonly", "1");
  u.searchParams.set("workspace", args.workspace || process.cwd());
  if (args.org) u.searchParams.set("org", args.org);
  return u;
}

async function connect(args) {
  const cfg = readConfig();
  const url = baseUrl(args, cfg);
  const token = process.env.CADENCE_AUTH_TOKEN || cfg.token;
  if (!token) throw new Error("No Cadence token. Run `cadence-mcp login` (or set CADENCE_AUTH_TOKEN).");
  const client = new Client({ name: "cadence-mcp", version: VERSION });
  await client.connect(new StreamableHTTPClientTransport(endpoint(url, args), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function serve(args) {
  const remote = await connect(args);
  const server = new Server({ name: "cadence", version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async (req) => remote.listTools(req.params));
  server.setRequestHandler(CallToolRequestSchema, async (req) => remote.callTool(req.params));
  await server.connect(new StdioServerTransport());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, sub] = args._;
  if (args.help || cmd === "help") return console.log(HELP);
  if (cmd === "login") {
    const cfg = readConfig();
    const url = baseUrl(args, cfg);
    const token = args.token || (await createToken(url, `cadence-mcp on ${hostname()}`));
    saveConfig({ ...cfg, url, token });
    return console.log(`Saved ${url} and a token to ${CONFIG}.`);
  }
  if (cmd === "token" && sub === "create") return console.log(await createToken(baseUrl(args, readConfig()), args.name || `cadence-mcp on ${hostname()}`));
  if (cmd === "whoami") {
    const client = await connect(args);
    const r = await client.callTool({ name: "cadence_whoami", arguments: {} });
    console.log(r.content.map((c) => c.text ?? "").join("\n"));
    return client.close();
  }
  if (cmd) throw new Error(`Unknown command ${cmd}. Try --help.`);
  return serve(args);
}

main().catch((err) => {
  console.error(`cadence-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
