// Relays a stdio MCP client to Cadence's HTTP MCP endpoint, for harnesses
// that only accept stdio MCP servers. Usage: node mcp-stdio-proxy.mjs <url>
// with the session token in CADENCE_MCP_TOKEN. Plain JS so node runs it as is.
import { createInterface } from "node:readline";

const url = process.argv[2];
const token = process.env.CADENCE_MCP_TOKEN;
if (!url || !token) {
  process.stderr.write("usage: CADENCE_MCP_TOKEN=... node mcp-stdio-proxy.mjs <url>\n");
  process.exit(2);
}

const lines = createInterface({ input: process.stdin });
let chain = Promise.resolve();

lines.on("line", (line) => {
  if (!line.trim()) return;
  // Keep replies in request order.
  chain = chain.then(() => relay(line));
});
lines.on("close", () => void chain.then(() => process.exit(0)));

async function relay(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
      body: line,
    });
    if (res.status === 202 || res.status === 204) return;
    const text = await res.text();
    if (!text.trim()) return;
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for (const l of text.split("\n")) if (l.startsWith("data: ")) process.stdout.write(`${l.slice(6)}\n`);
      return;
    }
    process.stdout.write(`${text.trim()}\n`);
  } catch (err) {
    if (message && message.id !== undefined) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: `Cadence is unreachable: ${err.message}` } })}\n`);
    }
  }
}
