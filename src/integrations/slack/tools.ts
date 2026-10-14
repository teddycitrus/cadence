import { z } from "zod";
import { define, type BoardTool } from "../../agents/board-tools";
import type { SlackService } from "./service";

const channel = z.string().regex(/^[CGD][A-Z0-9]+$/).describe("Channel id like C0123ABCD");
const ts = z.string().regex(/^\d+\.\d+$/).describe("Message timestamp like 1712345678.000100");

function render(messages: { ts: string; user?: string; bot_id?: string; text: string }[]): string {
  return messages.map((m) => `[${m.ts}] ${m.bot_id ? "bot" : (m.user ?? "?")}: ${m.text}`).join("\n") || "(no messages)";
}

/** Slack tools for agents. They work only once Slack is connected. */
export function slackTools(slack: SlackService): BoardTool[] {
  return [
    define({
      name: "slack_read_thread",
      description: "Read a Slack thread: the root message and every reply, oldest first.",
      shape: { channel, thread_ts: ts },
      run: async (a) => render(await slack.api().replies(a.channel, a.thread_ts)),
    }),
    define({
      name: "slack_read_channel",
      description: "Read a channel's recent top-level messages, newest first.",
      shape: { channel, limit: z.number().int().min(1).max(100).optional() },
      run: async (a) => render(await slack.api().history(a.channel, a.limit ?? 30)),
    }),
    define({
      name: "slack_reply",
      description: "Reply in a Slack thread. Keep it short; link the issue or doc for anything longer. Only post when you were mentioned or a person asked you to.",
      shape: { channel, thread_ts: ts, text: z.string().min(1).max(4000) },
      run: async (a) => {
        const r = await slack.api().postMessage(a.channel, a.text, a.thread_ts);
        return `Replied (ts ${r.ts}).`;
      },
    }),
    define({
      name: "slack_post_message",
      description: "Post a new top-level message in a channel the Cadence bot is in. Only when a person asked for it or your instructions say to.",
      shape: { channel, text: z.string().min(1).max(4000) },
      run: async (a) => {
        const r = await slack.api().postMessage(a.channel, a.text);
        return `Posted (ts ${r.ts}). Reply in its thread with thread_ts ${r.ts}.`;
      },
    }),
    define({
      name: "slack_react",
      description: "Add an emoji reaction to a message, e.g. eyes when you start and white_check_mark when done.",
      shape: { channel, ts, emoji: z.string().regex(/^:?[a-z0-9_+-]+:?$/) },
      run: async (a) => {
        await slack.api().react(a.channel, a.ts, a.emoji);
        return "Reacted.";
      },
    }),
    define({
      name: "slack_list_channels",
      description: "List Slack channels with their ids, marking the ones the Cadence bot is a member of (it can only read and post in those).",
      shape: {},
      run: async () =>
        (await slack.api().channels())
          .map((c) => `- #${c.name} (${c.id})${c.is_member ? " [member]" : ""}${c.is_private ? " [private]" : ""}`)
          .join("\n") || "No channels.",
    }),
  ];
}
