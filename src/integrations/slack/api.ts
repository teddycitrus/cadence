export class SlackError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface SlackMessage {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text: string;
}

export interface SlackUser {
  id: string;
  name: string;
  realName: string;
  displayName: string;
  email: string | null;
}

interface RawUser {
  id: string;
  name: string;
  deleted?: boolean;
  is_bot?: boolean;
  real_name?: string;
  profile?: { display_name?: string; email?: string; real_name?: string };
}

const toUser = (m: RawUser): SlackUser => ({ id: m.id, name: m.name, realName: m.real_name ?? m.profile?.real_name ?? "", displayName: m.profile?.display_name ?? "", email: m.profile?.email ?? null });

const CHANNEL = /^[CGD][A-Z0-9]+$/;
const TS = /^\d+\.\d+$/;

export function assertChannel(id: string): string {
  if (!CHANNEL.test(id)) throw new SlackError(`"${id}" is not a Slack channel id (like C0123ABCD)`, "invalid_channel");
  return id;
}

export function assertTs(ts: string): string {
  if (!TS.test(ts)) throw new SlackError(`"${ts}" is not a Slack message timestamp (like 1712345678.000100)`, "invalid_ts");
  return ts;
}

/** The slice of the Slack Web API Cadence uses, authenticated as the bot. */
/** How the bot signs its posts; needs the chat:write.customize scope. */
export interface SlackIdentity {
  name: string | null;
  iconUrl: string | null;
}

export class SlackApi {
  constructor(
    private token: string,
    private fetchImpl: typeof fetch = fetch,
    private identity: SlackIdentity = { name: null, iconUrl: null },
  ) {}

  async call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(params),
    });
    if (res.status === 429) throw new SlackError("Slack is rate limiting Cadence; try again shortly", "ratelimited");
    const body = (await res.json()) as { ok: boolean; error?: string } & T;
    if (!body.ok) throw new SlackError(`Slack ${method} failed: ${body.error ?? res.status}`, body.error ?? String(res.status));
    return body;
  }

  authTest(): Promise<{ team: string; team_id: string; user_id: string; bot_id?: string; url: string }> {
    return this.call("auth.test");
  }

  async postMessage(channel: string, text: string, threadTs?: string): Promise<{ ts: string; channel: string }> {
    const as = { ...(this.identity.name ? { username: this.identity.name } : {}), ...(this.identity.iconUrl ? { icon_url: this.identity.iconUrl } : {}) };
    const r = await this.call<{ ts: string; channel: string }>("chat.postMessage", { channel: assertChannel(channel), text, ...(threadTs ? { thread_ts: assertTs(threadTs) } : {}), unfurl_links: false, ...as });
    return { ts: r.ts, channel: r.channel };
  }

  async react(channel: string, ts: string, name: string): Promise<void> {
    try {
      await this.call("reactions.add", { channel: assertChannel(channel), timestamp: assertTs(ts), name: name.replace(/:/g, "") });
    } catch (err) {
      if (!(err instanceof SlackError && err.code === "already_reacted")) throw err;
    }
  }

  async replies(channel: string, ts: string, limit = 100): Promise<SlackMessage[]> {
    const r = await this.call<{ messages: SlackMessage[] }>("conversations.replies", { channel: assertChannel(channel), ts: assertTs(ts), limit });
    return r.messages;
  }

  async history(channel: string, limit = 30): Promise<SlackMessage[]> {
    const r = await this.call<{ messages: SlackMessage[] }>("conversations.history", { channel: assertChannel(channel), limit });
    return r.messages;
  }

  async channels(): Promise<{ id: string; name: string; is_member: boolean; is_private: boolean }[]> {
    const out: { id: string; name: string; is_member: boolean; is_private: boolean }[] = [];
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const r = await this.call<{ channels: typeof out; response_metadata?: { next_cursor?: string } }>("conversations.list", { types: "public_channel,private_channel", exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) });
      out.push(...r.channels.map((c) => ({ id: c.id, name: c.name, is_member: c.is_member, is_private: c.is_private })));
      cursor = r.response_metadata?.next_cursor ?? "";
      if (!cursor) break;
    }
    return out;
  }

  async userName(id: string): Promise<string> {
    try {
      const r = await this.call<{ user: { real_name?: string; name: string; profile?: { display_name?: string } } }>("users.info", { user: id });
      return r.user.profile?.display_name || r.user.real_name || r.user.name;
    } catch {
      return id;
    }
  }

  async permalink(channel: string, ts: string): Promise<string | null> {
    try {
      return (await this.call<{ permalink: string }>("chat.getPermalink", { channel, message_ts: ts })).permalink;
    } catch {
      return null;
    }
  }

  async unreact(channel: string, ts: string, name: string): Promise<void> {
    try {
      await this.call("reactions.remove", { channel: assertChannel(channel), timestamp: assertTs(ts), name: name.replace(/:/g, "") });
    } catch (err) {
      if (!(err instanceof SlackError && err.code === "no_reaction")) throw err;
    }
  }

  async update(channel: string, ts: string, text: string): Promise<void> {
    await this.call("chat.update", { channel: assertChannel(channel), ts: assertTs(ts), text });
  }

  async remove(channel: string, ts: string): Promise<void> {
    await this.call("chat.delete", { channel: assertChannel(channel), ts: assertTs(ts) });
  }

  async join(channel: string): Promise<void> {
    await this.call("conversations.join", { channel: assertChannel(channel) });
  }

  /** Opens (or finds) a DM or group DM with these users and returns its channel id. */
  async openDm(users: string[]): Promise<string> {
    return (await this.call<{ channel: { id: string } }>("conversations.open", { users: users.join(",") })).channel.id;
  }

  async users(): Promise<SlackUser[]> {
    const out: SlackUser[] = [];
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const r = await this.call<{ members: RawUser[]; response_metadata?: { next_cursor?: string } }>("users.list", { limit: 200, ...(cursor ? { cursor } : {}) });
      out.push(...r.members.filter((m) => !m.deleted && !m.is_bot && m.id !== "USLACKBOT").map(toUser));
      cursor = r.response_metadata?.next_cursor ?? "";
      if (!cursor) break;
    }
    return out;
  }

  async userByEmail(email: string): Promise<SlackUser | null> {
    try {
      return toUser((await this.call<{ user: RawUser }>("users.lookupByEmail", { email })).user);
    } catch (err) {
      if (err instanceof SlackError && err.code === "users_not_found") return null;
      throw err;
    }
  }

  async fileInfo(file: string): Promise<{ id: string; name: string; mimetype: string; size: number; url_private_download?: string; url_private?: string; permalink?: string }> {
    return (await this.call<{ file: { id: string; name: string; mimetype: string; size: number; url_private_download?: string; url_private?: string; permalink?: string } }>("files.info", { file })).file;
  }

  /** Downloads a file the bot can see (Slack file URLs need the bot token). */
  async download(url: string): Promise<Buffer> {
    if (!/^https:\/\/([a-z0-9-]+\.)*slack(-files)?\.com\//.test(url)) throw new SlackError("Not a Slack file URL", "invalid_url");
    const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new SlackError(`Downloading the file failed: ${res.status}`, String(res.status));
    return Buffer.from(await res.arrayBuffer());
  }

  /** Uploads a file into a conversation (Slack's two-step external upload). */
  async upload(channel: string, name: string, data: Buffer, opts: { threadTs?: string; comment?: string } = {}): Promise<string> {
    const step = await this.call<{ upload_url: string; file_id: string }>("files.getUploadURLExternal", { filename: name, length: data.length });
    const put = await this.fetchImpl(step.upload_url, { method: "POST", body: new Uint8Array(data) });
    if (!put.ok) throw new SlackError(`Uploading to Slack failed: ${put.status}`, String(put.status));
    await this.call("files.completeUploadExternal", { files: [{ id: step.file_id, title: name }], channel_id: assertChannel(channel), ...(opts.threadTs ? { thread_ts: assertTs(opts.threadTs) } : {}), ...(opts.comment ? { initial_comment: opts.comment } : {}) });
    return step.file_id;
  }

  /** Socket Mode needs the app-level token (xapp-), not the bot token. */
  static async openSocket(appToken: string, fetchImpl: typeof fetch = fetch): Promise<string> {
    return (await new SlackApi(appToken, fetchImpl).call<{ url: string }>("apps.connections.open")).url;
  }
}
