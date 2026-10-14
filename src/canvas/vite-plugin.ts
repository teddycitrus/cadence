import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Plugin } from "vite";
import { parseCanvas } from "./parse";
import { JSX_TAG_MODULE } from "./jsx-compat";
import { BRIDGE_SOURCE } from "./bridge";
import { stampSvelte, svelteCompiler } from "./svelte";

// One stamping implementation, shared with the Next.js loader in packages/cadence-build.
export { LOC_ATTR, stampLocations } from "../../packages/cadence-build/stamp.cjs";
import { stampLocations } from "../../packages/cadence-build/stamp.cjs";

const STORY_ENTRY = "\0cadence-story";
/** The bridge module, by its resolved id (the devserver invalidates it when the allowed origins change). */
export const BRIDGE_MODULE_ID = "\0cadence-bridge";
/** Component-format canvases import their tags from a module (JSX_TAG_MODULE); the canvas devserver serves a stand-in. */
const JSX_TAGS_ID = "\0cadence-jsx-tags";

// Stand-ins for the component format's tags. The story page sets the frame to show,
// renders the canvas's default export, and only that frame renders.
const JSX_TAGS_SOURCE = [
  `import { createElement, Fragment } from "react";`,
  `export function Canvas(p) { return createElement(Fragment, null, p.children); }`,
  `export function Storyboard(p) { return p.id === globalThis.__cadenceStoryId && p.component ? createElement(p.component, p.props || {}) : null; }`,
  `export function SvelteStoryboard() { return null; }`,
  `export function RouteStoryboard() { return null; }`,
  `export function HtmlStoryboard() { return null; }`,
  `export default {};`,
].join("\n");

/** Finds a component-format frame's element props by walking what the canvas component returns. */
const FIND_COMPONENT_STORY = [
  `function componentStory(mod, id) {`,
  `  if (typeof mod.default !== "function") return null;`,
  `  const find = (el) => {`,
  `    if (!el || typeof el !== "object") return null;`,
  `    if (Array.isArray(el)) { for (const c of el) { const f = find(c); if (f) return f; } return null; }`,
  `    const p = el.props || {};`,
  `    return p.id === id ? p : find(p.children);`,
  `  };`,
  `  try { return find(mod.default({})); } catch { return null; }`,
  `}`,
].join("\n");

const SAFE_PATH = /^[\w./@-]+\.canvas\.[jt]sx?$/;
const SAFE_ID = /^[A-Za-z_$][\w$]*$/;

/** The .svelte component a frame mounts, if it is a Svelte frame. */
function svelteStory(root: string, canvas: string, story: string): string | null {
  try {
    return parseCanvas(readFileSync(join(root, canvas), "utf8"), canvas).storyboards.find((s) => s.id === story)?.svelte ?? null;
  } catch {
    return null;
  }
}

/** Mounts a Svelte component with the frame's props (Svelte 5's mount, or a Svelte 4 constructor). */
function svelteEntry(canvas: string, story: string, component: string): string {
  return [
    `import * as canvas from ${JSON.stringify(`/${canvas}`)};`,
    `import Component from ${JSON.stringify(`/${component}`)};`,
    `import * as svelte from "svelte";`,
    FIND_COMPONENT_STORY,
    `const story = canvas[${JSON.stringify(story)}] ?? componentStory(canvas, ${JSON.stringify(story)});`,
    `const target = document.getElementById("root");`,
    `const props = (story && story.props) || {};`,
    `try {`,
    `  if (typeof svelte.mount === "function") svelte.mount(Component, { target, props });`,
    `  else new Component({ target, props });`,
    `} catch (error) {`,
    `  window.__cadenceReport?.(error);`,
    `  const pre = document.createElement("pre");`,
    `  pre.style.cssText = "color:#b6452a;padding:16px;white-space:pre-wrap;font:12px ui-monospace,monospace";`,
    `  pre.textContent = String(error && error.stack || error);`,
    `  target.replaceChildren(pre);`,
    `}`,
  ].join("\n");
}

/**
 * The canvas devserver plugin: stamps source locations, serves single
 * frames at /__cadence/story, and injects the selection bridge (which
 * only talks to the Cadence window that opened it) into every page.
 */
export function cadenceCanvasPlugin(root: string, parentOrigins: string[]): Plugin {
  return {
    name: "cadence-canvas",
    enforce: "pre",
    resolveId(id) {
      if (id === "/@cadence/bridge" || id === BRIDGE_MODULE_ID) return BRIDGE_MODULE_ID;
      if (JSX_TAG_MODULE.test(id)) return JSX_TAGS_ID;
      if (id.startsWith("/@cadence/story?")) return STORY_ENTRY + id.slice("/@cadence/story".length);
      return null;
    },
    load(id) {
      if (id === BRIDGE_MODULE_ID) return BRIDGE_SOURCE.replace("__PARENT_ORIGINS__", JSON.stringify(parentOrigins));
      if (id === JSX_TAGS_ID) return JSX_TAGS_SOURCE;
      if (!id.startsWith(STORY_ENTRY)) return null;
      const params = new URLSearchParams(id.slice(STORY_ENTRY.length + 1));
      const canvas = params.get("canvas") ?? "";
      const story = params.get("story") ?? "";
      if (!SAFE_PATH.test(canvas) || canvas.includes("..") || !SAFE_ID.test(story)) return `throw new Error("Invalid frame reference");`;
      const svelte = svelteStory(root, canvas, story);
      if (svelte) return svelteEntry(canvas, story, svelte);
      return [
        `import { createElement, Component } from "react";`,
        `import { createRoot } from "react-dom/client";`,
        `import * as canvas from ${JSON.stringify(`/${canvas}`)};`,
        `const story = canvas[${JSON.stringify(story)}];`,
        `class Boundary extends Component { constructor(p) { super(p); this.state = { error: null }; }`,
        `  static getDerivedStateFromError(error) { return { error }; }`,
        `  componentDidCatch(error) { window.__cadenceReport?.(error); }`,
        `  render() { return this.state.error ? createElement("pre", { style: { color: "#b6452a", padding: 16, whiteSpace: "pre-wrap", font: "12px ui-monospace, monospace" } }, String(this.state.error?.stack ?? this.state.error)) : this.props.children; } }`,
        `const root = createRoot(document.getElementById("root"));`,
        // The component format: render the canvas component; the stand-in tags show only this frame.
        `if (!story && typeof canvas.default === "function") { globalThis.__cadenceStoryId = ${JSON.stringify(story)}; root.render(createElement(Boundary, null, createElement(canvas.default))); }`,
        `else if (!story || typeof story.render !== "function") root.render(createElement("p", { style: { color: "#a39383", padding: 16 } }, "Frame ${story} has no render function."));`,
        `else root.render(createElement(Boundary, null, createElement(story.render)));`,
      ].join("\n");
    },
    // Runs before any other transform, so .svelte markup is stamped before Svelte compiles it.
    transform: {
      order: "pre",
      handler(code, id) {
        const file = id.split("?")[0]!;
        const svelte = file.endsWith(".svelte") && !id.includes("?svelte&type=");
        if ((!/\.[jt]sx$/.test(file) && !svelte) || file.includes(`${sep}node_modules${sep}`) || file.includes("/node_modules/")) return null;
        const rel = relative(root, file).split(sep).join("/");
        if (rel.startsWith("..")) return null;
        if (!svelte) return stampLocations(code, rel);
        const compiler = svelteCompiler(root);
        return compiler ? stampSvelte(code, rel, compiler) : null;
      },
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== "/__cadence/story") return next();
        const entry = `/@cadence/story?${url.searchParams.toString()}`;
        const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Frame</title></head><body style="margin:0"><div id="root"></div><script type="module" src="${entry.replace(/"/g, "&quot;")}"></script></body></html>`;
        void server.transformIndexHtml(req.url ?? "/", html).then((out) => {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(out);
        }, next);
      });
    },
    transformIndexHtml() {
      return [{ tag: "script", attrs: { type: "module", src: "/@cadence/bridge" }, injectTo: "head-prepend" }];
    },
  };
}
