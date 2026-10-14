import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { claudeBinary } from "../src/agents/claude-binary";
import { signInCommand } from "../src/agents/sign-in";
import { firstJsonObject, structuredAnswer } from "../src/agents/structured";
import { SIGN_IN } from "../src/terminal/service";
import { makeContainer, offlineLlm } from "./helpers/setup";
import { bootTeam } from "./helpers/team";
import { removeTempDir } from "./helpers/temp-dir";

describe("signing in and model access without an API key", () => {
  const dirs: string[] = [];
  const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
  let close = () => {};
  afterEach(() => {
    close();
    close = () => {};
    dirs.splice(0).forEach(removeTempDir);
    process.env.ANTHROPIC_API_KEY = saved.key;
    process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    if (saved.token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
  });

  it("finds a claude to sign in with even when Claude Code is not installed (the SDK's own copy)", () => {
    const bin = claudeBinary();
    expect(/[\\/]/.test(bin) ? existsSync(bin) : bin).toBeTruthy();
    expect(signInCommand("claude-code")).toMatchObject({ file: bin, args: ["auth", "login"] });
  });

  it("answers structured questions through the default harness's sign-in when no key is set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const dir = mkdtempSync(join(tmpdir(), "cadence-structured-"));
    dirs.push(dir);
    const { c, runtime } = makeContainer(dir);
    const deps = { llm: offlineLlm, providers: c.providers, runtime: c.defaultRuntime, cwd: dir };
    const schema = z.object({ cron: z.string(), description: z.string() });
    runtime.completion = 'Sure:\n```json\n{"cron":"0 9 * * 1-5","description":"Weekdays at 9:00"}\n```';
    expect(await structuredAnswer(deps, { model: "claude-opus-5-5", effort: "low", system: "s", prompt: "weekdays at nine", schema })).toEqual({ cron: "0 9 * * 1-5", description: "Weekdays at 9:00" });
    expect(runtime.completions.at(-1)).toContain('"required":["cron","description"]');
    runtime.completion = '{"cron": 5}';
    await expect(structuredAnswer(deps, { model: "claude-opus-5-5", effort: "low", system: "s", prompt: "x", schema })).rejects.toThrow(/expected shape/);
    // A key saved in Settings > Providers goes to the API instead.
    c.providers.update("claude-code", { env: { ANTHROPIC_API_KEY: "sk-ant-test" } });
    await expect(structuredAnswer(deps, { model: "claude-opus-5-5", effort: "low", system: "s", prompt: "x", schema })).rejects.toThrow("offline");
    expect(() => firstJsonObject("no json here")).toThrow(/no JSON/);
  });

  it("runs a sign-in program in its own terminal, outside any workspace", async () => {
    const { c } = makeContainer();
    const info = c.terminals.openProgram({ file: process.execPath, args: ["-e", "console.log('signed-in-ok')"], title: "Sign in to Test" });
    expect(info).toMatchObject({ workspaceId: SIGN_IN, title: "Sign in to Test" });
    let out = "";
    const { scrollback, detach } = c.terminals.attach(info.id, (m) => m.type === "output" && (out += m.data));
    out += scrollback;
    for (let i = 0; i < 100 && !out.includes("signed-in-ok"); i++) await new Promise((r) => setTimeout(r, 100));
    detach();
    c.terminals.close(info.id);
    expect(out).toContain("signed-in-ok");
  });

  it("only owners and admins can start a sign-in, and unknown harnesses are refused", async () => {
    const team = await bootTeam();
    close = team.close;
    const member = await team.join("member", "Mia");
    expect((await member.call("POST", "/providers/claude-code/sign-in", {})).status).toBe(403);
    expect((await team.local("POST", "/providers/nope/sign-in", {})).status).toBe(404);
    const account = await team.local("GET", "/providers/codex/account");
    expect(account).toMatchObject({ status: 200, json: { account: null } });
  });
});
