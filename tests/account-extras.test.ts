import { afterEach, describe, expect, it } from "vitest";
import { SlackApi } from "../src/integrations/slack/api";
import { bootTeam } from "./helpers/team";

describe("account extras", () => {
  let close = () => {};
  afterEach(() => {
    close();
    close = () => {};
  });

  it("hides the getting-started checklist and duplicates skills under free names", async () => {
    const team = await bootTeam();
    close = team.close;
    expect((await team.local("PUT", "/members/me/onboarding", { hideGettingStarted: true })).json.gettingStartedHidden).toBe(true);
    const skill = (await team.local("PUT", "/members/me/skills", { name: "release-notes", description: "Notes", body: "Write them" })).json;
    const first = await team.local("POST", `/members/me/skills/${skill.id}/duplicate`);
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ name: "release-notes-copy", description: "Notes", body: "Write them" });
    expect((await team.local("POST", `/members/me/skills/${skill.id}/duplicate`)).json.name).toBe("release-notes-copy-2");
    expect((await team.local("POST", "/members/me/skills/nope/duplicate")).status).toBe(404);
  });

  it("posts to Slack with the bot's chosen name and picture, and checks the picture URL", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fake = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, ts: "1.2", channel: "C1" }));
    }) as typeof fetch;
    await new SlackApi("xoxb-1", fake, { name: "Shipit", iconUrl: "https://example.com/bot.png" }).postMessage("C123ABC", "hi");
    await new SlackApi("xoxb-1", fake).postMessage("C123ABC", "plain");
    expect(bodies[0]).toMatchObject({ username: "Shipit", icon_url: "https://example.com/bot.png" });
    expect(bodies[1]).not.toHaveProperty("username");

    const team = await bootTeam();
    close = team.close;
    expect((await team.local("PUT", "/integrations/slack/identity", { name: "Shipit", iconUrl: "http://insecure.example/x.png" })).status).toBe(400);
    expect((await team.local("PUT", "/integrations/slack/identity", { name: "Shipit", iconUrl: "https://example.com/bot.png" })).json.identity).toEqual({ name: "Shipit", iconUrl: "https://example.com/bot.png" });
    expect((await team.local("PUT", "/integrations/slack/identity", { name: null, iconUrl: null })).json.identity).toEqual({ name: null, iconUrl: null });
  });
});
