// Minimal Discord REST client (no gateway). Handles rate limits and errors.

const API = process.env.DISCORD_API_BASE || "https://discord.com/api/v10";

export class DiscordError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class DiscordClient {
  /**
   * @param {string} token bot token
   * @param {{ fetch?: typeof fetch, maxRetries?: number }} [opts]
   */
  constructor(token, opts = {}) {
    this.token = token;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.maxRetries = opts.maxRetries ?? 5;
  }

  async request(method, path, { body, query, auth = true } = {}) {
    let url = API + path;
    if (query) {
      const qs = new URLSearchParams(
        Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
      ).toString();
      if (qs) url += (url.includes("?") ? "&" : "?") + qs;
    }
    const headers = { "User-Agent": "discord-mcp (https://github.com/matweldon/discord-mcp, 1.0)" };
    if (auth) headers.Authorization = `Bot ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429 && attempt < this.maxRetries) {
        let wait = 1;
        try {
          const data = await res.json();
          wait = Number(data.retry_after) || wait;
        } catch {
          wait = Number(res.headers?.get?.("retry-after")) || wait;
        }
        await sleep(Math.min(wait, 30) * 1000 + 50);
        continue;
      }
      if (res.status >= 500 && attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      if (res.status === 204) return null;
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      if (!res.ok) {
        const msg = (data && data.message) || text || res.statusText;
        throw new DiscordError(`Discord API ${method} ${path} failed (${res.status}): ${msg}`, res.status, data);
      }
      return data;
    }
  }

  getMe() {
    return this.request("GET", "/users/@me");
  }
  getChannel(id) {
    return this.request("GET", `/channels/${id}`);
  }
  /** Returns messages in the channel; Discord returns them newest-first. */
  getMessages(channelId, query) {
    return this.request("GET", `/channels/${channelId}/messages`, { query });
  }
  sendMessage(channelId, body) {
    return this.request("POST", `/channels/${channelId}/messages`, { body });
  }
  getChannelWebhooks(channelId) {
    return this.request("GET", `/channels/${channelId}/webhooks`);
  }
  createWebhook(channelId, name) {
    return this.request("POST", `/channels/${channelId}/webhooks`, { body: { name } });
  }
  executeWebhook(id, token, body, threadId) {
    return this.request("POST", `/webhooks/${id}/${token}`, {
      body,
      query: { wait: true, thread_id: threadId },
      auth: false,
    });
  }
  getActiveThreads(guildId) {
    return this.request("GET", `/guilds/${guildId}/threads/active`);
  }
  getArchivedPublicThreads(channelId) {
    return this.request("GET", `/channels/${channelId}/threads/archived/public`, { query: { limit: 100 } });
  }
  createThread(channelId, name) {
    return this.request("POST", `/channels/${channelId}/threads`, {
      body: { name, type: 11, auto_archive_duration: 10080 },
    });
  }
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function sleep(ms, signal) {
  return new Promise((r) => {
    if (signal?.aborted) return r();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      r();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Compare Discord snowflake ids. */
export function snowflakeCmp(a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Parse a webhook URL into { id, token }. */
export function parseWebhookUrl(url) {
  const m = /\/webhooks\/(\d+)\/([\w-]+)/.exec(url);
  if (!m) throw new Error(`Invalid Discord webhook URL: ${url}`);
  return { id: m[1], token: m[2] };
}
