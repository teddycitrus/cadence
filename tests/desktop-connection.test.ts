import { describe, expect, it } from "vitest";
import { isCadence, isLocalNetwork, onOrigin, parseServerAddress } from "../src/desktop/connection";

describe("joining a team's Cadence server from the desktop app", () => {
  it("takes an address or an invite link, and refuses plain http over the internet", () => {
    expect(parseServerAddress("cadence.example.com")).toEqual({ origin: "https://cadence.example.com", hash: "" });
    expect(parseServerAddress(" https://cadence.example.com/#/invite/abc123?org=team ")).toEqual({ origin: "https://cadence.example.com", hash: "#/invite/abc123?org=team" });
    expect(parseServerAddress("http://192.168.1.40:4317")).toEqual({ origin: "http://192.168.1.40:4317", hash: "" });
    expect(parseServerAddress("http://studio.local:4317").origin).toBe("http://studio.local:4317");
    expect(() => parseServerAddress("http://cadence.example.com")).toThrow(/https/);
    expect(() => parseServerAddress("ftp://cadence.example.com")).toThrow(/https/);
    expect(() => parseServerAddress("https://me:pw@cadence.example.com")).toThrow(/password/);
    expect(() => parseServerAddress("   ")).toThrow(/address/);
    expect(isLocalNetwork("10.0.0.8") && isLocalNetwork("172.20.1.1") && isLocalNetwork("[::1]")).toBe(true);
    expect(isLocalNetwork("172.40.1.1") || isLocalNetwork("8.8.8.8")).toBe(false);
  });

  it("compares whole origins, so look-alike hosts and ports do not pass", () => {
    expect(onOrigin("https://cadence.example.com/#/chats", "https://cadence.example.com")).toBe(true);
    expect(onOrigin("https://cadence.example.com.evil.test/", "https://cadence.example.com")).toBe(false);
    expect(onOrigin("http://127.0.0.1:43170/", "http://127.0.0.1:4317")).toBe(false);
    expect(onOrigin("not a url", "http://127.0.0.1:4317")).toBe(false);
    expect(onOrigin("http://127.0.0.1:4317/", "")).toBe(false);
  });

  it("recognizes a Cadence by its sign-in check", async () => {
    const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await isCadence("https://c.example", answer(200, { signedIn: false, member: null, role: null, team: true }))).toBe(true);
    expect(await isCadence("https://c.example", answer(200, { hello: "world" }))).toBe(false);
    expect(await isCadence("https://c.example", answer(502, {}))).toBe(false);
    expect(await isCadence("https://c.example", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBe(false);
  });
});
