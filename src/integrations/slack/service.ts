import type { Queries } from "../../core/queries";
import { ValidationError } from "../../core/errors";
import type { SlackEvent } from "../../core/types";
import type { TriggerEngine } from "../../runner/triggers";
import type { SecretStore } from "../secrets";
import { SlackApi, type SlackIdentity, SlackError } from "./api";
import { SocketModeClient, type SlackEventEnvelope } from "./socket";

export interface SlackStatus {
  configured: boolean;
  connection: "connecting" | "connected" | "disconnected";
  team: string | null;
  teamUrl: string | null;
  botUserId: string | null;
  error: string | null;
  /** The name and picture the bot posts with (Slack's defaults when unset). */
  identity?: SlackIdentity;
}

/** A Slack message, mention, or reaction, normalized for triggers. */
export interface SlackActivity {
  kind: SlackEvent;
  channel: string;
  /** The message this is about (for a reaction, the message reacted to). */
  ts: string;
  /** The thread root: equal to ts for a top-level message. */
  threadTs: string;
  user: string | null;
  text: string;
  emoji: string | null;
  /** Posted by another app or bot (never Cadence's own); only triggers that include bots see it. */
  bot?: boolean;
}

export const threadKeyOf = (channel: string, threadTs: string) => `slack:${channel}:${threadTs}`;

const SEEN_LIMIT = 1000;

/**
 * The org-wide Slack connection: a bot token for the Web API and an app token
 * for Socket Mode. Inbound activity fires Slack triggers; replies in a thread
 * an agent is already working go back to that agent's chat.
 */
export class SlackService {
  private socket: SocketModeClient | null = null;
  private seen = new Set<string>();
  private state: SlackStatus = { configured: false, connection: "disconnected", team: null, teamUrl: null, botUserId: null, error: null };
  private names = new Map<string, string>();

  constructor(
    private secrets: SecretStore,
    private q: Queries,
    private triggers: TriggerEngine,
    private fetchImpl: typeof fetch = fetch,
    private createSocket?: ConstructorParameters<typeof SocketModeClient>[0]["createSocket"],
  ) {}

  status(): SlackStatus {
    return { ...this.state, configured: this.secrets.has("slackBotToken") && this.secrets.has("slackAppToken"), identity: this.identity() };
  }

  /** The Web API client, or an error agents can read when Slack is not connected. */
  api(): SlackApi {
    const token = this.secrets.get("slackBotToken");
    if (!token) throw new SlackError("Slack is not connected. Connect it in Settings > Integrations.", "not_connected");
    return new SlackApi(token, this.fetchImpl, this.identity());
  }

  identity(): SlackIdentity {
    try {
      return { name: null, iconUrl: null, ...(JSON.parse(this.secrets.get("slackIdentity") ?? "{}") as Partial<SlackIdentity>) };
    } catch {
      return { name: null, iconUrl: null };
    }
  }

  /** Sets the bot's display name and picture. Slack fetches the picture itself, so it must be a public https URL. */
  setIdentity(input: SlackIdentity): SlackStatus {
    const name = input.name?.trim() || null;
    const iconUrl = input.iconUrl?.trim() || null;
    if (name && name.length > 80) throw new ValidationError("Keep the name under 80 characters");
    if (iconUrl) {
      let u: URL;
      try {
        u = new URL(iconUrl);
      } catch {
        throw new ValidationError("The picture must be a URL");
      }
      if (u.protocol !== "https:") throw new ValidationError("Slack only loads pictures from public https URLs");
    }
    this.secrets.set("slackIdentity", name || iconUrl ? JSON.stringify({ name, iconUrl }) : null);
    return this.status();
  }

  async connect(botToken: string, appToken: string): Promise<SlackStatus> {
    if (!botToken.startsWith("xoxb-")) throw new ValidationError("The bot token starts with xoxb-");
    if (!appToken.startsWith("xapp-")) throw new ValidationError("The app-level token starts with xapp- and needs the connections:write scope");
    const auth = await new SlackApi(botToken, this.fetchImpl).authTest();
    await SlackApi.openSocket(appToken, this.fetchImpl); // proves the app token works before saving
    this.secrets.set("slackBotToken", botToken);
    this.secrets.set("slackAppToken", appToken);
    this.state = { ...this.state, team: auth.team, teamUrl: auth.url, botUserId: auth.user_id, error: null };
    this.restart();
    return this.status();
  }

  disconnect(): SlackStatus {
    this.socket?.stop();
    this.socket = null;
    this.secrets.set("slackBotToken", null);
    this.secrets.set("slackAppToken", null);
    this.state = { configured: false, connection: "disconnected", team: null, teamUrl: null, botUserId: null, error: null };
    return this.status();
  }

  start(): void {
    if (this.status().configured) void this.restartWithIdentity();
  }

  stop(): void {
    this.socket?.stop();
    this.socket = null;
  }

  private async restartWithIdentity(): Promise<void> {
    try {
      const auth = await this.api().authTest();
      this.state = { ...this.state, team: auth.team, teamUrl: auth.url, botUserId: auth.user_id, error: null };
    } catch (err) {
      this.state = { ...this.state, error: err instanceof Error ? err.message : String(err) };
    }
    this.restart();
  }

  private restart(): void {
    this.socket?.stop();
    const appToken = this.secrets.get("slackAppToken");
    if (!appToken) return;
    this.socket = new SocketModeClient({
      openUrl: () => SlackApi.openSocket(appToken, this.fetchImpl),
      onEvent: (e) => void this.handle(e).catch((err) => console.error("Slack event failed:", err)),
      onStatus: (connection, detail) => {
        this.state = { ...this.state, connection, error: connection === "disconnected" && detail ? detail : connection === "connected" ? null : this.state.error };
      },
      createSocket: this.createSocket,
    });
    this.socket.start();
  }

  /** Turns a raw event into activity, or null for things Cadence ignores (its own posts, edits, joins). */
  normalize(e: SlackEventEnvelope): SlackActivity | null {
    const ev = e.event as Record<string, any>;
    const bot = this.state.botUserId;
    if (ev.type === "reaction_added") {
      if (ev.user === bot || ev.item?.type !== "message") return null;
      return { kind: "reaction", channel: ev.item.channel, ts: ev.item.ts, threadTs: ev.item.ts, user: ev.user ?? null, text: "", emoji: ev.reaction ?? null };
    }
    if (ev.type !== "message" && ev.type !== "app_mention") return null;
    // Cadence's own posts never come back as work.
    if (ev.user === bot || (bot !== null && ev.bot_profile?.user_id === bot)) return null;
    const fromBot = Boolean(ev.bot_id) || ev.subtype === "bot_message";
    if (ev.subtype && ev.subtype !== "thread_broadcast" && ev.subtype !== "file_share" && ev.subtype !== "bot_message") return null;
    if (!ev.channel || !ev.ts) return null;
    const mentioned = ev.type === "app_mention" || (bot !== null && String(ev.text ?? "").includes(`<@${bot}>`));
    return { kind: mentioned ? "mention" : "message", channel: ev.channel, ts: ev.ts, threadTs: ev.thread_ts ?? ev.ts, user: ev.user ?? ev.bot_id ?? null, text: String(ev.text ?? ""), emoji: null, ...(fromBot ? { bot: true } : {}) };
  }

  private remember(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value!);
    return true;
  }

  private async userName(id: string | null): Promise<string> {
    if (!id) return "someone";
    if (!this.names.has(id)) this.names.set(id, await this.api().userName(id));
    return this.names.get(id)!;
  }

  async handle(e: SlackEventEnvelope): Promise<string[]> {
    const a = this.normalize(e);
    if (!a) return [];
    // A mention arrives as both app_mention and message; act once per message.
    const key = a.kind === "reaction" ? `r:${a.channel}:${a.ts}:${a.user}:${a.emoji}` : `m:${a.channel}:${a.ts}`;
    if (!this.remember(key)) return [];

    const who = await this.userName(a.user);
    const clean = a.text.replace(this.state.botUserId ? new RegExp(`<@${this.state.botUserId}>`, "g") : /$^/, "@Cadence").trim();
    const where = `<#${a.channel}>`;
    const head =
      a.kind === "reaction"
        ? `Slack reaction: ${who} reacted :${a.emoji}: to a message in ${where}.`
        : `Slack ${a.kind === "mention" ? "mention" : "message"} from ${who} in ${where}${a.threadTs !== a.ts ? " (thread reply)" : ""}:`;
    const lines = [head];
    if (clean) lines.push(clean.split("\n").map((l) => `> ${l}`).join("\n"));
    lines.push(`Channel: ${a.channel} · message ts: ${a.ts} · thread ts: ${a.threadTs}`);
    lines.push(`Read the thread with slack_read_thread and reply in it with slack_reply (channel ${a.channel}, thread_ts ${a.threadTs}). Only post in Slack when you were mentioned or asked to.`);
    const context = lines.join("\n");
    const threadKey = threadKeyOf(a.channel, a.threadTs);

    // Replies in a thread an agent already owns go back to that chat.
    // Bots replying in a thread never wake the agent that owns it (two bots would loop).
    if (a.kind !== "reaction" && a.threadTs !== a.ts && !a.bot) {
      const owners = this.q.chats().filter((c) => (c.threadKey === threadKey || c.slackThreads?.follow.includes(threadKey)) && !c.slackThreads?.muted.includes(threadKey) && c.agentId && !c.archived);
      if (owners.length) return owners.map((c) => this.triggers.fireSlackThread(c.agentId!, context, threadKey)).filter((x): x is string => Boolean(x));
    }
    // Agents that stopped listening to this thread are not woken by it again.
    const muted = new Set(this.q.chats().filter((c) => c.agentId && c.slackThreads?.muted.includes(threadKey)).map((c) => c.agentId!));
    return this.triggers.fireSlack(a, context, threadKey, muted);
  }
}
