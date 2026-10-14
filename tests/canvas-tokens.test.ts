import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addToken, parseTokens, projectTokens, setTokenValue, writeToken } from "../src/canvas/tokens";
import { applyStyles } from "../src/canvas/tailwind";
import { createGitFixture, type GitFixture } from "./helpers/git-fixture";

const CSS = `@import "tailwindcss";

/* brand colors */
@theme {
  --color-brand: #2563eb;
  --color-accent: var(--color-brand);
  --spacing-gutter: 24px;
  --font-display: "Inter", sans-serif;
}

:root {
  --radius-card: 12px;
  --shadow-card: 0 1px 2px rgb(0 0 0 / 0.2), 0 4px 12px rgb(0 0 0 / 0.1);
}

.dark {
  --color-brand: #60a5fa;
}

@media (prefers-color-scheme: dark) {
  :root { --surface: #18181b }
}

.button { color: var(--color-brand); padding: 4px; }
`;

describe("design tokens", () => {
  let fx: GitFixture | null = null;
  afterEach(() => {
    fx?.cleanup();
    fx = null;
  });

  it("reads custom properties with their block, kind, and aliases", () => {
    const tokens = parseTokens(CSS, "src/index.css");
    expect(tokens.map((t) => [t.name, t.scope, t.kind, t.value])).toEqual([
      ["--color-brand", "@theme", "color", "#2563eb"],
      ["--color-accent", "@theme", "color", "var(--color-brand)"],
      ["--spacing-gutter", "@theme", "length", "24px"],
      ["--font-display", "@theme", "font", '"Inter", sans-serif'],
      ["--radius-card", ":root", "length", "12px"],
      ["--shadow-card", ":root", "shadow", "0 1px 2px rgb(0 0 0 / 0.2), 0 4px 12px rgb(0 0 0 / 0.1)"],
      ["--color-brand", ".dark", "color", "#60a5fa"],
      ["--surface", ":root", "color", "#18181b"],
    ]);
    expect(tokens[1]!.aliasOf).toBe("--color-brand");
  });

  it("edits a value in the block it lives in, and adds new ones", () => {
    const next = setTokenValue(CSS, { name: "--color-brand", scope: ".dark" }, "#93c5fd")!;
    expect(next).toContain(".dark {\n  --color-brand: #93c5fd;");
    expect(next).toContain("--color-brand: #2563eb;");
    expect(setTokenValue(CSS, { name: "--color-brand", scope: "@theme" }, "red; } body { x")).toBeNull();
    expect(setTokenValue(CSS, { name: "--missing", scope: ":root" }, "1px")).toBeNull();
    const added = addToken(CSS, "--color-danger", "#dc2626")!;
    expect(added).toContain("@theme {\n  --color-danger: #dc2626;\n  --color-brand");
    expect(addToken(CSS, "--color-brand", "#000")).toBeNull();
    expect(addToken(".a { color: red; }", "--x", "1px")).toBe(".a { color: red; }\n\n:root {\n  --x: 1px;\n}\n");
  });

  it("finds tokens across a project's stylesheets and writes changes back", async () => {
    fx = createGitFixture();
    mkdirSync(join(fx.repo, "src"), { recursive: true });
    writeFileSync(join(fx.repo, "src/index.css"), CSS);
    mkdirSync(join(fx.repo, "node_modules/lib"), { recursive: true });
    writeFileSync(join(fx.repo, "node_modules/lib/x.css"), ":root { --nope: 1px; }");
    const tokens = await projectTokens(fx.repo);
    expect(new Set(tokens.map((t) => t.file))).toEqual(new Set(["src/index.css"]));
    writeToken(fx.repo, "src/index.css", { name: "--radius-card", scope: ":root", value: "16px" });
    expect(readFileSync(join(fx.repo, "src/index.css"), "utf8")).toContain("--radius-card: 16px;");
    expect(() => writeToken(fx!.repo, "../outside.css", { name: "--x", value: "1px", add: true })).toThrow(/not a stylesheet/);
  });

  it("writes token colors as type-hinted Tailwind classes", () => {
    expect(applyStyles(["bg-[#fff]"], { background: "var(--color-brand)" })).toEqual(["bg-[color:var(--color-brand)]"]);
    expect(applyStyles(["bg-[color:var(--color-brand)]"], { background: "#000000" })).toEqual(["bg-[#000000]"]);
    expect(applyStyles([], { color: "var(--fg)", padding: "var(--spacing-gutter)" })).toEqual(["text-[color:var(--fg)]", "p-[var(--spacing-gutter)]"]);
  });
});
