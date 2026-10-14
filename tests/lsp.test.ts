import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { attachLspSockets, frame, LspFramer } from "../src/lsp/socket";
import { createApp } from "../src/server/app";
import { fileUri } from "../src/web/src/components/chat/lsp";
import { makeContainer } from "./helpers/setup";

describe("code intelligence", () => {
  it("frames and unframes LSP messages, across chunk boundaries", () => {
    const got: string[] = [];
    const f = new LspFramer((m) => got.push(m));
    const raw = Buffer.from(frame('{"id":1}') + frame('{"id":2,"text":"héllo"}'));
    f.push(raw.subarray(0, 7));
    f.push(raw.subarray(7, 30));
    f.push(raw.subarray(30));
    expect(got).toEqual(['{"id":1}', '{"id":2,"text":"héllo"}']);
  });

  it("builds file URIs for Windows and POSIX roots", () => {
    expect(fileUri("C:\\work\\my app", "src/a.ts")).toBe("file:///C:/work/my%20app/src/a.ts");
    expect(fileUri("/home/ada/repo/", "src/a.ts")).toBe("file:///home/ada/repo/src/a.ts");
  });

  it("serves TypeScript's language server per workspace: diagnostics and hover", async () => {
    const { c } = makeContainer();
    const ws = await c.workspaces.createInProject(null, "Code", "user");
    writeFileSync(join(ws.path, "a.ts"), "");
    const server = createApp(c, { apiToken: null, staticDir: null }).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    attachLspSockets(server, c.workspaces, () => true);
    const port = (server.address() as AddressInfo).port;
    const sock = new WebSocket(`ws://127.0.0.1:${port}/api/workspaces/${ws.id}/lsp`, { headers: { Origin: `http://127.0.0.1:${port}` } });
    const inbox: Record<string, any>[] = [];
    sock.on("message", (d) => {
      const m = JSON.parse(String(d));
      // Requests from the server (registerCapability, configuration) need an answer.
      if (m.id !== undefined && m.method) sock.send(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method === "workspace/configuration" ? (m.params.items ?? []).map(() => null) : null }));
      inbox.push(m);
    });
    await new Promise((r, j) => (sock.once("open", r), sock.once("error", j)));
    const until = async (pred: (m: Record<string, any>) => boolean) => {
      for (let i = 0; i < 300; i++) {
        const hit = inbox.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`timed out; got ${JSON.stringify(inbox.map((m) => m.method ?? m.id))}`);
    };
    const send = (m: object) => sock.send(JSON.stringify({ jsonrpc: "2.0", ...m }));
    const root = fileUri(ws.path, "");
    const uri = fileUri(ws.path, "a.ts");
    try {
      send({ id: 1, method: "initialize", params: { processId: null, rootUri: root, capabilities: { textDocument: { hover: { contentFormat: ["markdown", "plaintext"] }, publishDiagnostics: {} } }, workspaceFolders: [{ uri: root, name: "ws" }] } });
      const init = await until((m) => m.id === 1);
      expect(init.result.capabilities.hoverProvider).toBeTruthy();
      send({ method: "initialized", params: {} });
      send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "typescript", version: 1, text: "const total: number = 'three';\nexport const twice = (n: number) => n * 2;\n" } } });
      // TypeScript answers diagnostics when asked (pull); the editor asks after each edit.
      send({ id: 2, method: "textDocument/diagnostic", params: { textDocument: { uri } } });
      const diag = await until((m) => m.id === 2);
      const items = diag.result.items;
      expect(items[0].message).toMatch(/not assignable to type 'number'/);
      send({ id: 3, method: "textDocument/hover", params: { textDocument: { uri }, position: { line: 1, character: 14 } } });
      const hover = await until((m) => m.id === 3);
      expect(JSON.stringify(hover.result.contents)).toContain("(n: number) => number");
    } finally {
      sock.close();
      server.close();
      c.stop();
      c.db.close();
    }
  }, 60_000);
});
