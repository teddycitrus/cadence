// A minimal Agent Client Protocol agent for tests. It keeps each session's
// history in .fake-acp/<id>.json under the session's cwd so a new process
// can reload it, and reacts to a few prompt words:
//   edit   asks permission, then writes notes.txt through the client
//   board  calls the issues_list tool on the MCP server it was given
//   wait   runs until cancelled
//   anything else is echoed back in two chunks
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const sessions = new Map();
let nextId = 1;
const pending = new Map();
const cancelled = new Set();

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = `a${nextId++}`;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
const update = (sessionId, u) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: u } });
const historyFile = (s) => join(s.cwd, ".fake-acp", `${s.id}.json`);
const save = (s) => {
  mkdirSync(join(s.cwd, ".fake-acp"), { recursive: true });
  writeFileSync(historyFile(s), JSON.stringify(s.history));
};

async function mcpCall(server, name, args) {
  if (server.command) {
    // A stdio server: start it, send one call, read one line back.
    const { spawn } = await import("node:child_process");
    const child = spawn(server.command, server.args, { env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) }, stdio: ["pipe", "pipe", "inherit"] });
    const line = await new Promise((resolve) => {
      createInterface({ input: child.stdout }).once("line", resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })}\n`);
    });
    child.stdin.end();
    const body = JSON.parse(line);
    return `(stdio) ${body.result?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(body.error)}`;
  }
  const res = await fetch(server.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...Object.fromEntries(server.headers.map((h) => [h.name, h.value])) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  return body.result?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(body.error);
}

async function prompt(p) {
  const s = sessions.get(p.sessionId);
  const text = p.prompt.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  s.history.push({ role: "user", text });
  const say = (t) => {
    update(s.id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
    s.history.push({ role: "assistant", text: t });
  };
  const last = text.split("\n").at(-1).trim();
  if (text.includes("<cadence_instructions>")) s.sawInstructions = true;
  if (last === "edit") {
    update(s.id, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Write notes.txt", kind: "edit", status: "pending", content: [{ type: "diff", path: "notes.txt", oldText: null, newText: "hello" }], locations: [{ path: "notes.txt" }] });
    const answer = await request("session/request_permission", {
      sessionId: s.id,
      toolCall: { toolCallId: "t1", title: "Write notes.txt", kind: "edit" },
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Always", kind: "allow_always" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId !== "no";
    if (allowed) await request("fs/write_text_file", { sessionId: s.id, path: join(s.cwd, "notes.txt"), content: "hello" });
    update(s.id, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: allowed ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: allowed ? `wrote (${answer.outcome.optionId})` : "rejected" } }] });
    say(allowed ? "Edited." : "Not allowed.");
  } else if (last === "board") {
    const out = await mcpCall(s.mcpServers[0], "issues_list", {});
    update(s.id, { sessionUpdate: "plan", entries: [{ content: "Read the board", priority: "high", status: "completed" }] });
    say(`Board says: ${out.slice(0, 200)}`);
  } else if (last === "wait") {
    say("Working");
    while (!cancelled.has(s.id)) await new Promise((r) => setTimeout(r, 20));
    cancelled.delete(s.id);
    save(s);
    return { stopReason: "cancelled" };
  } else {
    say("You said: ");
    say(last);
  }
  save(s);
  return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };
}

const modes = { currentModeId: "ask", availableModes: [{ id: "ask", name: "Ask" }, { id: "auto", name: "Auto edit" }, { id: "read-only", name: "Read only" }, { id: "full-access", name: "Full access" }] };
const models = { currentModelId: "fake-1", availableModels: [{ modelId: "fake-1", name: "Fake 1" }, { modelId: "fake-2", name: "Fake 2" }] };

const handlers = {
  initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, mcpCapabilities: { http: process.env.FAKE_ACP_NO_HTTP ? false : true } }, authMethods: [] }),
  "session/new": (p) => {
    if (process.env.FAKE_ACP_AUTH && !process.env.FAKE_ACP_KEY) {
      const err = new Error("Authentication required");
      err.code = -32000;
      throw err;
    }
    const id = `s${Date.now()}${Math.floor(Math.random() * 1000)}`;
    sessions.set(id, { id, cwd: p.cwd, mcpServers: p.mcpServers, history: [], mode: "ask" });
    update(id, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review" }] });
    return { sessionId: id, modes, models };
  },
  "session/load": (p) => {
    const s = { id: p.sessionId, cwd: p.cwd, mcpServers: p.mcpServers, history: [], mode: "ask" };
    if (existsSync(historyFile(s))) s.history = JSON.parse(readFileSync(historyFile(s), "utf8"));
    sessions.set(s.id, s);
    for (const h of s.history) update(s.id, { sessionUpdate: h.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: h.text } });
    return { modes, models };
  },
  "session/set_mode": (p) => {
    sessions.get(p.sessionId).mode = p.modeId;
    writeFileSync(join(sessions.get(p.sessionId).cwd, ".fake-acp-mode"), p.modeId);
    return {};
  },
  "session/set_model": (p) => {
    writeFileSync(join(sessions.get(p.sessionId).cwd, ".fake-acp-model"), p.modelId);
    return {};
  },
  "session/prompt": prompt,
};

createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p?.reject(new Error(m.error.message));
    else p?.resolve(m.result);
    return;
  }
  if (m.method === "session/cancel") {
    cancelled.add(m.params.sessionId);
    return;
  }
  const h = handlers[m.method];
  if (!h) {
    if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } });
    return;
  }
  try {
    send({ jsonrpc: "2.0", id: m.id, result: await h(m.params) });
  } catch (err) {
    send({ jsonrpc: "2.0", id: m.id, error: { code: err.code ?? -32603, message: err.message } });
  }
});
