import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { createContainer, type Container } from "../../src/server/container";
import type { LlmGateway } from "../../src/agents/llm";
import { FakeRuntime } from "./fake-runtime";
import { removeTempDir } from "./temp-dir";

export const offlineLlm: LlmGateway = {
  configured: false,
  structured: async () => {
    throw new Error("offline");
  },
};

// Containers made without a data folder get a temp one, removed when the test file ends;
// a relative default would write scratch workspaces and settings into the repo.
const madeDirs: string[] = [];
afterAll(() => madeDirs.splice(0).forEach(removeTempDir));

export function makeContainer(dataDir?: string): { c: Container; runtime: FakeRuntime } {
  if (!dataDir) {
    dataDir = mkdtempSync(join(tmpdir(), "cadence-test-"));
    madeDirs.push(dataDir);
  }
  const runtime = new FakeRuntime();
  const c = createContainer({ dataDir, dbFile: ":memory:", runtime, llm: offlineLlm });
  return { c, runtime };
}

export const stageId = (c: Container, name: string) => c.q.stage(name)!.id;
