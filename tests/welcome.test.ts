import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCanvas } from "../src/canvas/parse";
import { welcomeCanvasSource } from "../src/projects/welcome";
import { bootTeam } from "./helpers/team";

describe("the welcome tour", () => {
  it("is a valid canvas of six frames that do not overlap", () => {
    const c = parseCanvas(welcomeCanvasSource(), "welcome.canvas.tsx");
    expect(c.errors).toEqual([]);
    expect(c.name).toBe("Welcome to Cadence");
    expect(c.storyboards.map((s) => s.id)).toEqual(["Board", "Agents", "Chat", "Docs", "Canvases", "Ship"]);
  });

  it("makes a Welcome workspace with a seeded chat and the canvas, without running an agent", async () => {
    const team = await bootTeam();
    try {
      const r = await team.local("POST", "/start/welcome", {});
      expect(r.status).toBe(201);
      const ws = team.c.q.workspace(r.json.workspaceId)!;
      expect(ws.name).toBe("Welcome");
      expect(readFileSync(join(ws.path, r.json.canvasPath), "utf8")).toContain("Welcome to Cadence");
      expect((await team.c.canvases.list(ws.id)).map((x) => x.path)).toEqual(["cadence/welcome.canvas.tsx"]);
      const items = team.c.q.chatItems(r.json.chatId);
      expect(items.map((i) => i.kind)).toEqual(["user", "assistant"]);
      expect(team.c.q.chat(r.json.chatId)!.status).toBe("idle");
    } finally {
      team.close();
    }
  });
});
