import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { bootTeam } from "./helpers/team";

/** Reads an event stream for `ms` and returns the raw text. */
async function readStream(url: string, headers: Record<string, string>, ms: number, during?: () => void): Promise<string> {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const stop = setTimeout(() => ac.abort(), ms);
  setTimeout(() => during?.(), 100);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  } catch {
    // aborted: the time is up
  }
  clearTimeout(stop);
  return text;
}

const domainSeqs = (text: string) => [...text.matchAll(/id: (\d+)\nevent: domain/g)].map((m) => Number(m[1]));

describe("event stream", () => {
  it("replays events a reconnecting client missed, and asks for a reload when it missed too many", async () => {
    const team = await bootTeam();
    try {
      const mark = team.c.store.count();
      const lastSeq = () => team.c.store.after(0, 1_000_000).at(-1)!.seq;
      const from = lastSeq();
      for (let i = 0; i < 3; i++) team.c.issues.createIssue({ title: `missed ${i}` });
      expect(team.c.store.count()).toBeGreaterThan(mark);
      const replayed = await readStream(`${team.localBase}/events`, { "Last-Event-ID": String(from) }, 400);
      expect(domainSeqs(replayed)).toEqual(team.c.store.after(from, 100).map((e) => e.seq));
      expect(replayed).toContain("missed 2");

      const before = lastSeq();
      for (let i = 0; i < 520; i++) team.c.issues.createIssue({ title: `bulk ${i}` });
      const tooMany = await readStream(`${team.localBase}/events`, { "Last-Event-ID": String(before) }, 400);
      expect(tooMany).toContain("event: resync");
      expect(domainSeqs(tooMany)).toEqual([]);
    } finally {
      team.close();
    }
  });

  it("lets go of a client that stops reading instead of buffering for it forever", async () => {
    const team = await bootTeam();
    try {
      const { port } = new URL(team.localBase);
      const sock = connect(Number(port), "127.0.0.1");
      await new Promise((r) => sock.once("connect", r));
      sock.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n`);
      sock.pause(); // never reads
      const closed = new Promise<void>((r) => sock.once("close", () => r()));
      await new Promise((r) => setTimeout(r, 200));
      const target = team.c.issues.createIssue({ title: "Busy thread" });
      for (let i = 0; i < 120; i++) team.c.issues.comment(target.id, `big ${i} ${"x".repeat(100_000)}`);
      // Writes are only checked as events arrive, so a few more after the backlog builds trigger the cut.
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 100));
        team.c.issues.createIssue({ title: `nudge ${i}` });
      }
      sock.resume();
      await Promise.race([closed, new Promise((_, no) => setTimeout(() => no(new Error("still connected")), 5000))]);
    } finally {
      team.close();
    }
  });

  it("streams new events to several clients, each the same bytes", async () => {
    const team = await bootTeam();
    try {
      const create = () => team.c.issues.createIssue({ title: "Live for everyone" });
      const [a, b] = await Promise.all([readStream(`${team.localBase}/events`, {}, 500, create), readStream(`${team.localBase}/events`, {}, 500)]);
      const pick = (t: string) => t.split("\n\n").filter((x) => x.includes("Live for everyone"));
      expect(pick(a).length).toBeGreaterThan(0);
      expect(pick(a)).toEqual(pick(b));
    } finally {
      team.close();
    }
  });
});
