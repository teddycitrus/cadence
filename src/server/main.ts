import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AnthropicLlm } from "../agents/anthropic-llm";
import { ClaudeCodeRuntime } from "../agents/claude-runtime";
import { startCadence } from "./serve";

const dataDir = resolve(process.env.CADENCE_DATA_DIR ?? "data");
const port = Number(process.env.CADENCE_PORT ?? 4317);
const host = process.env.CADENCE_HOST ?? "127.0.0.1";
const apiToken = process.env.CADENCE_API_TOKEN || null;

try {
  const cadence = await startCadence({
    dataDir,
    port,
    host,
    apiToken,
    trustLocal: process.env.CADENCE_TRUST_LOCAL ? process.env.CADENCE_TRUST_LOCAL !== "0" : !apiToken,
    staticDir: fileURLToPath(new URL("../../dist/web", import.meta.url)),
    llm: new AnthropicLlm(),
    runtimeFor: (_org, env) => {
      const claude = new ClaudeCodeRuntime();
      // Keys from Settings > Providers reach Claude Code's process too.
      claude.env = env;
      return claude;
    },
  });
  console.log(`Cadence listening on ${cadence.url} (data: ${dataDir}, ${cadence.orgs.all().length} organization(s))`);
  const shutdown = () => {
    void cadence.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Run by the desktop app: it learns the address over IPC and asks for a clean shutdown the same way
  // (on Windows a kill would leave terminals and dev servers running).
  if (process.send) {
    process.send({ type: "ready", url: cadence.url });
    process.on("message", (m: unknown) => {
      if (m === "shutdown") shutdown();
      // The desktop app's memory readout counts the server too.
      else if (typeof m === "object" && m !== null && (m as { type?: string }).type === "memory") process.send?.({ type: "memory", rss: process.memoryUsage().rss });
    });
    process.on("disconnect", shutdown);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  if (process.send) process.send({ type: "failed", error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
