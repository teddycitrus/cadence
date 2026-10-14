import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callBoardTool } from "../src/agents/board-tools";
import { scriptTools } from "../src/agents/script-tools";
import { projectForViewer, runCommandsFor, setupCommand } from "../src/projects/scripts";
import { createGitFixture } from "./helpers/git-fixture";
import { makeContainer } from "./helpers/setup";
import { bootTeam } from "./helpers/team";

const write = (file: string, env: string) => `node -e "require('fs').writeFileSync('${file}', process.env.${env} || 'unset')"`;

describe("project setup and run scripts", () => {
  it("combines shared and personal scripts, with a personal name replacing the shared one", () => {
    const { c } = makeContainer();
    const p = c.agents.addProject({ name: "app", path: "C:/code/app", baseBranch: "main", githubRepo: null, setupScript: "npm ci", commands: [{ name: "test", command: "npm test" }, { name: "dev", command: "npm run dev" }] });
    expect(setupCommand(p, "me")).toBe("npm ci");
    c.agents.setPersonalScripts(p.id, "me", { setupScript: "cp ../.env .env", commands: [{ name: "dev", command: "npm run dev -- --port 4000" }] });
    const fresh = c.q.project(p.id)!;
    expect(setupCommand(fresh, "me")).toBe("(npm ci) && (cp ../.env .env)");
    expect(setupCommand(fresh, "someone")).toBe("npm ci");
    expect(runCommandsFor(fresh, "me")).toEqual([
      { name: "test", command: "npm test", scope: "org" },
      { name: "dev", command: "npm run dev -- --port 4000", scope: "user" },
    ]);
    // A later patch keeps the fields it does not name.
    c.agents.setPersonalScripts(p.id, "me", { commands: [] });
    expect(c.q.project(p.id)!.personal!.me).toEqual({ setupScript: "cp ../.env .env", commands: [] });
    expect(projectForViewer(c.q.project(p.id)!, "other").personal).toEqual({});
  });

  it("runs org && mine in a new workspace with the source path set", async () => {
    const fx = createGitFixture();
    const { c } = makeContainer(fx.dataDir);
    try {
      const p = c.agents.addProject({ name: "demo", path: fx.repo, baseBranch: "main", githubRepo: null, setupScript: write("org.txt", "CADENCE_SOURCE_PATH") });
      c.agents.setPersonalScripts(p.id, "me", { setupScript: write("mine.txt", "CADENCE_WORKSPACE_PATH") });
      const ws = await c.workspaces.createInProject(p.id, "Scripts", "user");
      expect(readFileSync(join(ws.path, "org.txt"), "utf8")).toBe(fx.repo);
      expect(readFileSync(join(ws.path, "mine.txt"), "utf8")).toBe(ws.path);
      // Someone else's workspace only gets the shared script.
      const other = await c.workspaces.createInProject(p.id, "Theirs", "member:someone");
      expect(existsSync(join(other.path, "org.txt"))).toBe(true);
      expect(existsSync(join(other.path, "mine.txt"))).toBe(false);
    } finally {
      c.stop();
      c.db.close();
      fx.cleanup();
    }
  }, 60_000);

  it("lets agents list and change Run commands and setup scripts", async () => {
    const { c } = makeContainer();
    const p = c.agents.addProject({ name: "app", path: "C:/code/app", baseBranch: "main", githubRepo: null });
    const tools = scriptTools(c.q, c.agents);
    const ctx = { actor: "user" as const, runId: null, issueId: null, ownerId: "me" };
    expect((await callBoardTool(tools, "scripts_configure", { name: "test", command: "npm test" }, ctx)).text).toBe("Saved shared command test.");
    expect((await callBoardTool(tools, "scripts_configure", { name: "test", command: "npm test -- --watch=false" }, ctx)).isError).toBe(false);
    expect((await callBoardTool(tools, "scripts_configure", { name: "lint", command: "npm run lint", scope: "user" }, ctx)).text).toBe("Saved personal command lint.");
    await callBoardTool(tools, "scripts_set_setup", { command: "npm ci" }, ctx);
    const listed = JSON.parse((await callBoardTool(tools, "scripts_list", {}, ctx)).text);
    expect(listed).toEqual({ sharedPrep: "npm ci", sharedCommands: [{ name: "test", command: "npm test -- --watch=false" }], myPrep: null, myCommands: [{ name: "lint", command: "npm run lint" }] });
    expect((await callBoardTool(tools, "scripts_delete", { name: "nope" }, ctx)).isError).toBe(true);
    await callBoardTool(tools, "scripts_delete", { name: "test", project: "app" }, ctx);
    expect(c.q.project(p.id)!.commands).toEqual([]);
  });

  it("keeps personal scripts private and shared ones admin-only over HTTP", async () => {
    const team = await bootTeam();
    try {
      const project = team.c.agents.addProject({ name: "app", path: "C:/code/app", baseBranch: "main", githubRepo: null });
      const member = await team.join("member", "Mia");
      expect((await member.call("PUT", `/projects/${project.id}/scripts`, { scope: "org", setupScript: "rm -rf /" })).status).toBe(400);
      const mine = await member.call("PUT", `/projects/${project.id}/scripts`, { scope: "user", commands: [{ name: "dev", command: "npm run dev" }] });
      expect(mine.status).toBe(200);
      expect(mine.json.myCommands).toEqual([{ name: "dev", command: "npm run dev" }]);
      expect((await team.local("PUT", `/projects/${project.id}/scripts`, { scope: "org", commands: [{ name: "test", command: "npm test" }] })).json.sharedCommands).toHaveLength(1);

      const ownerView = (await team.local("GET", "/snapshot")).json.projects[0];
      expect(ownerView.personal).toEqual({});
      expect((await team.local("GET", `/projects/${project.id}/scripts`)).json.myCommands).toEqual([]);
      const memberView = (await member.call("GET", "/snapshot")).json.projects[0];
      expect(memberView.personal[member.id].commands).toEqual([{ name: "dev", command: "npm run dev" }]);
    } finally {
      team.close();
    }
  });
});
