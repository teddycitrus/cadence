import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCadence, type Cadence } from "../src/server/serve";
import { FakeRuntime } from "./helpers/fake-runtime";
import { offlineLlm } from "./helpers/setup";
import { client } from "./helpers/team";
import { removeTempDir } from "./helpers/temp-dir";

// A 1x1 transparent PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("organization logos", () => {
  let dir: string;
  let cadence: Cadence;
  afterEach(async () => {
    await cadence?.close();
    removeTempDir(dir);
  });

  it("sets a logo from an uploaded image and keeps the org list current", async () => {
    dir = mkdtempSync(join(tmpdir(), "cadence-logo-"));
    cadence = await startCadence({ dataDir: dir, port: 0, host: "127.0.0.1", apiToken: null, trustLocal: true, staticDir: null, llm: offlineLlm, runtimeFor: () => new FakeRuntime() });
    const api = client(`${cadence.url}/api`);
    const image = await api("POST", "/assets", { name: "logo.png", mediaType: "image/png", data: PNG });
    const text = await api("POST", "/assets", { name: "notes.txt", mediaType: "text/plain", data: Buffer.from("hi").toString("base64") });
    expect((await api("PATCH", "/orgs/default", { logo: text.json.id })).status).toBe(400);
    expect((await api("PATCH", "/orgs/default", { logo: "missing" })).status).toBe(400);
    const set = await api("PATCH", "/orgs/default", { logo: image.json.id, name: "Studio" });
    expect(set.json.logo).toBe(`/api/assets/${image.json.id}?org=default`);
    const [org] = (await api("GET", "/orgs")).json as unknown as { name: string; logo: string }[];
    expect(org).toMatchObject({ name: "Studio", logo: set.json.logo, running: 0, unread: 0 });
    const served = await fetch(cadence.url + org!.logo);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect((await api("PATCH", "/orgs/default", { logo: null })).json.logo).toBeNull();
  });
});
