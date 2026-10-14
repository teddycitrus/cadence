import { describe, expect, it } from "vitest";
import { callBoardTool } from "../src/agents/board-tools";
import { personalInstructions, skillTools } from "../src/chat/skills";
import { makeContainer } from "./helpers/setup";
import { BUILTIN_SKILLS, expandSkillCommand } from "../src/skills/builtin";

describe("built-in workflows", () => {
  it("expands a workflow's slash command and leaves everything else alone", () => {
    expect(BUILTIN_SKILLS).toHaveLength(16);
    expect(new Set(BUILTIN_SKILLS.map((s) => s.name)).size).toBe(16);
    const out = expandSkillCommand("/design-options a pet adoption site");
    expect(out).toMatch(/^Run the Cadence workflow "Explore design directions" \(\/design-options\)\./);
    expect(out).toContain("What the person asked for: a pet adoption site");
    expect(expandSkillCommand("/check-tests")).toContain("CI and test audit");
    expect(expandSkillCommand("/not-a-skill hi")).toBe("/not-a-skill hi");
    expect(expandSkillCommand("please /design this")).toBe("please /design this");
    for (const s of BUILTIN_SKILLS) expect(s.body("x").length, s.name).toBeGreaterThan(200);
  });
});

describe("personal skills and instructions", () => {
  it("saves, overwrites by name, validates, and deletes skills per person", () => {
    const { c } = makeContainer();
    const first = c.skills.save("me", { name: "Release-Notes", description: "Weekly notes", body: "1. Read the log" }, "user");
    expect(first.name).toBe("release-notes");
    const again = c.skills.save("me", { name: "release-notes", description: "Weekly", body: "2. Write it" }, "user");
    expect(again.id).toBe(first.id);
    expect(c.skills.list("me")).toHaveLength(1);
    expect(c.skills.get("me", "release-notes").body).toBe("2. Write it");
    expect(c.skills.list("someone-else")).toEqual([]);

    expect(() => c.skills.save("me", { name: "has spaces", description: "", body: "x" }, "user")).toThrow(/dashes/);
    expect(() => c.skills.save("me", { name: "empty", description: "", body: "  " }, "user")).toThrow(/instructions/);
    expect(() => c.skills.delete("someone-else", first.id, "user")).toThrow(/not found/i);

    c.skills.delete("me", first.id, "user");
    expect(c.skills.list("me")).toEqual([]);
  });

  it("adds the owner's prompt and skill index to their chats only", () => {
    const { c } = makeContainer();
    expect(personalInstructions(c.q, { agentId: null, createdBy: "user" })).toBe("");
    c.auth.setPreferences("me", { systemPrompt: "Answer in British English." });
    c.skills.save("me", { name: "triage", description: "Sort new bugs", body: "Steps" }, "user");

    const text = personalInstructions(c.q, { agentId: null, createdBy: "user" });
    expect(text).toContain("Answer in British English.");
    expect(text).toContain("- triage: Sort new bugs");
    expect(text).not.toContain("Steps");
    expect(personalInstructions(c.q, { agentId: "a1", createdBy: "user" })).toBe("");
  });

  it("lets the assistant list, read, and save skills for the chat's owner", async () => {
    const { c } = makeContainer();
    const tools = skillTools(c.skills);
    const ctx = { actor: "user" as const, runId: null, issueId: null, ownerId: "me" };
    expect((await callBoardTool(tools, "skill_list", {}, ctx)).text).toMatch(/^Saved skills:\n- none yet\n\nBuilt-in workflows:\n- first-run \(built in\)/);
    expect((await callBoardTool(tools, "skill_save", { name: "deploy", description: "Ship it", body: "Run the deploy" }, ctx)).text).toBe('Saved skill "deploy".');
    expect((await callBoardTool(tools, "skill_get", { name: "deploy" }, ctx)).text).toContain("Run the deploy");
    // Without a person there are no saved skills, but the built-in workflows still list and read.
    expect((await callBoardTool(tools, "skill_list", {}, { ...ctx, ownerId: null })).text).toContain("- review-design (built in)");
    expect((await callBoardTool(tools, "skill_get", { name: "page-to-frame" }, { ...ctx, ownerId: null })).text).toMatch(/^# page-to-frame: Turn a page into an editable frame/);
    expect((await callBoardTool(tools, "skill_save", { name: "x", description: "", body: "y" }, { ...ctx, ownerId: null })).isError).toBe(true);
  });
});
