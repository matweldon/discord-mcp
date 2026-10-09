import fs from "node:fs";
import path from "node:path";
import { sanitizeName } from "./config.js";
import { DiscordError, parseWebhookUrl, sleep, snowflakeCmp } from "./discord.js";

// Discord rejects webhook names and usernames containing "discord" or "clyde".
const WEBHOOK_NAME = "mcp-agents";
const MAX_LEN = 2000;
const MAX_PAGES = 10;
// Discord's limit on channel (and so thread) names.
const MAX_THREAD_NAME = 100;
// list_sessions scans at most this many of the channel's active threads, this many messages each.
const MAX_SCANNED_THREADS = 20;
const THREAD_SCAN_LIMIT = 50;
// How soon a capped wait_for_message must be called again to continue the same wait.
const RESUME_GRACE_MS = 60_000;

/**
 * One agent session connected to a Discord channel. Talks to Discord over REST only,
 * so any number of sessions can share one bot token without fighting over a gateway.
 */
export class Session {
  /**
   * @param {ReturnType<import("./config.js").parseConfig>} config
   * @param {import("./discord.js").DiscordClient} client
   */
  constructor(config, client) {
    this.config = config;
    this.client = client;
    this.postedIds = new Set();
    this.warnings = [];
    this.state = { cursors: {} };
    this.ready = null;
    // Names (lowercased) this session listens to, set with listenTo(); null means everyone.
    this.listening = null;
    // The thread this session is in (set with enterThread), or null for the main channel.
    this.threadId = null;
    this.threadName = null;
    this.applyName(config.name);
  }

  applyName(name) {
    this.name = name;
    this.nameLower = name.toLowerCase();
    this.statePath = path.join(this.config.stateDir, `${this.config.channelId}-${this.nameLower}.json`);
  }

  /**
   * Rename this session. The inbox carries on from the current read position (or the new
   * name's saved one, if later): unread messages to the new name are delivered, older
   * history isn't replayed.
   */
  async setName(raw) {
    const name = sanitizeName(raw);
    if (!name) throw new Error(`"${raw}" is not a usable name; use letters, digits, "-", "_" or "."`);
    await this.init();
    const previous = this.name;
    if (name === previous) return { previous, name };
    const inOwnThread = this.isOwnThread();
    const cursors = { ...this.state.cursors };
    this.applyName(name);
    // If this name was used before, keep whichever read position is later, so messages
    // it already read aren't delivered again.
    this.state = { cursors: {} };
    this.loadState();
    for (const [ch, id] of Object.entries(cursors)) {
      const saved = this.state.cursors[ch];
      if (saved === undefined || snowflakeCmp(id, saved) > 0) this.state.cursors[ch] = id;
    }
    // Stay in the current thread, not the one the new name's saved state was in.
    this.rememberThread();
    // A thread named after the session moves with it; a shared thread doesn't.
    if (inOwnThread) await this.enterThread(name);
    for (const ch of this.inboxChannels()) {
      if (this.state.cursors[ch] === undefined) this.state.cursors[ch] = await this.latestMessageId(ch);
    }
    this.saveState();
    return { previous, name };
  }

  /** Lazily initialise once; tool calls await this. */
  init() {
    this.ready ??= this._init().catch((err) => {
      this.ready = null; // allow a retry on the next tool call
      throw err;
    });
    return this.ready;
  }

  async _init() {
    this.loadState();
    this.me = await this.client.getMe();
    this.channel = await this.client.getChannel(this.config.channelId);
    this.guildId = this.channel.guild_id ?? "@me";
    this.webhook = await this.resolveWebhook();
    await this.restoreThread();
    for (const ch of this.inboxChannels()) {
      if (this.state.cursors[ch] === undefined) this.state.cursors[ch] = await this.latestMessageId(ch);
    }
    this.saveState();
  }

  // ---------- setup helpers ----------

  async resolveWebhook() {
    const w = this.config.webhook;
    if (w === "off" || w === "false" || w === "none") return null;
    if (w !== "auto") return parseWebhookUrl(w);
    try {
      const hooks = await this.client.getChannelWebhooks(this.config.channelId);
      const existing = hooks.find((h) => h.name === WEBHOOK_NAME && h.token);
      const hook = existing ?? (await this.client.createWebhook(this.config.channelId, WEBHOOK_NAME));
      return { id: hook.id, token: hook.token };
    } catch (err) {
      if (err instanceof DiscordError && (err.status === 403 || err.status === 400)) {
        this.warnings.push(
          `Could not use a webhook (${err.body?.message ?? err.message}; does the bot have Manage Webhooks in this channel?) ` +
            "— posting as the bot with a [name] prefix instead."
        );
        return null;
      }
      throw err;
    }
  }

  /** Go back into the thread saved in the state file, if it still exists under the channel. */
  async restoreThread() {
    const id = this.state.threadId;
    if (!id) return;
    try {
      const t = await this.client.getChannel(id);
      if (t.parent_id === this.config.channelId) {
        this.threadId = t.id;
        this.threadName = t.name;
        this.rememberThread();
        return;
      }
    } catch (err) {
      if (!(err instanceof DiscordError) || err.status >= 500) throw err;
    }
    // Gone, or no longer under this channel: back to the main channel.
    delete this.state.cursors[id];
    this.threadId = this.threadName = null;
    this.rememberThread();
  }

  /** Find a thread under the channel by name (active first, then archived), or create it. */
  async findOrCreateThread(name) {
    const parent = this.config.channelId;
    const lower = name.toLowerCase();
    const matches = (t) => t.parent_id === parent && t.name.toLowerCase() === lower;
    const active = await this.client.getActiveThreads(this.channel.guild_id);
    let thread = (active.threads ?? []).find(matches);
    if (!thread) {
      const archived = await this.client.getArchivedPublicThreads(parent).catch(() => ({ threads: [] }));
      thread = (archived.threads ?? []).find(matches);
    }
    if (thread) return { thread, created: false };
    return { thread: await this.client.createThread(parent, name), created: true };
  }

  /**
   * Move this session into a thread under the channel, by default one named after it. The
   * thread is found or created; reading starts from its latest message. Entering another
   * thread leaves the current one first.
   */
  async enterThread(raw) {
    await this.init();
    const name = threadName(raw ?? this.name);
    if (!name) throw new Error(`"${raw}" is not a usable thread name`);
    if (!this.channel.guild_id) throw new Error("Threads aren't available here: the channel isn't in a server.");
    if (this.threadId && this.threadName?.toLowerCase() === name.toLowerCase()) {
      return { thread: { id: this.threadId, name: this.threadName }, already: true };
    }
    const left = await this.leaveThread();
    const { thread, created } = await this.findOrCreateThread(name);
    // Announce in the main channel before switching, since post() targets the current thread.
    await this.post(`**${this.name}** is now working in the thread ${this.channelLink(thread.id)}.`);
    this.threadId = thread.id;
    this.threadName = thread.name;
    this.state.cursors[thread.id] = await this.latestMessageId(thread.id);
    this.rememberThread();
    this.saveState();
    return { thread, created, left };
  }

  /** Go back to the main channel. Returns the thread left, or null if not in one. */
  async leaveThread() {
    await this.init();
    if (!this.threadId) return null;
    const left = { id: this.threadId, name: this.threadName };
    // Say goodbye in the thread while it's still the post target.
    await this.post(`**${this.name}** has left this thread and is back in the main channel.`);
    delete this.state.cursors[left.id];
    this.threadId = this.threadName = null;
    this.rememberThread();
    this.saveState();
    return left;
  }

  /** Whether the current thread is this session's own, named after it. */
  isOwnThread() {
    return !!this.threadId && this.threadName?.toLowerCase() === this.nameLower;
  }

  /** Copy the current thread into the state to be saved. */
  rememberThread() {
    if (this.threadId) Object.assign(this.state, { threadId: this.threadId, threadName: this.threadName });
    else {
      delete this.state.threadId;
      delete this.state.threadName;
    }
  }

  async latestMessageId(channelId) {
    const msgs = await this.client.getMessages(channelId, { limit: 1 });
    return msgs.length ? msgs[0].id : "0";
  }

  inboxChannels() {
    return this.threadId ? [this.threadId, this.config.channelId] : [this.config.channelId];
  }

  loadState() {
    try {
      const s = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      if (s && typeof s === "object") this.state = { cursors: {}, ...s };
    } catch {
      /* no state yet */
    }
  }

  saveState() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      const msg = `Could not save state to ${this.statePath}: ${err.message}`;
      if (!this.warnings.includes(msg)) this.warnings.push(msg);
    }
  }

  // ---------- posting ----------

  get botPrefix() {
    return `**[${this.name}]** `;
  }

  /**
   * Post a message as this session. Long messages are split into several posts.
   * @returns {Promise<object[]>} the created Discord messages
   */
  async post(content, { replyTo, to } = {}) {
    if (!content || !content.trim()) throw new Error("Message content is empty");
    if (to) {
      const names = (Array.isArray(to) ? to : [to]).map((n) => `@${String(n).replace(/^@/, "")}`);
      content = `${names.join(" ")} ${content}`;
    }
    const target = this.threadId ?? this.config.channelId;
    let replyLink = "";
    if (replyTo && this.webhook) {
      // Webhooks can't create native replies, so link to the message instead.
      replyLink = `↪ ${this.messageLink(target, replyTo)}\n`;
    }
    const limit = MAX_LEN - (this.webhook ? 0 : this.botPrefix.length);
    const chunks = splitMessage(replyLink + content, limit);
    const sent = [];
    for (const [i, chunk] of chunks.entries()) {
      let msg;
      if (this.webhook) {
        msg = await this.client.executeWebhook(
          this.webhook.id,
          this.webhook.token,
          {
            content: chunk,
            username: webhookUsername(this.name),
            avatar_url: this.config.avatarUrl,
            allowed_mentions: { parse: ["users", "roles"] },
          },
          this.threadId
        );
      } else {
        const body = {
          content: this.botPrefix + chunk,
          allowed_mentions: { parse: ["users", "roles"], replied_user: true },
        };
        if (replyTo && i === 0) body.message_reference = { message_id: replyTo, fail_if_not_exists: false };
        msg = await this.client.sendMessage(target, body);
      }
      this.postedIds.add(msg.id);
      sent.push(msg);
    }
    return sent;
  }

  messageLink(channelId, messageId) {
    return `https://discord.com/channels/${this.guildId}/${channelId}/${messageId}`;
  }

  channelLink(channelId) {
    return `https://discord.com/channels/${this.guildId}/${channelId}`;
  }

  // ---------- reading ----------

  /** Who sent a message, and whether it was this session. */
  describeSender(m) {
    if (m.webhook_id) {
      const ours = this.webhook && m.webhook_id === this.webhook.id;
      return {
        name: m.author?.username ?? "webhook",
        kind: ours ? "session" : "webhook",
        self: ours && m.author?.username?.toLowerCase() === webhookUsername(this.name).toLowerCase(),
      };
    }
    if (this.me && m.author?.id === this.me.id) {
      const pm = /^\*\*\[([^\]]+)\]\*\* ?/.exec(m.content ?? "");
      const name = pm ? pm[1] : this.me.username;
      return { name, kind: "session", self: name.toLowerCase() === this.nameLower, prefix: pm?.[0] };
    }
    return {
      name: m.author?.global_name || m.author?.username || "unknown",
      username: m.author?.username,
      id: m.author?.id,
      kind: m.author?.bot ? "bot" : "user",
      self: false,
    };
  }

  /**
   * Only deliver messages from these senders (session names, Discord usernames or user ids);
   * everyone else is just counted. An empty list listens to everyone again.
   */
  listenTo(names) {
    const list = [...new Set((names ?? []).map((n) => String(n).trim().replace(/^@/, "").toLowerCase()).filter(Boolean))];
    this.listening = list.length ? list : null;
    return this.listening;
  }

  /** Of the listen_to names, those that match no sender among the channel's recent messages. */
  async unseenNames(names) {
    await this.init();
    const msgs = await this.client.getMessages(this.threadId ?? this.config.channelId, { limit: 100 });
    const seen = new Set([this.nameLower]);
    for (const m of msgs) {
      const s = this.describeSender(m);
      for (const k of s.kind === "user" ? [s.username, s.id] : [s.name]) if (k) seen.add(String(k).toLowerCase());
    }
    return names.filter((n) => !seen.has(n));
  }

  /**
   * Whether the listen_to filter lets this sender through. Owners always get through. People
   * match on username or id only: anyone can set their display name to "dana".
   */
  isListenedTo(sender) {
    if (!this.listening) return true;
    if (sender.kind === "user" && this.config.owners.includes(sender.id)) return true;
    const keys = (sender.kind === "user" ? [sender.username, sender.id] : [sender.name])
      .filter(Boolean)
      .map((k) => String(k).toLowerCase());
    return keys.some((k) => this.listening.includes(k));
  }

  isSelf(m) {
    return !!m && (this.postedIds.has(m.id) || this.describeSender(m).self);
  }

  mentionsMe(content) {
    const n = escapeRegExp(this.nameLower);
    const c = (content ?? "").toLowerCase();
    return new RegExp(`(^|[^\\w@])@(${n}|all)(?![\\w-]|\\.\\w)`).test(c) || new RegExp(`^\\s*${n}\\s*[:,]`).test(c);
  }

  /** Decide whether a message belongs in this session's inbox. Returns a reason or null. */
  classify(m, channelId) {
    const sender = this.describeSender(m);
    if (sender.self || this.postedIds.has(m.id)) return null;
    if (sender.kind === "user" && this.config.allowedUsers.length && !this.config.allowedUsers.includes(sender.id)) {
      return null;
    }
    if (sender.kind === "bot" || sender.kind === "webhook") return null;
    if (!this.isListenedTo(sender)) return null;
    // Everything in the session's own thread is for it; a shared thread works like the channel.
    if (this.isOwnThread() && channelId === this.threadId) return "in your thread";
    const refId = m.message_reference?.message_id;
    if (refId && (this.postedIds.has(refId) || this.isSelf(m.referenced_message))) return "reply to you";
    if (this.mentionsMe(m.content)) return /@all\b/i.test(m.content) ? "@all" : "mentions you";
    if (m.mention_everyone) return "@everyone";
    return null;
  }

  /** Whether an unaddressed message is shown as context: posts by people (allowed ones) and sessions. */
  isContext(m) {
    const sender = this.describeSender(m);
    if (sender.self || this.postedIds.has(m.id)) return false;
    if (!this.isListenedTo(sender)) return false;
    if (sender.kind === "session") return true;
    return sender.kind === "user" && (!this.config.allowedUsers.length || this.config.allowedUsers.includes(sender.id));
  }

  async fetchNew(channelId) {
    let after = this.state.cursors[channelId] ?? "0";
    const all = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await this.client.getMessages(channelId, { after, limit: 100 });
      if (!batch.length) break;
      batch.sort((a, b) => snowflakeCmp(a.id, b.id));
      all.push(...batch);
      after = batch[batch.length - 1].id;
      if (batch.length < 100) break;
    }
    return all;
  }

  /**
   * Fetch new messages addressed to this session and advance the read cursor. Other new
   * messages from people and sessions come back as `context`, so the session can follow
   * the conversation without treating them as requests.
   * @returns {Promise<{messages: object[], context: object[], skipped: number}>}
   */
  async checkInbox() {
    await this.init();
    const messages = [];
    const context = [];
    let skipped = 0;
    for (const ch of this.inboxChannels()) {
      const fresh = await this.fetchNew(ch);
      for (const m of fresh) {
        const reason = this.classify(m, ch);
        if (reason) messages.push({ ...m, _reason: reason, _channel: ch, _sender: this.describeSender(m) });
        else if (this.isContext(m)) context.push({ ...m, _channel: ch, _sender: this.describeSender(m) });
        else if (!this.isSelf(m)) skipped++;
      }
      if (fresh.length) this.state.cursors[ch] = fresh[fresh.length - 1].id;
    }
    this.saveState();
    messages.sort((a, b) => snowflakeCmp(a.id, b.id));
    context.sort((a, b) => snowflakeCmp(a.id, b.id));
    return { messages, context, skipped };
  }

  /**
   * The latest messages in the channel (or the thread this session is in), oldest first. Doesn't move
   * the read cursor. Like the inbox, leaves out bots, users outside the allowlist and senders
   * outside the listen_to filter (`hidden` counts them).
   */
  async readChannel(limit, where = "channel") {
    await this.init();
    if (where === "thread" && !this.threadId) {
      throw new Error('Not in a thread. Call enter_thread first, or use where "channel".');
    }
    const ch = where === "thread" ? this.threadId : this.config.channelId;
    const msgs = await this.client.getMessages(ch, { limit });
    msgs.sort((a, b) => snowflakeCmp(a.id, b.id));
    const messages = [];
    let hidden = 0;
    for (const m of msgs) {
      if (!this.isSelf(m) && !this.isContext(m)) {
        hidden++;
        continue;
      }
      const reason = this.isSelf(m) ? "you" : this.classify(m, ch) ?? "";
      messages.push({ ...m, _reason: reason, _channel: ch, _sender: this.describeSender(m) });
    }
    return { messages, hidden };
  }

  /**
   * Poll until a message arrives or the timeout passes. MCP clients time tool calls out
   * (Claude Code after 60s), so one call blocks for at most config.maxWait seconds and
   * returns `pending`; calling again with the same timeout soon after carries on the same wait.
   * Stops polling once `signal` aborts (the client cancelled or gave up), so an abandoned
   * call doesn't mark messages as read that nobody will see.
   */
  async waitForMessages(timeoutSec, onTick, signal) {
    const now = Date.now();
    const prev = this.pendingWait;
    const resume = prev && prev.timeoutSec === timeoutSec && now - prev.returnedAt < RESUME_GRACE_MS && now < prev.deadline;
    const deadline = resume ? prev.deadline : now + timeoutSec * 1000;
    const callDeadline = this.config.maxWait > 0 ? Math.min(deadline, now + this.config.maxWait * 1000) : deadline;
    this.pendingWait = null;
    let skipped = 0;
    const context = [];
    for (;;) {
      if (signal?.aborted) return { messages: [], context, skipped, cancelled: true };
      const res = await this.checkInbox();
      skipped += res.skipped;
      context.push(...res.context);
      if (res.messages.length) return { messages: res.messages, context, skipped };
      const left = deadline - Date.now();
      if (left <= 0) return { messages: [], context, skipped, timedOut: true };
      const callLeft = callDeadline - Date.now();
      if (callLeft <= 0) {
        this.pendingWait = { timeoutSec, deadline, returnedAt: Date.now() };
        const pending = { waited: Math.round(timeoutSec - left / 1000), left: Math.ceil(left / 1000) };
        return { messages: [], context, skipped, pending };
      }
      await onTick?.(timeoutSec - left / 1000, timeoutSec);
      await sleep(Math.min(this.config.pollInterval * 1000, callLeft), signal);
    }
  }

  /** Session names seen recently in the channel and its active threads. */
  async listSessions() {
    await this.init();
    const seen = new Map();
    const merge = (msgs, threadName) => {
      for (const m of msgs) {
        const s = this.describeSender(m);
        if (s.kind !== "session") continue;
        const key = s.name.toLowerCase();
        const prev = seen.get(key);
        if (!prev || snowflakeCmp(m.id, prev.lastId) > 0) {
          seen.set(key, { name: s.name, lastId: m.id, lastSeen: m.timestamp, thread: threadName ?? prev?.thread });
        } else if (threadName && !prev.thread) prev.thread = threadName;
      }
    };
    merge(await this.client.getMessages(this.config.channelId, { limit: 100 }));
    if (this.channel.guild_id) {
      const active = await this.client.getActiveThreads(this.channel.guild_id);
      // The newest threads (ids are snowflakes, so they sort by creation time), fetched in
      // parallel but merged in order so the result doesn't depend on timing.
      const threads = (active.threads ?? [])
        .filter((t) => t.parent_id === this.config.channelId)
        .sort((a, b) => snowflakeCmp(b.id, a.id))
        .slice(0, MAX_SCANNED_THREADS);
      const pages = await Promise.all(
        threads.map((t) => this.client.getMessages(t.id, { limit: THREAD_SCAN_LIMIT }).catch(() => []))
      );
      threads.forEach((t, i) => merge(pages[i], t.name));
    }
    if (!seen.has(this.nameLower)) seen.set(this.nameLower, { name: this.name, lastSeen: null });
    return [...seen.values()].sort((a, b) => String(b.lastSeen ?? "").localeCompare(String(a.lastSeen ?? "")));
  }

  // ---------- formatting ----------

  formatMessage(m) {
    const s = m._sender ?? this.describeSender(m);
    let content = m.content ?? "";
    if (s.prefix && content.startsWith(s.prefix)) content = content.slice(s.prefix.length);
    const when = m.timestamp ? new Date(m.timestamp).toISOString().replace(/\.\d+Z$/, "Z") : "";
    const who = s.kind === "user" ? `${s.name} (user ${s.username ?? ""})`.replace(" )", ")") : `${s.name} (${s.kind})`;
    const lines = [`[id ${m.id}] ${when} from ${who} — ${m._reason ?? ""}`.trimEnd()];
    if (content) lines.push(content);
    for (const a of m.attachments ?? []) lines.push(`attachment: ${a.filename} ${a.url}`);
    for (const e of m.embeds ?? []) {
      const parts = [e.title, e.description, e.url].filter(Boolean);
      if (parts.length) lines.push(`embed: ${parts.join(" — ")}`);
    }
    if (!content && !(m.attachments ?? []).length && !(m.embeds ?? []).length && !(m.sticker_items ?? []).length) {
      lines.push("(empty — if this keeps happening, enable the Message Content Intent for the bot)");
    }
    return lines.join("\n");
  }
}

/** A usable thread name: trimmed, single-spaced, without control characters, within Discord's limit. */
export function threadName(raw) {
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_THREAD_NAME);
}

export function splitMessage(text, limit = MAX_LEN) {
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

/** The name to post under via webhook, avoiding words Discord forbids in usernames. */
export function webhookUsername(name) {
  return name.replace(/discord/gi, (w) => w.replace(/o/i, "0")).replace(/clyde/gi, (w) => w.replace(/e/i, "3"));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
