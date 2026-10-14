// electron-builder hook. It strips .d.ts files from packaged node_modules, and
// TypeScript's language server will not start without its own lib.*.d.ts files,
// so those are copied back after packing.
const { copyFileSync, existsSync, mkdirSync, readdirSync } = require("node:fs");
const { dirname, join, relative } = require("node:path");

const PACKAGES = ["typescript", "@typescript"];

/** The packaged app folder: resources/app, or Contents/Resources/app inside a macOS bundle. */
function appDir(out) {
  const direct = join(out, "resources", "app");
  if (existsSync(direct)) return direct;
  const bundle = readdirSync(out).find((f) => f.endsWith(".app"));
  return bundle ? join(out, bundle, "Contents", "Resources", "app") : null;
}

/** Every .d.ts file under a folder. */
function declarations(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) declarations(path, out);
    else if (entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

exports.default = async function afterPack(context) {
  const app = appDir(context.appOutDir);
  if (!app) throw new Error(`after-pack: no packaged app folder under ${context.appOutDir}`);
  const modules = join(context.packager.projectDir, "node_modules");
  let copied = 0;
  for (const pkg of PACKAGES) {
    const from = join(modules, pkg);
    if (!existsSync(from) || !existsSync(join(app, "node_modules", pkg))) continue;
    for (const file of declarations(from)) {
      const dest = join(app, "node_modules", relative(modules, file));
      if (existsSync(dest)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(file, dest);
      copied++;
    }
  }
  console.log(`  • after-pack: restored ${copied} TypeScript declaration files`);
};
