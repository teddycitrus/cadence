import { afterEach, describe, expect, it } from "vitest";
import { agentTools } from "../src/agents/agent-tools";
import { callBoardTool } from "../src/agents/board-tools";
import { redactEvent } from "../src/server/routes/system";
import { bootTeam } from "./helpers/team";

describe("private and public agents", () => {
  let close = () => {};
  afterEach(() => close());

  it("hides private agents from teammates, lets admins manage public ones, and copies", async () => {
    const team = await bootTeam();
    close = team.close;
    const { local, c } = team;
    const mine = (await local("POST", "/agents", { name: "Secret Sauce", prompt: "Owner only", triggers: [{ kind: "webhook" }] })).json;
    expect(mine).toMatchObject({ ownerId: "me", visibility: "private", enabled: false });
    const shared = (await local("POST", "/agents", { name: "Reviewer", prompt: "Review PRs", visibility: "public", triggers: [{ kind: "webhook" }] })).json;
    expect(shared.triggers[0].secret).toBeTruthy();

    const admin = await team.join("admin", "Ana");
    const member = await team.join("member", "Mo");

    const seen = (await member.call("GET", "/snapshot")).json.agents as any[];
    const privateView = seen.find((a) => a.id === mine.id);
    expect(privateView).toMatchObject({ name: "Secret Sauce", prompt: "", triggers: [] });
    const publicView = seen.find((a) => a.id === shared.id);
    expect(publicView.prompt).toBe("Review PRs");
    expect(publicView.triggers[0].secret).toBe("");
    expect((await member.call("GET", `/agents/${mine.id}`)).status).toBe(404);

    // Admins manage public agents but never someone else's private one.
    expect((await admin.call("PATCH", `/agents/${mine.id}`, { description: "x" })).status).toBe(404);
    expect((await admin.call("PATCH", `/agents/${shared.id}`, { description: "Second opinion" })).json.description).toBe("Second opinion");
    expect((await admin.call("PATCH", `/agents/${shared.id}`, { visibility: "private" })).status).toBe(403);
    expect((await admin.call("POST", `/agents/${mine.id}/run`, {})).status).toBe(404);

    const copy = await admin.call("POST", `/agents/${shared.id}/copy`);
    expect(copy.status).toBe(201);
    expect(copy.json).toMatchObject({ name: "Reviewer (copy)", ownerId: admin.id, visibility: "private", enabled: false, prompt: "Review PRs" });
    expect(copy.json.triggers[0].secret).not.toBe(shared.triggers[0].secret);
    expect((await admin.call("POST", `/agents/${mine.id}/copy`)).status).toBe(404);
    // The owner of the org cannot read the admin's private copy either.
    expect((await local("GET", `/agents/${copy.json.id}`)).status).toBe(404);

    // Pushed events about someone else's private agent carry no payload.
    const event = c.store.forAggregate("agent", mine.id).find((e) => e.type === "AgentCreated")!;
    expect(redactEvent(event, { actor: `member:${member.id}`, memberId: member.id, role: "member" }, c.q).payload).toEqual({});
    expect(redactEvent(event, { actor: "user", memberId: "me", role: "owner" }, c.q).payload).toMatchObject({ prompt: "Owner only" });
  });

  it("keeps agent tools to the caller's own and public agents", async () => {
    const team = await bootTeam();
    close = team.close;
    const { c } = team;
    const admin = await team.join("admin", "Ana");
    const hers = c.agents.createAgent({ name: "Hers", prompt: "p", enabled: true }, `member:${admin.id}`);
    const lead = c.agents.createAgent({ name: "Lead", prompt: "p", enabled: true, visibility: "public" }, "user");
    const tools = agentTools(c.q, c.agents);
    const ctx = { actor: `agent:${lead.id}` as const, runId: null, issueId: null };

    const list = (await callBoardTool(tools, "agents_list", {}, ctx)).text;
    expect(list).toContain('"Lead"');
    expect(list).not.toContain("Hers");
    expect((await callBoardTool(tools, "agents_get", { agent: "Hers" }, ctx)).isError).toBe(true);
    expect((await callBoardTool(tools, "agents_run", { agent: "Hers" }, ctx)).isError).toBe(true);

    await callBoardTool(tools, "agents_create", { name: "Helper", prompt: "help" }, { ...ctx, ownerId: admin.id });
    expect(c.q.agent("Helper")).toMatchObject({ ownerId: admin.id, visibility: "private" });
    expect(hers.ownerId).toBe(admin.id);
  });
});

describe("public agents anyone can edit", () => {
  it("lets teammates change and run an editable public agent, but not delete it or change who may edit", async () => {
    const team = await bootTeam();
    try {
      const mia = await team.join("member", "Mia");
      const created = await team.local("POST", "/agents", { name: "Shared helper", prompt: "Help", visibility: "public" });
      const id = created.json.id as string;
      expect((await mia.call("PATCH", `/agents/${id}`, { prompt: "Mine now" })).status).toBe(403);
      await team.local("PATCH", `/agents/${id}`, { publicAccess: "edit" });
      expect((await mia.call("PATCH", `/agents/${id}`, { prompt: "Better help" })).status).toBe(200);
      expect(team.c.q.agent(id)!.prompt).toBe("Better help");
      expect((await mia.call("PATCH", `/agents/${id}`, { publicAccess: "view" })).status).toBe(403);
      expect((await mia.call("DELETE", `/agents/${id}`)).status).toBe(403);
      expect((await team.local("DELETE", `/agents/${id}`)).status).toBe(200);
    } finally {
      team.close();
    }
  });
});
