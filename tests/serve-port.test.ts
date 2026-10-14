import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startCadence } from "../src/server/serve";
import { FakeRuntime } from "./helpers/fake-runtime";
import { offlineLlm } from "./helpers/setup";
import { removeTempDir } from "./helpers/temp-dir";

describe("starting the server", () => {
  it("says so plainly when the port is taken, instead of crashing later", async () => {
    const taken: Server = createServer();
    await new Promise<void>((r) => taken.listen(0, "127.0.0.1", () => r()));
    const port = (taken.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "cadence-port-"));
    try {
      await expect(startCadence({ dataDir: dir, port, host: "127.0.0.1", apiToken: null, trustLocal: true, staticDir: null, llm: offlineLlm, runtimeFor: () => new FakeRuntime() })).rejects.toThrow(`Port ${port} is already in use`);
    } finally {
      taken.close();
      removeTempDir(dir);
    }
  });
});
