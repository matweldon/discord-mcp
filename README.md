# discord-mcp

An MCP server that connects a Claude Code session (or Cursor, Codex, Claude Desktop, or any other MCP-capable agent) to a Discord channel. Each session gets its own **name**, so several sessions can share one channel. You can see who said what, address a session with `@name`, and sessions can message each other.

```
#agents
  frontend   Build is green. Should I open the PR?
  you        ↪ yes, go ahead
  you        @backend please run the migrations
  backend    @frontend migrations done
```

## Tools

| Tool | What it does |
| --- | --- |
| `post_message` | Posts to the channel as this session. Supports Discord markdown and splits long messages automatically. Optional `to` (address a session or person as `@name`) and `reply_to` (a message id). |
| `check_inbox` | Returns new messages addressed to this session since the last check. Each message is delivered once. |
| `wait_for_message` | Blocks until a message for this session arrives, or until the timeout passes (default 300s). Use it after asking a question. |
| `list_sessions` | Lists the session names that have posted recently, so you know who you can address. |

A message counts as **addressed to a session** when it:

- replies to one of that session's posts (Discord's *Reply* button),
- contains `@<name>`, or starts with `<name>:`. Plain text is fine here; it doesn't need to be a real Discord mention,
- contains `@all` or `@everyone`, or
- is posted in the session's own thread (thread mode only, see below).

## Setup

### 1. Create a Discord bot (once)

1. Go to <https://discord.com/developers/applications> and click **New Application**.
2. Under **Bot**, click **Reset Token** and copy the token. This is your `DISCORD_BOT_TOKEN`.
3. On the same page, turn on **Message Content Intent**. Without it the bot can't read what people write.
4. Under **OAuth2 → URL Generator**, tick the `bot` scope and these permissions: *View Channels, Send Messages, Read Message History, Manage Webhooks, Create Public Threads, Send Messages in Threads*. Then open the generated URL and add the bot to your server.
   Shortcut: `https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=309774584832`
5. In Discord, go to **User Settings → Advanced** and turn on **Developer Mode**. Right-click the channel you want to use and click **Copy Channel ID**. This is your `DISCORD_CHANNEL_ID`.

*Manage Webhooks* lets each session post under its own name. Without it, the bot posts every message itself, prefixed with `**[name]**`, and everything else still works.

### 2. Add it to Claude Code

Requires Node.js 18 or later. Add the server once at user scope and it's available in every project:

```sh
claude mcp add discord --scope user \
  -e DISCORD_BOT_TOKEN=your-bot-token \
  -e DISCORD_CHANNEL_ID=123456789012345678 \
  -- npx -y github:matweldon/discord-mcp
```

By default **the session name is the name of the folder** you start `claude` in, so sessions in different repos get different names automatically. To pick a name yourself:

```sh
DISCORD_SESSION_NAME=reviewer claude          # for one session
claude mcp add discord ... -- npx -y github:matweldon/discord-mcp --name reviewer   # fixed name
```

Then ask Claude things like *"post a summary to Discord when you're done"* or *"check Discord for instructions every few steps"*.

### Other tools

Any client that runs stdio MCP servers works. The generic config looks like this (Cursor `~/.cursor/mcp.json`, Claude Desktop, project `.mcp.json`):

```json
{
  "mcpServers": {
    "discord": {
      "command": "npx",
      "args": ["-y", "github:matweldon/discord-mcp", "--name", "my-agent"],
      "env": {
        "DISCORD_BOT_TOKEN": "your-bot-token",
        "DISCORD_CHANNEL_ID": "123456789012345678"
      }
    }
  }
}
```

For Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.discord]
command = "npx"
args = ["-y", "github:matweldon/discord-mcp", "--name", "codex"]
env = { DISCORD_BOT_TOKEN = "your-bot-token", DISCORD_CHANNEL_ID = "123456789012345678" }
```

Don't commit a bot token to a repository. Put it in user-level config or an environment variable instead.

## Options

| Flag | Env var | Default | |
| --- | --- | --- | --- |
| `--name`, `-n` | `DISCORD_SESSION_NAME` | folder name | Session name, used for display and `@addressing` |
| `--channel`, `-c` | `DISCORD_CHANNEL_ID` | (required) | Channel to connect to |
| `--token` | `DISCORD_BOT_TOKEN` | (required) | Bot token |
| `--mode`, `-m` | `DISCORD_MODE` | `channel` | `channel` or `thread` |
| `--webhook` | `DISCORD_WEBHOOK` | `auto` | `auto` (create or reuse a `discord-mcp` webhook), `off`, or a webhook URL |
| `--users` | `DISCORD_ALLOWED_USERS` | anyone | Comma-separated Discord user IDs whose messages are delivered |
| `--avatar` | `DISCORD_AVATAR_URL` | | Avatar image for webhook posts |
| `--state-dir` | `DISCORD_STATE_DIR` | `~/.discord-mcp` | Where read positions are stored |
| `--poll-interval` | `DISCORD_POLL_INTERVAL` | `5` | Seconds between polls in `wait_for_message` |

### Thread mode

With `--mode thread`, each session creates (or reuses) a public thread named after itself under the channel. It posts there, and **every** message in that thread goes to its inbox, so you don't need to type `@name`. Messages in the main channel that use `@name` or `@all` are still delivered too. This keeps busy multi-session setups tidy.

## How it works

- Sessions use Discord's REST API only, with no gateway connection. That's why any number of sessions can share one bot token at the same time.
- Webhook posts use the session name as the username. Replies to them are matched back to the session that posted, even after a restart.
- The read position for each session is saved in `~/.discord-mcp/<channel>-<name>.json`. When you restart a session with the same name, it picks up where it left off. A new session starts from "now" and doesn't replay old history.
- Give each concurrent session a **unique** name. Two sessions with the same name share an inbox and will take each other's messages.

## Security

Anything posted in the channel can reach your agent, and an agent may act on it. Use a private channel and consider `DISCORD_ALLOWED_USERS` to limit whose messages are delivered. Messages from other bots and from webhooks this server didn't create are always ignored.

## Development

```sh
npm install
npm test        # unit tests + end-to-end tests against a fake Discord API
```

`DISCORD_API_BASE` overrides the Discord API URL. The tests use it.
