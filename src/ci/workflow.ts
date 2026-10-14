import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const WORKFLOW_PATH = ".github/workflows/visual-review.yml";

/** The package manager a repo uses, from its lockfile. */
export function packageManager(root: string): "pnpm" | "yarn" | "bun" | "npm" | null {
  if (!existsSync(join(root, "package.json"))) return null;
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  return "npm";
}

const INSTALL: Record<NonNullable<ReturnType<typeof packageManager>>, string> = {
  npm: "npm ci",
  pnpm: "corepack enable && pnpm install --frozen-lockfile",
  yarn: "corepack enable && yarn install --immutable",
  bun: "npm install -g bun && bun install --frozen-lockfile",
};

/**
 * The GitHub Actions workflow that runs Cadence's visual check on pull
 * requests. Cadence is checked out next to the repo from the repository named
 * in the CADENCE_REPOSITORY variable (Settings > Secrets and variables >
 * Actions > Variables), so no package has to be published.
 */
export function workflowYaml(root: string): string {
  const pm = packageManager(root);
  const install = pm ? INSTALL[pm] : "echo 'No package.json; nothing to install'";
  return `# Cadence visual check: renders every tracked frame, compares it with the
# baseline committed in .cadence/vrt, and reports on the pull request.
# Set the repository variable CADENCE_REPOSITORY (owner/name of your Cadence checkout).
name: visual-review

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write
  statuses: write

concurrency:
  group: visual-review-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  visual-review:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install the project
        run: ${install}
      - name: Check out Cadence
        uses: actions/checkout@v4
        with:
          repository: \${{ vars.CADENCE_REPOSITORY }}
          ref: \${{ vars.CADENCE_REF || 'main' }}
          path: .cadence-tool
      - name: Install Cadence
        run: npm ci --prefix .cadence-tool
      - name: Capture frames
        env:
          CADENCE_CHROME_ARGS: --no-sandbox
        run: node .cadence-tool/node_modules/tsx/dist/cli.mjs .cadence-tool/src/ci/visual-review-cli.ts capture --root . --out visual-review
      - name: Upload images
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: visual-review
          path: visual-review
          if-no-files-found: ignore
      - name: Report on the pull request
        if: always()
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: node .cadence-tool/node_modules/tsx/dist/cli.mjs .cadence-tool/src/ci/visual-review-cli.ts report --out visual-review
`;
}

export interface DoctorRow {
  check: string;
  ok: boolean | null;
  detail: string;
  fix?: string;
}

/**
 * Visual check setup, one layer at a time: the workflow, tracked frames,
 * their baselines, and the GitHub side. `null` means it cannot be checked from
 * here (never a guess).
 */
export function doctor(root: string, tracked: { path: string; storyId: string }[], github: { repo: string | null; variableSet: boolean | null }): DoctorRow[] {
  const rows: DoctorRow[] = [];
  const workflow = join(root, WORKFLOW_PATH);
  const yaml = existsSync(workflow) ? readFileSync(workflow, "utf8") : null;
  rows.push(yaml ? { check: "workflow", ok: yaml.includes("visual-review-cli.ts"), detail: yaml.includes("visual-review-cli.ts") ? `${WORKFLOW_PATH} runs Cadence's visual check` : `${WORKFLOW_PATH} exists but does not run Cadence's visual check`, fix: "Compare it with what visual_review_init writes; it never overwrites an existing file" } : { check: "workflow", ok: false, detail: `No ${WORKFLOW_PATH}`, fix: "Run visual_review_init" });
  rows.push({ check: "package", ok: packageManager(root) !== null, detail: packageManager(root) ? `Installs with ${packageManager(root)}` : "No package.json at the root", fix: "Canvases render the project's components, so the workflow must install its dependencies" });
  rows.push({ check: "tracked frames", ok: tracked.length > 0, detail: `${tracked.length} frame${tracked.length === 1 ? "" : "s"} tracked`, fix: "Track frames with canvas_set_visual after canvas_verify_visual says they are stable" });
  const missing = tracked.filter((t) => !existsSync(join(root, ".cadence", "vrt", t.path.replace(/\.canvas\.[jt]sx?$/, ""), `${t.storyId}.png`)));
  rows.push({ check: "baselines", ok: tracked.length > 0 && missing.length === 0, detail: missing.length ? `${missing.length} tracked frame${missing.length === 1 ? " has" : "s have"} no baseline: ${missing.slice(0, 5).map((m) => `${m.path}#${m.storyId}`).join(", ")}` : "Every tracked frame has a baseline", fix: "Save baselines with canvas_accept_baseline and commit .cadence/vrt" });
  const lfs = existsSync(join(root, ".gitattributes")) && /\.cadence\/vrt.*filter=lfs/.test(readFileSync(join(root, ".gitattributes"), "utf8"));
  rows.push({ check: "baselines in git", ok: lfs ? null : true, detail: lfs ? "Baselines are in Git LFS; the workflow's checkout needs lfs: true" : "Baselines are plain files in git" });
  rows.push({ check: "GitHub repository", ok: github.repo ? true : null, detail: github.repo ? `Project points at ${github.repo}` : "No GitHub repository set on the project (cannot check the GitHub side)" });
  rows.push({ check: "CADENCE_REPOSITORY variable", ok: github.variableSet, detail: github.variableSet === null ? "Cannot read repository variables from here; make sure CADENCE_REPOSITORY is set" : github.variableSet ? "Set" : "Not set", fix: "In the repository's Settings > Secrets and variables > Actions > Variables, set CADENCE_REPOSITORY to your Cadence repository (owner/name)" });
  return rows;
}
