import { describe, expect, it } from "vitest";
import { checkRequirements, probeVersion } from "../src/projects/requirements";

describe("machine requirements", () => {
  it("reports each tool's version, or missing with an install link", async () => {
    const found: Record<string, string | null> = { node: "24.1.0", git: "2.50.1" };
    const list = await checkRequirements(async (p) => found[p] ?? null);
    expect(list.map((r) => [r.id, r.installed, r.version, r.required])).toEqual([
      ["node", true, "24.1.0", true],
      ["git", true, "2.50.1", true],
      ["ai", false, null, true],
    ]);
    expect(list[2]!.installUrl).toMatch(/^https:\/\//);
    // A model counts once Claude is signed in or a key is saved; what it says shows in place of a version.
    const ready = await checkRequirements(async (p) => found[p] ?? null, async () => "Claude Pro");
    expect(ready[2]).toMatchObject({ id: "ai", installed: true, version: "Claude Pro" });
  });

  it("probes real programs: git is here, a made-up one is not", async () => {
    expect(await probeVersion("git")).toMatch(/^\d+\.\d+/);
    expect(await probeVersion("cadence-no-such-program-xyz")).toBeNull();
  }, 30_000);
});
