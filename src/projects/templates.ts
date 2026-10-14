// Files for new projects made from the Generate page. Kept small: the agent
// builds the real thing on top.

export type StarterKind = "mockup" | "prototype" | "blank";

const GITIGNORE = "node_modules\ndist\n.DS_Store\n*.log\n";

/** A Vite + React + Tailwind app with a canvas showing its home route. */
function prototypeFiles(name: string): Record<string, string> {
  const pkgName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "prototype";
  return {
    ".gitignore": GITIGNORE,
    "package.json": `${JSON.stringify(
      {
        name: pkgName,
        private: true,
        type: "module",
        scripts: { dev: "vite", build: "tsc -b && vite build", preview: "vite preview" },
        dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
        devDependencies: { "@tailwindcss/vite": "^4.0.0", "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0", "@vitejs/plugin-react": "^5.0.0", tailwindcss: "^4.0.0", typescript: "^5.6.0", vite: "^7.0.0" },
      },
      null,
      2,
    )}\n`,
    "vite.config.ts": `import react from "@vitejs/plugin-react";\nimport tailwindcss from "@tailwindcss/vite";\nimport { defineConfig } from "vite";\n\nexport default defineConfig({ plugins: [react(), tailwindcss()] });\n`,
    "tsconfig.json": `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", jsx: "react-jsx", strict: true, skipLibCheck: true, noEmit: true, lib: ["ES2022", "DOM", "DOM.Iterable"] }, include: ["src"] }, null, 2)}\n`,
    "index.html": `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>${name.replace(/</g, "&lt;")}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n`,
    "src/index.css": `@import "tailwindcss";\n`,
    "src/main.tsx": `import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport { App } from "./App";\nimport "./index.css";\n\ncreateRoot(document.getElementById("root")!).render(\n  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n`,
    "src/App.tsx": `export function App() {\n  return (\n    <main className="grid min-h-screen place-items-center bg-zinc-950 text-zinc-100">\n      <p className="text-zinc-400">Building ${name.replace(/[{}<>`"]/g, "")}...</p>\n    </main>\n  );\n}\n`,
    "src/app.canvas.tsx": `import "./index.css";\n\nexport default { name: ${JSON.stringify(name)}, background: "#d7c09b" };\n\nexport const Home = { name: "Home", route: "/", frame: { x: 0, y: 0, width: 1280, height: 800 } };\n\nexport const Mobile = { name: "Home on mobile", route: "/", frame: { x: 1340, y: 0, width: 390, height: 844 } };\n`,
  };
}

/** A folder of static HTML mockups with a canvas laying them out. */
function mockupFiles(name: string): Record<string, string> {
  return {
    ".gitignore": GITIGNORE,
    "mockups/index.html": `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1" />\n    <title>${name.replace(/</g, "&lt;")}</title>\n  </head>\n  <body style="margin:0;font-family:system-ui;display:grid;place-items:center;min-height:100vh;background:#fafafa;color:#71717a">\n    <p>Designing...</p>\n  </body>\n</html>\n`,
    "mockups.canvas.tsx": `export default { name: ${JSON.stringify(name)}, background: "#d7c09b" };\n\nexport const Desktop = { name: "Desktop", html: "mockups/index.html", frame: { x: 0, y: 0, width: 1280, height: 800 } };\n\nexport const Mobile = { name: "Mobile", html: "mockups/index.html", frame: { x: 1340, y: 0, width: 390, height: 844 } };\n`,
  };
}

export function starterFiles(kind: StarterKind, name: string): Record<string, string> {
  if (kind === "prototype") return prototypeFiles(name);
  if (kind === "mockup") return mockupFiles(name);
  return { ".gitignore": GITIGNORE };
}

/** The first message the agent gets for a new project. */
export function starterPrompt(kind: StarterKind, idea: string): string {
  const what = idea.trim();
  if (kind === "mockup") {
    return [
      `Design this as polished static HTML mockups: ${what}`,
      "",
      "Write self-contained HTML and CSS (no build step, no external scripts) in mockups/. Replace mockups/index.html with the main screen, and add one file per further screen or state. Make it look finished: real copy, a clear visual hierarchy, consistent spacing, and a deliberate color palette.",
      "Add a frame to mockups.canvas.tsx for each file (html: \"mockups/<file>.html\"), with desktop and mobile frames where it matters. Check them with canvas_screenshot and fix what looks off.",
      "Commit when done and reply with a short list of the screens.",
    ].join("\n");
  }
  if (kind === "prototype") {
    return [
      `Build a working clickable prototype of this: ${what}`,
      "",
      "This is a Vite + React + Tailwind app (Cadence ran npm install). Build the screens in src/, with real interactions and in-memory data; no backend. Keep components small and named well.",
      "src/app.canvas.tsx shows the home route at desktop and mobile sizes. Add a frame for each important screen or state (render: () => <Component />, importing it), check them with canvas_screenshot, and open the app with browser_open at the dev server to click through it.",
      "Run npm run build to make sure it compiles, commit, and reply with what you built and how to try it.",
    ].join("\n");
  }
  return what ? `This is a new, empty project. ${what}` : "This is a new, empty project. Ask what to build first.";
}
