import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { createContainer, type Container } from "../src/server/container";
import { FakeRuntime } from "./helpers/fake-runtime";
import { offlineLlm } from "./helpers/setup";
import { removeTempDir } from "./helpers/temp-dir";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

describe("share links", () => {
  let dir: string;
  let c: Container;
  let servers: Server[] = [];

  const boot = async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-share-"));
    c = createContainer({ dataDir: dir, dbFile: ":memory:", runtime: new FakeRuntime(), llm: offlineLlm });
    const listen = async (trustLocal: boolean) => {
      const s = createApp(c, { apiToken: null, staticDir: null, trustLocal }).listen(0, "127.0.0.1");
      servers.push(s);
      await new Promise((r) => s.once("listening", r));
      return `http://127.0.0.1:${(s.address() as AddressInfo).port}/api`;
    };
    return { owner: await listen(true), visitor: await listen(false) };
  };

  afterEach(() => {
    for (const s of servers) s.close();
    servers = [];
    c.stop();
    c.db.close();
    removeTempDir(dir);
  });

  const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("shows a shared doc, and only its own images, to someone who is not signed in", async () => {
    const { owner, visitor } = await boot();
    const shown = c.assets.save("shot.png", "image/png", PNG, "user");
    const hidden = c.assets.save("secret.png", "image/png", PNG, "user");
    const doc = c.docs.create({ title: "Launch notes", body: `# Launch\n\n![shot](/api/assets/${shown.id})` }, "user");
    const link = (await (await post(`${owner}/shares`, { kind: "doc", ref: doc.id })).json()) as { id: string };
    // Sharing twice gives the same link.
    expect(((await (await post(`${owner}/shares`, { kind: "doc", ref: doc.id })).json()) as { id: string }).id).toBe(link.id);

    expect((await fetch(`${visitor}/docs/${doc.id}`)).status).toBe(401);
    const view = (await (await fetch(`${visitor}/share/${link.id}`)).json()) as { kind: string; title: string; body: string };
    expect(view).toMatchObject({ kind: "doc", title: "Launch notes" });
    expect(view.body).toContain(`![shot](/api/share/${link.id}/assets/${shown.id})`);
    const img = await fetch(`${visitor}/share/${link.id}/assets/${shown.id}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect((await fetch(`${visitor}/share/${link.id}/assets/${hidden.id}`)).status).toBe(404);
    expect((await fetch(`${visitor}/assets/${hidden.id}`)).status).toBe(401);

    expect((await fetch(`${owner}/shares/${link.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${visitor}/share/${link.id}`)).status).toBe(404);
    expect((await fetch(`${visitor}/share/${link.id}/assets/${shown.id}`)).status).toBe(404);
    expect((await fetch(`${visitor}/share/not-a-real-link`)).status).toBe(404);
  });

  it("shows a shared issue with its comments, without internal doc links", async () => {
    const { owner, visitor } = await boot();
    const issue = c.issues.createIssue({ title: "Checkout breaks on Safari", body: "Steps...", type: "bug", priority: "high" }, "user");
    c.issues.comment(issue.id, "Reproduced on 17.2", "user");
    const doc = c.docs.create({ title: "Spec", body: "", issueId: issue.id }, "user");
    c.issues.addLink(issue.id, { kind: "url", ref: "https://status.example.com", title: "Status page" }, "user");
    const link = (await (await post(`${owner}/shares`, { kind: "issue", ref: issue.id })).json()) as { id: string };
    const view = (await (await fetch(`${visitor}/share/${link.id}`)).json()) as Record<string, any>;
    expect(view).toMatchObject({ kind: "issue", key: issue.key, title: "Checkout breaks on Safari", stage: "Ideas", priority: "high" });
    expect(view.comments).toEqual([expect.objectContaining({ author: "Owner", body: "Reproduced on 17.2" })]);
    expect(view.links).toEqual([{ kind: "url", title: "Status page", ref: "https://status.example.com" }]);
    expect(JSON.stringify(view)).not.toContain(doc.id);
  });
});
