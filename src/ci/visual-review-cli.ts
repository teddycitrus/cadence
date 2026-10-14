// Cadence visual check for CI. Usage:
//   tsx src/ci/visual-review-cli.ts capture [--root .] [--out visual-review] [--fail-on-change]
//   tsx src/ci/visual-review-cli.ts report [--out visual-review]
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { captureRepo, reportToGitHub, type CaptureReport } from "./visual-review";

function flag(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const out = resolve(flag(args, "out", "visual-review"));
  if (cmd === "capture") {
    const report = await captureRepo(resolve(flag(args, "root", ".")), out);
    const all = report.canvases.reduce((n, c) => n + c.results.length, 0);
    console.log(`Visual check: ${all} tracked frames, ${report.changed} changed, ${report.missing} without a baseline. Report in ${out}.`);
    return args.includes("--fail-on-change") && report.changed > 0 ? 1 : 0;
  }
  if (cmd === "report") {
    const file = join(out, "report.json");
    if (!existsSync(file)) {
      console.error(`No ${file}; the capture step did not finish.`);
      return 1;
    }
    const r = await reportToGitHub(JSON.parse(readFileSync(file, "utf8")) as CaptureReport, process.env);
    console.log(`Status ${r.state}; comment ${r.comment}`);
    return 0;
  }
  console.error("Usage: visual-review-cli.ts capture [--root .] [--out dir] [--fail-on-change] | report [--out dir]");
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
