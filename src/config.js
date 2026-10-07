import os from "node:os";
import path from "node:path";

const HELP = `discord-mcp — connect an agent session to a Discord channel over MCP.

Usage: discord-mcp [--name <session-name>] [--channel <id>] [--mode channel|thread]

Options (each also settable via env var):
  --name, -n       Session name shown in Discord          DISCORD_SESSION_NAME (default: current folder name)
  --channel, -c    Channel ID to connect to               DISCORD_CHANNEL_ID   (required)
  --mode, -m       "channel" or "thread"                  DISCORD_MODE         (default: channel)
  --token          Bot token (prefer the env var)         DISCORD_BOT_TOKEN    (required)
  --webhook        "auto", "off", or a webhook URL        DISCORD_WEBHOOK      (default: auto)
  --users          Comma-separated user IDs allowed       DISCORD_ALLOWED_USERS (default: anyone)
                   to message this session
  --avatar         Avatar image URL for webhook posts     DISCORD_AVATAR_URL
  --state-dir      Where inbox cursors are stored         DISCORD_STATE_DIR    (default: ~/.discord-mcp)
  --poll-interval  Seconds between polls when waiting     DISCORD_POLL_INTERVAL (default: 5)
  --help, -h       Show this help
`;

const FLAGS = {
  "--name": "name", "-n": "name",
  "--channel": "channelId", "-c": "channelId",
  "--mode": "mode", "-m": "mode",
  "--token": "token",
  "--webhook": "webhook",
  "--users": "allowedUsers",
  "--avatar": "avatarUrl",
  "--state-dir": "stateDir",
  "--poll-interval": "pollInterval",
};

export function parseConfig(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === "--help" || a === "-h") return { help: HELP };
    let value;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) {
      value = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const key = FLAGS[a];
    if (!key) throw new Error(`Unknown argument: ${a}\n\n${HELP}`);
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${a}`);
    }
    args[key] = value;
  }

  const name = sanitizeName(args.name ?? env.DISCORD_SESSION_NAME ?? path.basename(cwd));
  const token = args.token ?? env.DISCORD_BOT_TOKEN ?? env.DISCORD_TOKEN;
  const channelId = args.channelId ?? env.DISCORD_CHANNEL_ID;
  const mode = (args.mode ?? env.DISCORD_MODE ?? "channel").toLowerCase();
  const webhook = args.webhook ?? env.DISCORD_WEBHOOK ?? env.DISCORD_WEBHOOK_URL ?? "auto";
  const allowed = args.allowedUsers ?? env.DISCORD_ALLOWED_USERS ?? "";
  const pollInterval = Number(args.pollInterval ?? env.DISCORD_POLL_INTERVAL ?? 5);

  const errors = [];
  if (!token) errors.push("DISCORD_BOT_TOKEN is not set");
  if (!channelId) errors.push("DISCORD_CHANNEL_ID is not set");
  else if (!/^\d+$/.test(channelId)) errors.push(`DISCORD_CHANNEL_ID must be a numeric id, got "${channelId}"`);
  if (!["channel", "thread"].includes(mode)) errors.push(`mode must be "channel" or "thread", got "${mode}"`);
  if (!name) errors.push("session name is empty");
  if (!(pollInterval >= 1)) errors.push("poll interval must be >= 1 second");

  return {
    name,
    token,
    channelId,
    mode,
    webhook,
    allowedUsers: allowed.split(",").map((s) => s.trim()).filter(Boolean),
    avatarUrl: args.avatarUrl ?? env.DISCORD_AVATAR_URL,
    stateDir: args.stateDir ?? env.DISCORD_STATE_DIR ?? path.join(os.homedir(), ".discord-mcp"),
    pollInterval,
    errors,
  };
}

/** Names are used for addressing (@name), so keep them to a simple token. */
export function sanitizeName(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w.-]/g, "")
    .slice(0, 32);
}
