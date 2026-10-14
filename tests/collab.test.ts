import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { callBoardTool, boardTools } from "../src/agents/board-tools";
import { MSG_CONTROL, MSG_SYNC, type Control } from "../src/docs/collab";
import { createApp } from "../src/server/app";
import { identify } from "../src/server/auth-middleware";
import { createContainer, type Container } from "../src/server/container";
import { FakeRuntime, until } from "./helpers/fake-runtime";
import { offlineLlm } from "./helpers/setup";
import { removeTempDir } from "./helpers/temp-dir";

/** A bare room client: a Y.Doc kept in sync, plus the control messages received. */
async function joinRoom(url: string, headers: Record<string, string> = {}) {
  const doc = new Y.Doc();
  const controls: Control[] = [];
  const ws = new WebSocket(url, { headers });
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "remote") return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    syncProtocol.writeUpdate(e, update);
    ws.send(encoding.toUint8Array(e));
  });
  ws.on("message", (raw: Buffer) => {
    const d = decoding.createDecoder(new Uint8Array(raw));
    const type = decoding.readVarUint(d);
    if (type === MSG_SYNC) {
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MSG_SYNC);
      syncProtocol.readSyncMessage(d, reply, doc, "remote");
      if (encoding.length(reply) > 1) ws.send(encoding.toUint8Array(reply));
    } else if (type === MSG_CONTROL) controls.push(JSON.parse(decoding.readVarString(d)) as Control);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      // Like the browser provider: ask the room for what we are missing.
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeSyncStep1(e, doc);
      ws.send(encoding.toUint8Array(e));
      resolve();
    });
    ws.once("unexpected-response", (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", reject);
  });
  return { doc, controls, ws, text: () => doc.getXmlFragment("default").toString() };
}

describe("live doc co-editing", () => {
  let dir: string;
  let c: Container;
  let server: Server;
  let base: string;

  const boot = async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-collab-"));
    c = createContainer({ dataDir: dir, dbFile: ":memory:", runtime: new FakeRuntime(), llm: offlineLlm });
    server = createApp(c, { apiToken: null, staticDir: null }).listen(0, "127.0.0.1");
    c.collab.attach(server, (req) => identify(req, c.auth, { apiToken: null, trustLocal: true }));
    await new Promise((r) => server.once("listening", r));
    base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  afterEach(() => {
    c.stop();
    server.close();
    c.db.close();
    removeTempDir(dir);
  });

  it("seeds once, relays edits, pushes outside edits to the saver, and hands saving on", async () => {
    await boot();
    const doc = c.docs.create({ title: "Plan", body: "# Plan\n\nFirst draft" }, "user");
    const url = `ws://${base}/api/docs/${doc.id}/collab`;

    const a = await joinRoom(url);
    await until(() => a.controls.length >= 2);
    expect(a.controls).toEqual([{ type: "role", saver: true }, { type: "seed", markdown: "# Plan\n\nFirst draft", version: 1 }]);

    // A's editor loads the seed into the shared doc; B joins and gets the content, but no seed.
    const para = new Y.XmlElement("paragraph");
    para.insert(0, [new Y.XmlText("First draft")]);
    a.doc.getXmlFragment("default").insert(0, [para]);
    const b = await joinRoom(url);
    await until(() => b.text() === a.text() && b.controls.length >= 1);
    expect(b.controls).toEqual([{ type: "role", saver: false }]);

    // B types; A sees it.
    (b.doc.getXmlFragment("default").get(0) as Y.XmlElement).insert(1, [new Y.XmlText(" with edits")]);
    await until(() => a.text().includes("with edits"));

    // A live session never empties a doc (that is what an editor that has not loaded yet reports).
    const empty = await fetch(`http://${base}/api/docs/${doc.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "", baseVersion: 1, collab: true }) });
    expect(empty.status).toBe(409);
    expect(c.q.doc(doc.id)!.body).toBe("# Plan\n\nFirst draft");

    // The saver's PATCH is marked as the room's own and triggers nothing.
    const res = await fetch(`http://${base}/api/docs/${doc.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: "# Plan\n\nFirst draft with edits", baseVersion: 1, collab: true }) });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(a.controls.filter((x) => x.type === "reset")).toEqual([]);

    // An agent edits the doc: only the saver is told to load it.
    const tools = boardTools({ q: c.q, issues: c.issues, docs: c.docs });
    await callBoardTool(tools, "docs_edit", { doc: doc.id, old_text: "First draft", new_text: "Second draft" }, { actor: "agent:x", runId: null, issueId: null });
    await until(() => a.controls.some((x) => x.type === "reset"));
    expect(a.controls.at(-1)).toEqual({ type: "reset", markdown: "# Plan\n\nSecond draft with edits", version: 3 });
    expect(b.controls.some((x) => x.type === "reset")).toBe(false);

    // The saver leaves; B takes over saving.
    a.ws.close();
    await until(() => b.controls.at(-1)?.type === "role" && (b.controls.at(-1) as { saver: boolean }).saver);
    b.ws.close();
    await until(() => c.collab.roomSize(doc.id) === 0);
  });

  it("refuses rooms for missing docs and for people who are not signed in", async () => {
    await boot();
    const doc = c.docs.create({ title: "x", body: "" }, "user");
    await expect(joinRoom(`ws://${base}/api/docs/00000000-0000-0000-0000-000000000000/collab`)).rejects.toThrow("HTTP 404");
    await expect(joinRoom(`ws://${base}/api/docs/${doc.id}/collab`, { Origin: "https://evil.example" })).rejects.toThrow("HTTP 403");
    // A server that does not trust local requests needs a session.
    const strict = createApp(c, { apiToken: null, staticDir: null, trustLocal: false }).listen(0, "127.0.0.1");
    c.collab.attach(strict, (req) => identify(req, c.auth, { apiToken: null, trustLocal: false }));
    await new Promise((r) => strict.once("listening", r));
    try {
      await expect(joinRoom(`ws://127.0.0.1:${(strict.address() as AddressInfo).port}/api/docs/${doc.id}/collab`)).rejects.toThrow("HTTP 401");
    } finally {
      strict.close();
    }
  });
});
