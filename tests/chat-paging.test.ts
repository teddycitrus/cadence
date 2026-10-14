import { afterEach, describe, expect, it } from "vitest";
import { bootTeam } from "./helpers/team";

describe("chat transcript paging", () => {
  let close = () => {};
  afterEach(() => {
    close();
    close = () => {};
  });

  it("serves the latest page, older pages before a seq, and only new items after one", async () => {
    const team = await bootTeam();
    close = team.close;
    const ws = await team.c.workspaces.createInProject(null, "Long", "user");
    const chat = team.c.engine.createChat({ workspaceId: ws.id });
    for (let n = 1; n <= 25; n++) team.c.store.append({ aggregate: "chat", type: "ChatItemAdded", aggregateId: chat.id, payload: { item: { kind: "assistant", text: `reply ${n}` } } }, "system");

    const latest = (await team.local("GET", `/chats/${chat.id}?limit=10`)).json as { items: { seq: number; text: string }[]; earlier: boolean };
    expect(latest.items.map((i) => i.text)).toEqual(Array.from({ length: 10 }, (_, k) => `reply ${16 + k}`));
    expect(latest.earlier).toBe(true);

    const older = (await team.local("GET", `/chats/${chat.id}?limit=10&before=${latest.items[0]!.seq}`)).json as typeof latest;
    expect(older.items.map((i) => i.text)).toEqual(Array.from({ length: 10 }, (_, k) => `reply ${6 + k}`));
    const oldest = (await team.local("GET", `/chats/${chat.id}?limit=10&before=${older.items[0]!.seq}`)).json as typeof latest;
    expect(oldest.items).toHaveLength(5);
    expect(oldest.earlier).toBe(false);

    team.c.store.append({ aggregate: "chat", type: "ChatItemAdded", aggregateId: chat.id, payload: { item: { kind: "assistant", text: "reply 26" } } }, "system");
    const fresh = (await team.local("GET", `/chats/${chat.id}?after=${latest.items.at(-1)!.seq}`)).json as typeof latest;
    expect(fresh.items.map((i) => i.text)).toEqual(["reply 26"]);
    // Without paging parameters the whole transcript still comes back.
    expect(((await team.local("GET", `/chats/${chat.id}`)).json as typeof latest).items).toHaveLength(26);
  });
});
