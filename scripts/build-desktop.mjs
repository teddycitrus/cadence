// Bundles the desktop app: the Electron main process and the Cadence server.
// Both land in dist/desktop, two folders deep like src/<area>, so the server's
// paths to dist/web and packages/ resolve the same as when run from source.
// npm packages stay external: they ship in node_modules beside it.
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = `${root}dist/desktop`;
mkdirSync(out, { recursive: true });

const common = { bundle: true, platform: "node", target: "node24", packages: "external", sourcemap: "linked", logLevel: "warning", absWorkingDir: root };

await build({ ...common, entryPoints: ["src/server/main.ts"], outfile: `${out}/server.mjs`, format: "esm", banner: { js: `import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);` } });
await build({ ...common, entryPoints: ["src/desktop/main.ts"], outfile: `${out}/main.cjs`, format: "cjs", external: ["electron"] });
// The stdio proxy other harnesses spawn sits beside the server, as it does beside its source.
copyFileSync(`${root}src/agents/acp/mcp-stdio-proxy.mjs`, `${out}/mcp-stdio-proxy.mjs`);
// The browser engine used when no Chrome or Edge is installed (src/browser/chrome.ts finds it beside the server).
copyFileSync(`${root}src/desktop/browser-host.cjs`, `${out}/browser-host.cjs`);
// The window's preload (the desktop bridge) stays plain CommonJS, as sandboxed preloads must be.
copyFileSync(`${root}src/desktop/preload.cjs`, `${out}/preload.cjs`);
// The window and taskbar icon (the installer embeds its own copy in the executable).
copyFileSync(`${root}src/desktop/icon.png`, `${out}/icon.png`);
console.log("desktop bundle: dist/desktop/{main.cjs,server.mjs}");
