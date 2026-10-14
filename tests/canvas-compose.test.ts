import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { componentLibrary, insertComponent, tidyFrames } from "../src/canvas/compose";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture";
import { bootTeam } from "./helpers/team";
import { removeTempDir } from "./helpers/temp-dir";

describe("canvas composition", () => {
  const dirs: string[] = [];
  let fx: GitFixture | null = null;
  let close = () => {};
  afterEach(() => {
    close();
    close = () => {};
    fx?.cleanup();
    fx = null;
    for (const d of dirs.splice(0)) removeTempDir(d);
  });

  it("tidies frames into rows in reading order, leaving locked ones", () => {
    const f = (x: number, y: number, width = 400, height = 300) => ({ x, y, width, height });
    const out = tidyFrames([
      { id: "b", frame: f(900, 15), locked: false },
      { id: "a", frame: f(10, 10), locked: false },
      { id: "wide", frame: f(30, 500, 2000, 100), locked: false },
      { id: "pinned", frame: f(5000, 5000), locked: true },
    ]);
    expect(out.get("a")).toEqual(f(10, 10));
    expect(out.get("b")).toEqual(f(490, 10));
    // Too wide for the first row: wraps below the tallest one.
    expect(out.get("wide")).toEqual(f(10, 390, 2000, 100));
    expect(out.has("pinned")).toBe(false);
  });

  it("lists the project's components and inserts them with an import", () => {
    const root = mkdtempSync(join(tmpdir(), "cadence-compose-"));
    dirs.push(root);
    mkdirSync(join(root, "src/ui"), { recursive: true });
    writeFileSync(join(root, "src/ui/Button.tsx"), "export function Button() { return <button>Go</button>; }\n");
    writeFileSync(join(root, "src/ui/Badge.tsx"), "export default function Badge() { return <span />; }\n");
    writeFileSync(join(root, "src/ui.canvas.tsx"), `import { Button } from "./ui/Button";\nimport Badge from "./ui/Badge";\nexport default { name: "UI" };\nexport const Buttons = { name: "Buttons", render: () => <div><Button /><Badge /></div> };\n`);
    const lib = componentLibrary(root, [{ path: "src/ui.canvas.tsx", storyIds: ["Buttons"] }]);
    expect(lib).toEqual([
      { name: "Badge", file: "src/ui/Badge.tsx", imported: "default" },
      { name: "Button", file: "src/ui/Button.tsx", imported: "Button" },
    ]);

    const page = `import { useState } from "react";\n\nexport function Page() {\n  return (\n    <main>\n      <h1>Hi</h1>\n    </main>\n  );\n}\n`;
    const once = insertComponent(page, 5, 4, join(root, "src/pages"), root, lib[1]!)!;
    expect(once).toContain(`import { useState } from "react";\nimport { Button } from "../ui/Button";`);
    expect(once).toContain("      <h1>Hi</h1>\n      <Button />\n    </main>");
    // A second insert reuses the import.
    const twice = insertComponent(once, 6, 4, join(root, "src/pages"), root, lib[1]!)!;
    expect(twice.match(/import \{ Button \}/g)).toHaveLength(1);
    // Self-closing elements open up; a clashing name gets an alias.
    const clash = `import { Button } from "some-lib";\nexport const X = () => <section />;\n`;
    const aliased = insertComponent(clash, 2, 23, join(root, "src"), root, lib[1]!)!;
    expect(aliased).toContain(`import { Button as Button2 } from "./ui/Button";`);
    expect(aliased).toContain("<section>\n  <Button2 />\n</section>");
    expect(insertComponent(page, 99, 0, root, root, lib[0]!)).toBeNull();
  });

  it("reacts to canvas comments and attaches images", async () => {
    fx = createGitFixture({ "README.md": "# x\n", "app.canvas.tsx": `export default { name: "App" };\nexport const Home = { name: "Home", html: "index.html" };\n`, "index.html": "<p>hi</p>\n" });
    const team = await bootTeam();
    close = team.close;
    const project = team.c.agents.addProject({ name: "x", path: fx.repo, baseBranch: "main", githubRepo: null });
    const ws = await team.c.workspaces.createInProject(project.id, "Design", "system");
    const base = `/workspaces/${ws.id}/canvas/comments`;
    expect((await team.local("POST", base, { canvasPath: "app.canvas.tsx", x: 1, y: 2, body: "" })).status).toBe(400);
    expect((await team.local("POST", base, { canvasPath: "app.canvas.tsx", x: 1, y: 2, body: "", attachments: [{ url: "https://evil.example/x.png", name: "x" }] })).status).toBe(400);
    const made = await team.local("POST", base, { canvasPath: "app.canvas.tsx", x: 1, y: 2, body: "", attachments: [{ url: "/api/assets/abc-123", name: "shot.png" }] });
    expect(made.status).toBe(201);
    expect(made.json.attachments).toEqual([{ url: "/api/assets/abc-123", name: "shot.png" }]);
    const member = await team.join("member", "Mo");
    expect((await team.local("PUT", `${base}/${made.json.id}/reactions/eyes`, { on: true })).json.reactions).toEqual({ eyes: ["user"] });
    expect((await member.call("PUT", `${base}/${made.json.id}/reactions/eyes`, { on: true })).json.reactions.eyes).toHaveLength(2);
    expect((await team.local("PUT", `${base}/${made.json.id}/reactions/eyes`, { on: false })).json.reactions.eyes).toHaveLength(1);
    expect((await team.local("PUT", `${base}/${made.json.id}/reactions/poop`, { on: true })).status).toBe(400);
  });
});
