import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callBoardTool } from "../src/agents/board-tools";
import { assetLibraries, parseAssets, variantJsx } from "../src/canvas/assets";
import { insertElement } from "../src/canvas/compose";
import { makeContainer } from "./helpers/setup";

const BUTTONS = `import { Button } from "../components/Button";
import Card from "../components/Card";
import { Unknown } from "some-package";

export default {
  name: "Buttons",
  library: "Design System",
  assets: {
    Button: {
      usage: "Primary actions. Not for navigation (use Link).",
      variants: {
        Primary: { props: { variant: "primary", size: 2, wide: true }, children: "Buy now" },
        Broken: { props: someVariable },
      },
    },
    Card: { libraries: ["Marketing"] },
    Unknown: { usage: "from a package" },
  },
};

export const Primary = { name: "Primary", render: () => <Button variant="primary">Buy now</Button>, frame: { x: 0, y: 0, width: 300, height: 120 } };
`;

describe("drawing tools", () => {
  it("adds a div, rectangle, or text inside the clicked element, opening self-closing ones", () => {
    const src = "export const A = () => (\n  <main>\n    <section />\n  </main>\n);\n";
    const withText = insertElement(src, 2, 2, "text")!;
    expect(withText).toContain("    <p>Text</p>\n  </main>");
    const intoSection = insertElement(src, 3, 4, "rectangle")!;
    expect(intoSection).toMatch(/<section>\n {4} {2}<div style=\{\{ width: 120, height: 80, background: "#d4d4d8", borderRadius: 4 \}\} \/>\n {4}<\/section>/);
    expect(insertElement(src, 9, 0, "div")).toBeNull();
  });
});

describe("component kits", () => {
  it("reports declarations whose imports do not resolve to a project file instead of guessing", () => {
    const { assets, errors } = parseAssets(process.cwd(), "tests/fixtures/none.canvas.tsx", BUTTONS);
    expect(assets).toEqual([]);
    expect(errors).toEqual(["Button: not imported from a project file in this canvas", "Card: not imported from a project file in this canvas", "Unknown: not imported from a project file in this canvas"]);
  });

  it("indexes a workspace, flags duplicates, and inserts a variant into the selected element", async () => {
    const { c } = makeContainer();
    const ws = await c.workspaces.createInProject(null, "DS", "user");
    // Canvas listing reads git's view of the folder.
    execFileSync("git", ["init", "-q", ws.path], { stdio: "pipe" });
    mkdirSync(join(ws.path, "src/components"), { recursive: true });
    mkdirSync(join(ws.path, "src/canvases"), { recursive: true });
    writeFileSync(join(ws.path, "src/components/Button.tsx"), "export const Button = (p: any) => <button {...p} />;\n");
    writeFileSync(join(ws.path, "src/components/Card.tsx"), "export default function Card() { return <div />; }\n");
    writeFileSync(join(ws.path, "src/canvases/buttons.canvas.tsx"), BUTTONS);
    writeFileSync(
      join(ws.path, "src/canvases/again.canvas.tsx"),
      `import { Button } from "../components/Button";\nexport default { name: "Again", assets: { Button: { usage: "dup" } } };\nexport const A = { name: "A", render: () => <Button />, frame: { x: 0, y: 0, width: 100, height: 100 } };\n`,
    );
    writeFileSync(join(ws.path, "src/Page.tsx"), "export function Page() {\n  return (\n    <main>\n      <h1>Hi</h1>\n    </main>\n  );\n}\n");

    const lib = assetLibraries(ws.path, ["src/canvases/again.canvas.tsx", "src/canvases/buttons.canvas.tsx"]);
    expect(lib.assets.map((a) => a.name)).toEqual(["Button", "Card"]);
    // The first declaration wins; the second is reported.
    expect(lib.assets.find((a) => a.name === "Button")!.canvasPath).toBe("src/canvases/again.canvas.tsx");
    expect(lib.errors["src/canvases/buttons.canvas.tsx"]).toEqual(expect.arrayContaining([expect.stringMatching(/^Unknown: not imported/), expect.stringMatching(/Button is already declared in src\/canvases\/again/)]));

    const only = assetLibraries(ws.path, ["src/canvases/buttons.canvas.tsx"]);
    const button = only.assets.find((a) => a.name === "Button")!;
    expect(button).toMatchObject({ file: "src/components/Button.tsx", imported: "Button", libraries: ["Design System"], usage: "Primary actions. Not for navigation (use Link)." });
    expect(button.variants).toEqual([{ name: "Primary", props: { variant: "primary", size: 2, wide: true }, children: "Buy now" }]);
    expect(button.warnings).toEqual(["Variant Broken: props must be literal values"]);
    expect(only.libraries).toEqual({ "Design System": ["Button", "Card"], Marketing: ["Card"] });
    expect(only.assets.find((a) => a.name === "Card")!.warnings[0]).toMatch(/No usage note/);

    expect(variantJsx("Button", button.variants[0]!)).toBe('<Button variant="primary" size={2} wide>Buy now</Button>');

    const tools = c.workspaceTools();
    const ctx = { actor: "agent:a" as const, runId: null, issueId: null, workspaceId: ws.id };
    expect((await callBoardTool(tools, "assets_list", { library: "Marketing" }, ctx)).text).toMatch(/Assets:\n- Card \(src\/components\/Card\.tsx; Design System, Marketing\)/);
    expect(JSON.parse((await callBoardTool(tools, "assets_get", { name: "card" }, ctx)).text).imported).toBe("default");

    c.canvases.insert(ws.id, "src/Page.tsx:3:4", { name: "Button", file: "src/components/Button.tsx", imported: "Button" }, { props: { variant: "primary" }, children: "Go" });
    const page = readFileSync(join(ws.path, "src/Page.tsx"), "utf8");
    expect(page).toContain('import { Button } from "./components/Button";');
    expect(page).toContain('<Button variant="primary">Go</Button>');
  });
});
