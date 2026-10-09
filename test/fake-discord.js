// A tiny in-memory imitation of the Discord REST endpoints discord-mcp uses.
import http from "node:http";

export function createFakeDiscord({ manageWebhooks = true } = {}) {
  let nextId = 1000n;
  const id = () => String(nextId++);
  const bot = { id: "1", username: "agentbot", bot: true };
  const guildId = "10";
  const channels = new Map([["100", { id: "100", type: 0, guild_id: guildId, messages: [] }]]);
  const webhooks = [];

  function addMessage(channelId, msg) {
    const ch = channels.get(channelId);
    const full = { id: id(), channel_id: channelId, timestamp: new Date().toISOString(), attachments: [], embeds: [], mention_everyone: false, ...msg };
    if (full.message_reference) {
      full.referenced_message = findMessage(full.message_reference.message_id) ?? null;
    }
    ch.messages.push(full);
    return full;
  }
  function findMessage(mid) {
    for (const ch of channels.values()) {
      const m = ch.messages.find((x) => x.id === mid);
      if (m) return m;
    }
  }
  const forbidden = (name) => /discord|clyde/i.test(name);
  const userSays = (channelId, content, extra = {}) =>
    addMessage(channelId, { content, author: { id: "500", username: "alice", global_name: "Alice" }, ...extra });

  async function handle(req, body) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    const q = Object.fromEntries(url.searchParams);
    let m;
    if (p === "/users/@me") return bot;
    if ((m = /^\/channels\/(\d+)$/.exec(p))) {
      const ch = channels.get(m[1]);
      if (!ch) return [404, { message: "Unknown Channel" }];
      const { messages, ...rest } = ch;
      return rest;
    }
    if ((m = /^\/channels\/(\d+)\/messages$/.exec(p))) {
      const ch = channels.get(m[1]);
      if (!ch) return [404, { message: "Unknown Channel" }];
      if (req.method === "POST") return addMessage(m[1], { ...body, author: bot });
      let list = ch.messages;
      const limit = Number(q.limit ?? 50);
      if (q.after) list = list.filter((x) => BigInt(x.id) > BigInt(q.after)).slice(0, limit);
      else list = list.slice(-limit);
      return [...list].reverse();
    }
    if ((m = /^\/channels\/(\d+)\/webhooks$/.exec(p))) {
      if (!manageWebhooks) return [403, { message: "Missing Permissions" }];
      if (req.method === "GET") return webhooks.filter((w) => w.channel_id === m[1]);
      if (forbidden(body.name)) return [400, { message: "Invalid Form Body" }];
      const w = { id: id(), token: "tok" + nextId, name: body.name, channel_id: m[1] };
      webhooks.push(w);
      return w;
    }
    if ((m = /^\/webhooks\/(\d+)\/(\w+)$/.exec(p))) {
      const w = webhooks.find((x) => x.id === m[1] && x.token === m[2]);
      if (!w) return [401, { message: "Invalid Webhook Token" }];
      if (body.username && forbidden(body.username)) return [400, { message: "Invalid Form Body" }];
      const target = q.thread_id ?? w.channel_id;
      if (!channels.has(target)) return [404, { message: "Unknown Channel" }];
      return addMessage(target, {
        content: body.content,
        webhook_id: w.id,
        author: { id: w.id, username: body.username ?? w.name, bot: true },
      });
    }
    if ((m = /^\/guilds\/(\d+)\/threads\/active$/.exec(p))) {
      const threads = [...channels.values()].filter((c) => c.type === 11).map(({ messages, ...t }) => t);
      return { threads };
    }
    if ((m = /^\/channels\/(\d+)\/threads\/archived\/public$/.exec(p))) return { threads: [] };
    if ((m = /^\/channels\/(\d+)\/threads$/.exec(p))) {
      const t = { id: id(), type: 11, guild_id: guildId, parent_id: m[1], name: body.name, messages: [] };
      channels.set(t.id, t);
      const { messages, ...rest } = t;
      return rest;
    }
    return [404, { message: `no route ${req.method} ${p}` }];
  }

  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    let out = await handle(req, raw ? JSON.parse(raw) : undefined);
    let status = 200;
    if (Array.isArray(out) && typeof out[0] === "number") [status, out] = out;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  });

  return {
    channels,
    webhooks,
    bot,
    userSays,
    addMessage,
    async listen() {
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${server.address().port}`;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
