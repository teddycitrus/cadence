import { describe, expect, it } from "vitest";
import { GitHubApi } from "../src/git/github";
import { visualReport, VRT_MARKER } from "../src/canvas/vrt-report";

const result = (storyId: string, storyName: string, status: "pass" | "fail" | "new" | "size_changed", diffRatio = 0) => ({ storyId, storyName, status, diffPixels: 0, diffRatio, baseline: "", currentFile: null, diffFile: null });

describe("visual check on pull requests", () => {
  it("summarizes changed frames first", () => {
    const md = visualReport([{ path: "src/checkout.canvas.tsx", name: "Checkout", results: [result("Empty", "Empty cart", "pass"), result("Full", "Full cart", "fail", 0.0123), result("Promo", "Promo", "new")] }], "cadence/promo-1a2b");
    expect(md).toContain("1 of 3 frames changed against their baselines on `cadence/promo-1a2b`");
    const rows = md.split("\n").filter((l) => l.startsWith("| Checkout"));
    expect(rows).toEqual(["| Checkout (`src/checkout.canvas.tsx`) | Full cart | changed | 1.23% |", "| Checkout (`src/checkout.canvas.tsx`) | Promo | new (no baseline yet) | - |", "| Checkout (`src/checkout.canvas.tsx`) | Empty cart | unchanged | - |"]);
    expect(visualReport([{ path: "a.canvas.tsx", name: "A", results: [result("X", "X", "pass")] }], null)).toContain("All 1 frame match their baselines.");
  });

  it("posts one comment and updates it on later runs", async () => {
    const comments: { id: number; body: string; html_url: string }[] = [];
    const calls: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.replace("https://api.github.com", "")}`);
      if (method === "GET") return new Response(JSON.stringify(comments));
      const body = JSON.parse(String(init!.body)) as { body: string };
      if (method === "POST") {
        comments.push({ id: 7, body: body.body, html_url: "https://github.com/acme/web/pull/3#issuecomment-7" });
        return new Response(JSON.stringify(comments[0]), { status: 201 });
      }
      comments[0]!.body = body.body;
      return new Response(JSON.stringify(comments[0]));
    }) as typeof fetch;
    const api = new GitHubApi("token", fake);
    expect(await api.upsertComment("acme/web", 3, VRT_MARKER, "first")).toEqual({ url: "https://github.com/acme/web/pull/3#issuecomment-7", updated: false });
    expect(await api.upsertComment("acme/web", 3, VRT_MARKER, "second")).toMatchObject({ updated: true });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toBe(`second\n\n<!-- ${VRT_MARKER} -->`);
    expect(calls).toEqual(["GET /repos/acme/web/issues/3/comments?per_page=100", "POST /repos/acme/web/issues/3/comments", "GET /repos/acme/web/issues/3/comments?per_page=100", "PATCH /repos/acme/web/issues/comments/7"]);
  });
});
