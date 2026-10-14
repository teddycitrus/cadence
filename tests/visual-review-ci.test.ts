import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findChrome } from "../src/canvas/browser";
import { captureRepo, reportToGitHub, STATUS_CONTEXT } from "../src/ci/visual-review";
import { doctor, workflowYaml } from "../src/ci/workflow";
import { createGitFixture } from "./helpers/git-fixture";
import { removeTempDir } from "./helpers/temp-dir";

const BUTTON = `export function Button() {
  return <button style={{ background: "#16a34a", color: "#fff", padding: 12, border: "none" }}>Save</button>;
}
`;
const CANVAS = `import { Button } from "./Button";
export default { name: "Buttons" };
export const Save = { name: "Save", render: () => <div style={{ padding: 16, background: "#fff", height: "100%" }}><Button /></div>, frame: { x: 0, y: 0, width: 200, height: 100 } };
export const Untracked = { name: "Untracked", render: () => <Button />, frame: { x: 300, y: 0, width: 200, height: 100 }, vrt: false };
`;

describe("visual check in CI", () => {
  const fx = createGitFixture({ "package.json": `{ "name": "demo", "private": true, "type": "module" }\n`, "src/Button.tsx": BUTTON, "src/buttons.canvas.tsx": CANVAS });
  const out = mkdtempSync(join(tmpdir(), "cadence-vr-out-"));
  afterAll(() => {
    fx.cleanup();
    removeTempDir(out);
  });

  it("writes a workflow for the repo's package manager and diagnoses the setup", () => {
    const yaml = workflowYaml(fx.repo);
    expect(yaml).toContain("run: npm ci");
    expect(yaml).toContain("repository: ${{ vars.CADENCE_REPOSITORY }}");
    expect(yaml).toContain("visual-review-cli.ts capture --root . --out visual-review");
    const rows = doctor(fx.repo, [{ path: "src/buttons.canvas.tsx", storyId: "Save" }], { repo: null, variableSet: null });
    expect(rows.find((r) => r.check === "workflow")!.ok).toBe(false);
    expect(rows.find((r) => r.check === "baselines")!.detail).toContain("src/buttons.canvas.tsx#Save");
    expect(rows.find((r) => r.check === "CADENCE_REPOSITORY variable")!.ok).toBeNull();
  });

  it.skipIf(!findChrome())(
    "captures tracked frames, compares them with baselines, and reports on the pull request",
    async () => {
      const first = await captureRepo(fx.repo, out);
      expect(first.canvases).toHaveLength(1);
      expect(first.canvases[0]!.results.map((r) => [r.storyId, r.status])).toEqual([["Save", "new"]]);
      expect(first.missing).toBe(1);
      const current = join(out, first.canvases[0]!.results[0]!.currentFile!);
      expect(existsSync(current)).toBe(true);

      // Commit the render as the baseline: the next run passes.
      mkdirSync(join(fx.repo, ".cadence/vrt/src/buttons"), { recursive: true });
      copyFileSync(current, join(fx.repo, ".cadence/vrt/src/buttons/Save.png"));
      expect((await captureRepo(fx.repo, out)).canvases[0]!.results[0]!.status).toBe("pass");

      // A visual change fails, with a diff image.
      writeFileSync(join(fx.repo, "src/Button.tsx"), BUTTON.replace("#16a34a", "#dc2626"));
      const changed = await captureRepo(fx.repo, out);
      expect(changed.changed).toBe(1);
      expect(existsSync(join(out, changed.canvases[0]!.results[0]!.diffFile!))).toBe(true);
      expect(readFileSync(join(out, "report.md"), "utf8")).toContain("1 of 1 frame changed");

      const event = join(out, "event.json");
      writeFileSync(event, JSON.stringify({ pull_request: { number: 7, head: { sha: "abc123" } } }));
      const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
      const fakeFetch: typeof fetch = async (input, init) => {
        calls.push({ method: init?.method ?? "GET", url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
        if (String(input).includes("/comments?")) return new Response("[]");
        return new Response(JSON.stringify({ html_url: "https://github.com/acme/demo/pull/7#c1" }));
      };
      const r = await reportToGitHub(changed, { GITHUB_REPOSITORY: "acme/demo", GITHUB_EVENT_PATH: event, GITHUB_TOKEN: "t", GITHUB_SERVER_URL: "https://github.com", GITHUB_RUN_ID: "99" }, fakeFetch);
      expect(r.state).toBe("failure");
      const status = calls.find((x) => x.url.endsWith("/statuses/abc123"))!;
      expect(status.body).toMatchObject({ state: "failure", context: STATUS_CONTEXT, target_url: "https://github.com/acme/demo/actions/runs/99" });
      const comment = calls.find((x) => x.method === "POST" && x.url.endsWith("/issues/7/comments"))!;
      expect(String(comment.body!.body)).toContain("<!-- cadence-visual-check -->");
    },
    180_000,
  );
});
