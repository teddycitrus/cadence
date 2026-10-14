import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import MagicString from "magic-string";
import type { Node } from "@babel/types";
import { ValidationError } from "../core/errors";
import { parseSource } from "./parse";

// Sets up the cadence-build plugins in a Next.js or Expo project, so route
// frames served by the app's own dev server can be selected and edited.

export const BUILD_PACKAGE_DIR = fileURLToPath(new URL("../../packages/cadence-build", import.meta.url));

export type Framework = "next" | "expo" | "vite" | "other";

export interface BuildStatus {
  framework: Framework;
  /** The config file that loads the plugin, when there is one. */
  configFile: string | null;
  configured: boolean;
  installed: boolean;
  /** The dev command a canvas can use as appCommand. */
  appCommand: string | null;
}

const NEXT_CONFIGS = ["next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs"];

/**
 * Expo's default Babel setup, written out so the plugin can be added. Newer
 * SDKs keep babel-preset-expo inside the expo package rather than at the top
 * level, so it is resolved from there when it is not installed directly.
 */
export const EXPO_BABEL_CONFIG = `function expoPreset() {
  try {
    return require.resolve("babel-preset-expo");
  } catch {
    return require.resolve("babel-preset-expo", { paths: [require.resolve("expo/package.json")] });
  }
}

module.exports = function (api) {
  api.cache(true);
  return { presets: [expoPreset()] };
};
`;
const BABEL_CONFIGS = ["babel.config.js", "babel.config.cjs", ".babelrc.js"];

function pkg(root: string): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return {};
  }
}

const has = (p: ReturnType<typeof pkg>, name: string) => Boolean(p.dependencies?.[name] ?? p.devDependencies?.[name]);

export function buildStatus(root: string): BuildStatus {
  const p = pkg(root);
  const installed = has(p, "cadence-build");
  if (has(p, "next")) {
    const configFile = NEXT_CONFIGS.find((f) => existsSync(join(root, f))) ?? null;
    const configured = Boolean(configFile && readFileSync(join(root, configFile), "utf8").includes("cadence-build/next"));
    return { framework: "next", configFile, configured, installed, appCommand: "npx next dev --port {port}" };
  }
  if (has(p, "expo")) {
    const configFile = BABEL_CONFIGS.find((f) => existsSync(join(root, f))) ?? null;
    const configured = Boolean(configFile && readFileSync(join(root, configFile), "utf8").includes("cadence-build/babel"));
    // --clear: Metro's transform cache does not know about CADENCE, so files built without it would stay unstamped.
    return { framework: "expo", configFile, configured, installed, appCommand: "npx expo start --web --port {port} --clear" };
  }
  // Vite projects are stamped by the canvas devserver itself.
  if (has(p, "vite")) return { framework: "vite", configFile: null, configured: true, installed, appCommand: null };
  return { framework: "other", configFile: null, configured: false, installed, appCommand: null };
}

/** Wraps `module.exports = X` or `export default X` with withCadence(X), adding the import. */
export function wrapNextConfig(source: string, esm: boolean): string | null {
  if (source.includes("cadence-build/next")) return source;
  const ast = parseSource(source);
  const s = new MagicString(source);
  let wrapped = false;
  for (const stmt of ast.program.body) {
    if (stmt.type === "ExportDefaultDeclaration" && stmt.declaration.type !== "FunctionDeclaration" && stmt.declaration.type !== "ClassDeclaration" && stmt.declaration.type !== "TSInterfaceDeclaration") {
      const d = stmt.declaration as Node;
      s.appendLeft(d.start!, "withCadence(");
      s.appendRight(d.end!, ")");
      wrapped = true;
    }
    if (stmt.type === "ExpressionStatement" && stmt.expression.type === "AssignmentExpression") {
      const left = stmt.expression.left;
      if (left.type === "MemberExpression" && left.object.type === "Identifier" && left.object.name === "module" && left.property.type === "Identifier" && left.property.name === "exports") {
        s.appendLeft(stmt.expression.right.start!, "withCadence(");
        s.appendRight(stmt.expression.right.end!, ")");
        wrapped = true;
      }
    }
  }
  if (!wrapped) return null;
  s.prepend(esm ? `import { withCadence } from "cadence-build/next";\n` : `const { withCadence } = require("cadence-build/next");\n`);
  return s.toString();
}

/** Adds "cadence-build/babel" to the plugins of a Babel config (or a plugins list next to presets). */
export function addBabelPlugin(source: string): string | null {
  if (source.includes("cadence-build/babel")) return source;
  const s = new MagicString(source);
  let done = false;
  const visit = (node: unknown): void => {
    if (done || !node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const n = node as Node & Record<string, unknown>;
    if (n.type === "ObjectExpression") {
      const key = (p: Node) => (p.type === "ObjectProperty" && p.key.type === "Identifier" ? p.key.name : p.type === "ObjectProperty" && p.key.type === "StringLiteral" ? p.key.value : null);
      const plugins = n.properties.find((p) => key(p) === "plugins");
      if (plugins?.type === "ObjectProperty" && plugins.value.type === "ArrayExpression") {
        const arr = plugins.value;
        if (arr.elements.length) s.appendLeft(arr.elements.at(-1)!.end!, `, "cadence-build/babel"`);
        else s.overwrite(arr.start!, arr.end!, `["cadence-build/babel"]`);
        done = true;
        return;
      }
      if (n.properties.some((p) => key(p) === "presets")) {
        s.appendLeft(n.properties.at(-1)!.end!, `, plugins: ["cadence-build/babel"]`);
        done = true;
        return;
      }
    }
    for (const [k, v] of Object.entries(n)) if (k !== "loc" && v && typeof v === "object") visit(v);
  };
  visit(parseSource(source).program);
  return done ? s.toString() : null;
}

function installCommand(root: string): [string, string[]] {
  const dir = BUILD_PACKAGE_DIR;
  if (existsSync(join(root, "pnpm-lock.yaml"))) return ["pnpm", ["add", "-D", dir]];
  if (existsSync(join(root, "yarn.lock"))) return ["yarn", ["add", "-D", dir]];
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return ["bun", ["add", "-d", dir]];
  return ["npm", ["install", "--save-dev", dir]];
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = "";
    // A shell finds npm.cmd and friends on Windows; the path is quoted.
    const child = spawn([cmd, ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(" "), { cwd, shell: true, windowsHide: true });
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new ValidationError(`${cmd} failed: ${out.trim().split("\n").slice(-5).join("\n")}`))));
  });
}

/**
 * Installs cadence-build (from this Cadence checkout) and loads it in the
 * project's Next.js or Babel config. Returns the files it changed.
 */
export async function setUpBuildPlugin(root: string, options: { install?: boolean } = {}): Promise<{ status: BuildStatus; changed: string[] }> {
  const before = buildStatus(root);
  const changed: string[] = [];
  if (before.framework !== "next" && before.framework !== "expo") throw new ValidationError(before.framework === "vite" ? "Vite projects need no build plugin; the canvas devserver stamps them" : "Only Next.js and Expo projects use the build plugin");
  if (!before.installed && options.install !== false) {
    const [cmd, args] = installCommand(root);
    await run(cmd, args, root);
    changed.push("package.json");
  }
  if (!before.configured) {
    if (before.framework === "next") {
      const file = before.configFile ?? "next.config.mjs";
      const path = join(root, file);
      const source = existsSync(path) ? readFileSync(path, "utf8") : `/** @type {import("next").NextConfig} */\nexport default {};\n`;
      const next = wrapNextConfig(source, !file.endsWith(".cjs") && !/module\.exports/.test(source));
      if (!next) throw new ValidationError(`Could not find the exported config in ${file}; wrap it with withCadence from "cadence-build/next" by hand`);
      writeFileSync(path, next);
      changed.push(file);
    } else {
      const file = before.configFile ?? "babel.config.js";
      const path = join(root, file);
      const source = existsSync(path) ? readFileSync(path, "utf8") : EXPO_BABEL_CONFIG;
      const next = addBabelPlugin(source);
      if (!next) throw new ValidationError(`Could not find the plugins list in ${file}; add "cadence-build/babel" to it by hand`);
      writeFileSync(path, next);
      changed.push(file);
    }
  }
  return { status: buildStatus(root), changed };
}
