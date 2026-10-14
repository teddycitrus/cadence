import { describe, expect, it } from "vitest";
import { backgroundTasks } from "../src/web/src/components/chat/BackgroundTasks";
import type { ChatItem } from "../src/core/types";

const at = (seq: number, data: object) => ({ seq, chatId: "c", ts: `2026-10-12T10:0${seq}:00.000Z`, ...data }) as ChatItem;

describe("background tasks in a chat", () => {
  it("lists background shells and sub-agents, newest first, with sub-agents done once they return", () => {
    const items = [
      at(1, { kind: "tool_use", toolUseId: "a", name: "Bash", input: { command: "npm run dev", run_in_background: true, description: "Dev server" } }),
      at(2, { kind: "tool_use", toolUseId: "b", name: "Bash", input: { command: "ls" } }),
      at(3, { kind: "tool_use", toolUseId: "c", name: "Task", input: { description: "Review the diff", prompt: "..." } }),
      at(4, { kind: "tool_result", toolUseId: "c", content: "ok", isError: false }),
      at(5, { kind: "tool_use", toolUseId: "d", name: "Task", input: { description: "Find callers" } }),
    ];
    expect(backgroundTasks(items).map((t) => [t.label, t.kind, t.done])).toEqual([
      ["Find callers", "subagent", false],
      ["Review the diff", "subagent", true],
      ["Dev server", "shell", false],
    ]);
  });
});
