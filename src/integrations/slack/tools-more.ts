import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { define, type BoardTool, type ToolContext, type ToolOutput } from "../../agents/board-tools";
import type { EventStore } from "../../core/event-store";
import type { Queries } from "../../core/queries";
import { documentText, googleDocText, pdfPageImage } from "../documents";
import { threadKeyOf, type SlackService } from "./service";

const channel = z.string().regex(/^[CGD][A-Z0-9]+$/).describe("Channel id like C0123ABCD");
const ts = z.string().regex(/^\d+\.\d+$/).describe("Message timestamp like 1712345678.000100");
const emoji = z.string().regex(/^:?[a-z0-9_+-]+:?$/);
const MAX_UPLOAD = 20 * 1024 * 1024;

/** The chat a tool call comes from: the assistant's own chat, or the agent run's chat. */
function chatOf(q: Queries, ctx: ToolContext): string | null {
  if (ctx.actor.startsWith("chat:")) return ctx.actor.slice(5);
  return ctx.runId ? (q.run(ctx.runId)?.chatId ?? null) : null;
}

/** More Slack tools: DMs, edits, deletes, joins, uploads, people, permalinks, attachments, and thread following. */
export function moreSlackTools(slack: SlackService, q: Queries, store: EventStore): BoardTool[] {
  const setThreads = (ctx: ToolContext, change: (t: { follow: string[]; muted: string[] }) => { follow: string[]; muted: string[] }, actor = ctx.actor) => {
    const chatId = chatOf(q, ctx);
    const chat = chatId ? q.chat(chatId) : null;
    if (!chat) throw new Error("Thread following works from an agent's or assistant's chat");
    const slackThreads = change(chat.slackThreads ?? { follow: [], muted: [] });
    store.append({ aggregate: "chat", type: "ChatUpdated", aggregateId: chat.id, payload: { slackThreads } }, actor);
    return chat;
  };
  return [
    define({
      name: "slack_send_dm",
      description: "Send a direct message to one or more people (Slack user ids like U0123, or emails) as the Cadence bot. Several people open a group DM. Only when a person asked for it or your instructions say to.",
      shape: { to: z.array(z.string().min(1)).min(1).max(8), text: z.string().min(1).max(4000) },
      run: async (a) => {
        const api = slack.api();
        const ids: string[] = [];
        for (const who of a.to) {
          if (/^[UW][A-Z0-9]+$/.test(who)) ids.push(who);
          else {
            const user = await api.userByEmail(who);
            if (!user) throw new Error(`No Slack user with email ${who}`);
            ids.push(user.id);
          }
        }
        const dm = await api.openDm(ids);
        const r = await api.postMessage(dm, a.text);
        return `Sent (channel ${dm}, ts ${r.ts}).`;
      },
    }),
    define({
      name: "slack_unreact",
      description: "Remove a reaction the Cadence bot added to a message.",
      shape: { channel, ts, emoji },
      run: async (a) => {
        await slack.api().unreact(a.channel, a.ts, a.emoji);
        return "Removed the reaction.";
      },
    }),
    define({
      name: "slack_update_message",
      description: "Edit a message the Cadence bot posted (by channel and ts). The bot can only edit its own messages.",
      shape: { channel, ts, text: z.string().min(1).max(4000) },
      run: async (a) => {
        await slack.api().update(a.channel, a.ts, a.text);
        return "Edited.";
      },
    }),
    define({
      name: "slack_delete_message",
      description: "Delete a message the Cadence bot posted. It cannot delete anyone else's.",
      shape: { channel, ts },
      run: async (a) => {
        await slack.api().remove(a.channel, a.ts);
        return "Deleted.";
      },
    }),
    define({
      name: "slack_join_channel",
      description: "Join a PUBLIC channel as the Cadence bot so it can read and post there. Private channels need a member to /invite the bot.",
      shape: { channel },
      run: async (a) => {
        await slack.api().join(a.channel);
        return `Joined ${a.channel}.`;
      },
    }),
    define({
      name: "slack_list_users",
      description: "People in the connected Slack workspace. Pass email for an exact lookup, or query to match names. The ids work for slack_send_dm and <@U...> mentions.",
      shape: { email: z.string().email().optional(), query: z.string().optional() },
      run: async (a) => {
        const api = slack.api();
        if (a.email) {
          const u = await api.userByEmail(a.email);
          return u ? `${u.id} ${u.realName || u.name}${u.displayName ? ` (@${u.displayName})` : ""}` : "No one with that email.";
        }
        const needle = a.query?.toLowerCase();
        const users = (await api.users()).filter((u) => !needle || [u.name, u.realName, u.displayName, u.email ?? ""].some((x) => x.toLowerCase().includes(needle)));
        return users.slice(0, 100).map((u) => `- ${u.id} ${u.realName || u.name}${u.displayName ? ` (@${u.displayName})` : ""}${u.email ? ` ${u.email}` : ""}`).join("\n") || "No matching people.";
      },
    }),
    define({
      name: "slack_permalink",
      description: "The shareable https link to a Slack message.",
      shape: { channel, ts },
      run: async (a) => (await slack.api().permalink(a.channel, a.ts)) ?? "Slack did not return a link for that message.",
    }),
    define({
      name: "slack_read_file",
      description: "Read an attachment from Slack (Word .docx, PDF, Markdown, or text) with the bot's access, by file id (F0123...). Use it for PRDs and specs attached to a request; the file name alone says nothing. PDFs come back page by page and list pages without text (scans).",
      shape: { file: z.string().regex(/^F[A-Z0-9]+$/) },
      run: async (a) => {
        const api = slack.api();
        const info = await api.fileInfo(a.file);
        const url = info.url_private_download ?? info.url_private;
        if (!url) throw new Error("Slack gave no download link for that file");
        const doc = await documentText(info.name, info.mimetype, await api.download(url));
        const notes = [doc.pages ? `${doc.pages} pages` : "", doc.pagesWithoutText?.length ? `no text on pages ${doc.pagesWithoutText.join(", ")}` : "", doc.truncated ? "cut off at 200,000 characters" : ""].filter(Boolean);
        return `# ${info.name}${notes.length ? ` (${notes.join("; ")})` : ""}\n\n${doc.text}`;
      },
    }),
    define({
      name: "slack_read_pdf_page",
      description: "One page of a PDF attached in Slack, as an image, by file id and page number. Use it for scanned PDFs, diagrams, and pages slack_read_file listed as having no text. You need to look at the image to read it.",
      shape: { file: z.string().regex(/^F[A-Z0-9]+$/), page: z.number().int().min(1) },
      run: async (a): Promise<ToolOutput> => {
        const api = slack.api();
        const info = await api.fileInfo(a.file);
        if (info.mimetype !== "application/pdf" && !info.name.toLowerCase().endsWith(".pdf")) throw new Error(`${info.name} is not a PDF`);
        const url = info.url_private_download ?? info.url_private;
        if (!url) throw new Error("Slack gave no download link for that file");
        const { png, pages } = await pdfPageImage(await api.download(url), a.page);
        return { text: `${info.name}, page ${a.page} of ${pages}.`, images: [{ data: png.toString("base64"), mimeType: "image/png" }] };
      },
    }),
    define({
      name: "slack_read_google_doc",
      description: "Read a Google Doc linked in Slack through its plain-text export. Works for docs shared with anyone who has the link; try it before saying a doc needs a sign-in.",
      shape: { url: z.string().url() },
      run: async (a) => {
        const doc = await googleDocText(a.url);
        return `${doc.truncated ? "(cut off at 200,000 characters)\n\n" : ""}${doc.text}`;
      },
    }),
    define({
      name: "slack_upload_file",
      description: "Upload a local file (absolute path; a chart, log, or screenshot) to a Slack conversation as the Cadence bot, optionally as a thread reply with a comment. Up to 20 MB.",
      shape: { channel, path: z.string(), thread_ts: ts.optional(), comment: z.string().max(4000).optional() },
      run: async (a, ctx) => {
        if (ctx.actor.startsWith("token:")) throw new Error("Outside agents cannot upload files from this machine");
        if (!isAbsolute(a.path)) throw new Error("Use an absolute path");
        if (statSync(a.path).size > MAX_UPLOAD) throw new Error("Files are limited to 20 MB");
        const id = await slack.api().upload(a.channel, a.path.replace(/^.*[\\/]/, ""), readFileSync(a.path), { threadTs: a.thread_ts, comment: a.comment });
        return `Uploaded (file ${id}).`;
      },
    }),
    define({
      name: "slack_subscribe_thread",
      description: "Follow a Slack thread from this chat: later replies in it are delivered here. Use it for a thread you found but were not started from.",
      shape: { channel, thread_ts: ts },
      run: (a, ctx) => {
        const key = threadKeyOf(a.channel, a.thread_ts);
        setThreads(ctx, (t) => ({ follow: [...new Set([...t.follow, key])], muted: t.muted.filter((k) => k !== key) }));
        return "Following the thread.";
      },
    }),
    define({
      name: "slack_unsubscribe_thread",
      description: "Stop being woken by new replies in a Slack thread (the one this chat came from when no thread is given). Use when the conversation is done.",
      shape: { channel: channel.optional(), thread_ts: ts.optional() },
      run: (a, ctx) => {
        const chatId = chatOf(q, ctx);
        const own = chatId ? q.chat(chatId)?.threadKey : null;
        const key = a.channel && a.thread_ts ? threadKeyOf(a.channel, a.thread_ts) : own;
        if (!key) throw new Error("Name the thread: channel and thread_ts");
        setThreads(ctx, (t) => ({ follow: t.follow.filter((k) => k !== key), muted: [...new Set([...t.muted, key])] }));
        return "Stopped following the thread.";
      },
    }),
  ];
}
