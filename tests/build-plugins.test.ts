import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { AppProxies, injectBridge } from "../src/canvas/app-proxy";
import { AppDevServers } from "../src/canvas/app-servers";
import { addBabelPlugin, buildStatus, wrapNextConfig } from "../src/canvas/build-setup";
import { parseCanvas } from "../src/canvas/parse";
import { setCanvasSetting } from "../src/canvas/edit";
import { removeTempDir } from "./helpers/temp-dir";

const require = createRequire(import.meta.url);
const loader = require("../packages/cadence-build/loader.cjs") as (this: unknown, source: string) => string;
const { withCadence } = require("../packages/cadence-build/next.cjs") as { withCadence: (c: object) => Record<string, any> };
const babelPlugin = require("../packages/cadence-build/babel.cjs");

const withEnv = <T>(value: string | undefined, fn: () => T): T => {
  const before = process.env.CADENCE;
  if (value === undefined) delete process.env.CADENCE;
  else process.env.CADENCE = value;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.CADENCE;
    else process.env.CADENCE = before;
  }
};

describe("Next.js plugin", () => {
  const ctx = (file: string) => ({ resourcePath: file, rootContext: "/app" });

  it("stamps JSX only when Cadence runs the dev server", () => {
    const src = `export default function Page() {\n  return <main className="p-4"><Card /></main>;\n}\n`;
    expect(withEnv(undefined, () => loader.call(ctx("/app/app/page.tsx"), src))).toBe(src);
    const out = withEnv("1", () => loader.call(ctx("/app/app/page.tsx"), src));
    expect(out).toContain(`<main data-cadence-loc="app/page.tsx:2:9" className="p-4">`);
    expect(out).toContain("<Card />");
    expect(withEnv("1", () => loader.call(ctx("/app/node_modules/x/index.jsx"), src))).toBe(src);
  });

  it("adds the loader for webpack and Turbopack, keeping the project's own config", () => {
    expect(withEnv(undefined, () => withCadence({ reactStrictMode: true }))).toEqual({ reactStrictMode: true });
    const own = (c: { module: { rules: unknown[] } }) => (c.module.rules.push("own"), c);
    const cfg = withEnv("1", () => withCadence({ webpack: own, turbopack: { rules: { "*.svg": { loaders: ["svgr"] }, "*.tsx": { loaders: ["mine"] } } } }));
    expect(Object.keys(cfg.turbopack.rules)).toEqual(["*.svg", "*.tsx", "*.jsx"]);
    expect(cfg.turbopack.rules["*.tsx"].loaders).toEqual(["mine", expect.stringMatching(/loader\.cjs$/)]);
    const webpackConfig = cfg.webpack({ module: { rules: [] } }, {});
    expect(webpackConfig.module.rules).toEqual(["own", expect.objectContaining({ enforce: "pre", test: /\.[jt]sx$/ })]);
  });

  it("wraps CommonJS, ESM, and TypeScript configs", () => {
    expect(wrapNextConfig(`/** @type {import('next').NextConfig} */\nmodule.exports = { images: {} };\n`, false)).toBe(`const { withCadence } = require("cadence-build/next");\n/** @type {import('next').NextConfig} */\nmodule.exports = withCadence({ images: {} });\n`);
    expect(wrapNextConfig(`const nextConfig = {};\nexport default nextConfig;\n`, true)).toBe(`import { withCadence } from "cadence-build/next";\nconst nextConfig = {};\nexport default withCadence(nextConfig);\n`);
    expect(wrapNextConfig(`import type { NextConfig } from "next";\nconst nextConfig: NextConfig = {};\nexport default nextConfig;\n`, true)).toContain("export default withCadence(nextConfig);");
    expect(wrapNextConfig(`console.log("no export")`, true)).toBeNull();
  });
});

describe("Expo plugin", () => {
  const compile = (code: string, on: boolean) =>
    withEnv(on ? "1" : undefined, () => transformSync(code, { filename: "/proj/app/index.tsx", cwd: "/proj", babelrc: false, configFile: false, parserOpts: { plugins: ["jsx", "typescript"] }, plugins: [babelPlugin] })!.code!);

  it("tags React Native components with dataSet and DOM elements with the attribute", () => {
    const out = compile(`import { View, Text, Animated } from "react-native";\nimport { Card } from "./Card";\nexport default () => (\n  <View style={{ flex: 1 }}>\n    <Text dataSet={{ testid: "t" }}>Hi</Text>\n    <Animated.View />\n    <Card />\n    <div />\n  </View>\n);\n`, true);
    expect(out).toMatch(/<View style=\{\{\s+flex: 1\s+\}\} dataSet=\{\{\s+cadenceLoc: "app\/index.tsx:4:2"\s+\}\}>/);
    expect(out).toMatch(/testid: "t",\s+cadenceLoc: "app\/index.tsx:5:4"/);
    expect(out).toContain(`cadenceLoc: "app/index.tsx:6:4"`);
    expect(out).toContain(`<div data-cadence-loc="app/index.tsx:8:4" />`);
    // A project component is not from react-native, so it is left alone.
    expect(out).toContain("<Card />");
  });

  it("still tags components when another plugin rewrites the react-native imports first (Expo on web)", () => {
    // Like Expo's web preset: imports from react-native become react-native-web requires.
    const rewrite = ({ types: t }: { types: typeof import("@babel/types") }) => ({
      visitor: {
        ImportDeclaration(p: { node: { source: { value: string }; specifiers: { local: { name: string } }[] }; replaceWithMultiple: (n: unknown[]) => void }) {
          if (p.node.source.value !== "react-native") return;
          p.replaceWithMultiple(p.node.specifiers.map((s) => t.variableDeclaration("var", [t.variableDeclarator(t.identifier(s.local.name), t.callExpression(t.identifier("require"), [t.stringLiteral(`react-native-web/dist/exports/${s.local.name}`)]))])));
        },
      },
    });
    const out = withEnv("1", () => transformSync(`import { View } from "react-native";
export default () => <View />;
`, { filename: "/proj/App.tsx", cwd: "/proj", babelrc: false, configFile: false, parserOpts: { plugins: ["jsx"] }, plugins: [babelPlugin, rewrite] })!.code!);
    expect(out).toContain(`require("react-native-web/dist/exports/View")`);
    expect(out).toContain(`cadenceLoc: "App.tsx:2:21"`);
  });

  it("does nothing without CADENCE=1", () => {
    expect(compile(`import { View } from "react-native";\nconst a = <View />;\n`, false)).not.toContain("cadence");
  });

  it("adds itself to babel.config.js", () => {
    expect(addBabelPlugin(`module.exports = function (api) {\n  api.cache(true);\n  return { presets: ["babel-preset-expo"], plugins: ["react-native-reanimated/plugin"] };\n};\n`)).toContain(`plugins: ["react-native-reanimated/plugin", "cadence-build/babel"]`);
    expect(addBabelPlugin(`module.exports = { presets: ["babel-preset-expo"] };`)).toBe(`module.exports = { presets: ["babel-preset-expo"], plugins: ["cadence-build/babel"] };`);
  });
});

describe("project detection and canvas settings", () => {
  let dir: string;
  afterEach(() => removeTempDir(dir));

  it("knows Next.js, Expo, and Vite projects and whether they are set up", () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-build-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" } }));
    expect(buildStatus(dir)).toMatchObject({ framework: "next", configFile: null, configured: false, installed: false, appCommand: "npx next dev --port {port}" });
    writeFileSync(join(dir, "next.config.mjs"), wrapNextConfig("export default {};\n", true)!);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { next: "16.0.0" }, devDependencies: { "cadence-build": "file:../cadence" } }));
    expect(buildStatus(dir)).toMatchObject({ configFile: "next.config.mjs", configured: true, installed: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { expo: "55.0.0" } }));
    expect(buildStatus(dir)).toMatchObject({ framework: "expo", appCommand: "npx expo start --web --port {port} --clear" });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { vite: "8.0.0" } }));
    expect(buildStatus(dir)).toMatchObject({ framework: "vite", configured: true });
  });

  it("writes appCommand into the canvas and refuses shell operators", () => {
    const next = setCanvasSetting(`export default { name: "App" };\n`, "appCommand", "npx next dev --port {port}")!;
    expect(next).toBe(`export default { name: "App", appCommand: "npx next dev --port {port}" };\n`);
    expect(parseCanvas(next).appCommand).toBe("npx next dev --port {port}");
    const bad = parseCanvas(`export default { appCommand: "npm run dev; rm -rf /" };`);
    expect(bad.appCommand).toBeNull();
    expect(bad.errors[0]).toMatch(/not a plain dev command/);
  });
});

describe("app proxy and dev server supervisor", () => {
  const closers: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
  });

  it("injects the bridge into HTML, strips frame blockers, rewrites redirects, and passes websockets", async () => {
    const app: Server = createServer((req, res) => {
      if (req.url === "/old") return void res.writeHead(302, { Location: `http://127.0.0.1:${(app.address() as AddressInfo).port}/new` }).end();
      if (req.url === "/data.json") return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ a: 1, origin: req.headers.origin ?? null }));
      res.writeHead(200, { "Content-Type": "text/html", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" });
      res.end(`<!doctype html><html><head><title>App</title></head><body><main data-cadence-loc="app/page.tsx:2:9">Hi</main></body></html>`);
    });
    const wss = new WebSocketServer({ server: app });
    wss.on("connection", (s) => s.on("message", (m) => s.send(`echo:${m}`)));
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
    closers.push(() => new Promise((r) => (wss.close(), app.close(() => r(undefined)), app.closeAllConnections())));
    const proxies = new AppProxies(["http://127.0.0.1:4317"]);
    closers.push(() => proxies.stopAll());
    const url = await proxies.ensure(`http://localhost:${(app.address() as AddressInfo).port}`);

    const page = await fetch(`${url}/`);
    expect(page.headers.get("x-frame-options")).toBeNull();
    expect(page.headers.get("content-security-policy")).toBeNull();
    const html = await page.text();
    expect(html).toContain(`<head><script src="/__cadence/bridge.js"></script><title>`);
    expect(html).toContain(`data-cadence-loc="app/page.tsx:2:9"`);
    const bridge = await (await fetch(`${url}/__cadence/bridge.js`)).text();
    expect(bridge).toContain(`["http://127.0.0.1:4317"]`);
    expect(bridge).not.toContain("import.meta");
    expect(() => new Function(bridge)).not.toThrow();
    expect(await (await fetch(`${url}/data.json`)).json()).toEqual({ a: 1, origin: null });
    // Dev servers refuse cross-origin HMR and dev requests, so the app sees its own origin.
    const appOrigin = `http://localhost:${(app.address() as AddressInfo).port}`;
    expect(await (await fetch(`${url}/data.json`, { headers: { Origin: url } })).json()).toEqual({ a: 1, origin: appOrigin });
    const redirect = await fetch(`${url}/old`, { redirect: "manual" });
    expect(redirect.headers.get("location")).toBe("/new");

    const ws = new WebSocket(url.replace("http", "ws"));
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("ping"));
      ws.on("message", (m) => resolve(String(m)));
      ws.on("error", reject);
    });
    ws.close();
    expect(reply).toBe("echo:ping");
    await expect(proxies.ensure("http://example.com")).rejects.toThrow(/this machine/);
  });

  it("starts the app with CADENCE=1 and the port it picked, and reports a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cadence-app-"));
    writeFileSync(join(dir, "server.cjs"), `require("http").createServer((q, s) => s.end("cadence=" + process.env.CADENCE + " port=" + process.argv[2])).listen(Number(process.env.PORT), "127.0.0.1");\n`);
    writeFileSync(join(dir, "crash.cjs"), `console.error("boom: missing module"); process.exit(1);\n`);
    const servers = new AppDevServers();
    // Stop the app before removing its folder (Windows keeps a running process's folder locked).
    closers.push(() => servers.stopAll());
    closers.push(() => removeTempDir(dir));
    const url = await servers.ensure(dir, `node server.cjs {port}`);
    const port = new URL(url).port;
    expect(await (await fetch(url)).text()).toBe(`cadence=1 port=${port}`);
    expect(await servers.ensure(dir, `node server.cjs {port}`)).toBe(url);
    await expect(servers.ensure(dir, "node crash.cjs")).rejects.toThrow(/boom: missing module/);
    await expect(servers.ensure(dir, "node server.cjs; rm -rf /")).rejects.toThrow(/not a dev server command/);
    expect(readFileSync(join(dir, "server.cjs"), "utf8")).toContain("process.env.PORT");
  }, 60_000);

  it("injects before the body when a page has no head", () => {
    expect(injectBridge("<p>x</p>")).toBe(`<script src="/__cadence/bridge.js"></script><p>x</p>`);
  });
});
