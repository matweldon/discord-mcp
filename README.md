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
| `wait_for_message` | Blocks until a message for this session arrives, or until the timeout passes (default 300s). Use it after asking a question. MCP clients time tool calls out (Claude Code after 60s), so each call blocks for at most 50s (`--max-wait`) and returns "Still waiting". Calling it again with the same timeout continues the same wait. |
| `set_name` | Renames the session while it's running, for example when you tell it *"you're Donnie"*. |
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

By default **the session name is the name of the folder** you start `claude` in. The easiest way to give a session a different name is to tell it, for example *"you're Donnie on Discord"*. The agent calls `set_name` and posts and answers as `donnie` from then on. This works in any tool, including cloud sessions that share one config.

You can also set the name at launch:

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

Behind an HTTP proxy (`HTTPS_PROXY`), also set `NODE_USE_ENV_PROXY=1` in the server's env. Node's built-in `fetch` only uses the proxy when it's set, and it needs Node 22.21 or later.

### Option: let the agent install it

Instead of editing config yourself, you can ask the agent to set itself up. First, put the two values in your environment once, for example in `~/.zshrc`:

```sh
export DISCORD_BOT_TOKEN=your-bot-token
export DISCORD_CHANNEL_ID=123456789012345678
```

For cloud sessions, add them as environment variables in the cloud environment's settings instead, and allow `discord.com` in its network access.

Then paste this into any agent session (Claude Code, Codex, Cursor and so on):

> Install the Discord MCP server from https://github.com/matweldon/discord-mcp into your own user-level MCP configuration, not this repository. Name the server `discord`, and run it with `npx -y github:matweldon/discord-mcp`. Pass `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` to the server from my environment variables of the same name. Don't print the token or write it into any file in this repository. If you're Claude Code, use `claude mcp add --scope user` with `-e` for both variables. Also install the optional `discord-agent` plugin with `claude plugin marketplace add matweldon/discord-mcp` and `claude plugin install discord-agent@discord-mcp`. Then tell me whether I need to restart the session for the Discord tools to appear.

Most tools only load MCP servers when a session starts, so expect to restart once. After that, tell each new session its name ("you're Raph").

## Optional: make a session work through Discord

The MCP server gives an agent the tools. To make it actually work through Discord (ask questions there, report progress, wait for instructions instead of going quiet), add the **`discord-agent` plugin** for Claude Code. It contains:

- **A skill** (`plugin/skills/discord/SKILL.md`) that teaches the routine: say hello, check the inbox between steps, ask on Discord rather than in the terminal, post a summary at the end, then wait for more instructions.
- **Two hooks** (`plugin/hooks/`):
  - **Stop:** when the session tries to finish, it's sent back to post a summary on Discord and call `wait_for_message`. It's allowed to stop once a wait times out with no reply. This keeps the session listening for as long as you keep replying.
  - **AskUserQuestion:** questions the session would ask in the terminal are redirected to Discord.

Both hooks do nothing in a session that hasn't used a Discord tool, so the plugin is safe to leave enabled everywhere. They match any MCP server whose name contains `discord`. Set `DISCORD_HOOKS=off` to disable them for a session, and `DISCORD_IDLE_WAIT` (seconds, default `600`) to change how long the session waits before it's allowed to stop.

Choose how widely to enable it:

```sh
# Just this session (from a clone of this repo)
claude --plugin-dir /path/to/discord-mcp/plugin

# Install from GitHub, for every session or for one project
claude plugin marketplace add matweldon/discord-mcp
claude plugin install discord-agent@discord-mcp                  # all your sessions
claude plugin install discord-agent@discord-mcp --scope project  # this project only
```

**Other agents.** Hooks are specific to Claude Code, but the skill is plain Markdown. Copy the body of `plugin/skills/discord/SKILL.md` into the agent's instructions file (`AGENTS.md`, `.cursorrules` and so on) to get the same routine without the enforcement.

## Options

| Flag | Env var | Default | |
| --- | --- | --- | --- |
| `--name`, `-n` | `DISCORD_SESSION_NAME` | folder name | Session name, used for display and `@addressing` |
| `--channel`, `-c` | `DISCORD_CHANNEL_ID` | (required) | Channel to connect to |
| `--token` | `DISCORD_BOT_TOKEN` | (required) | Bot token |
| `--mode`, `-m` | `DISCORD_MODE` | `channel` | `channel` or `thread` |
| `--webhook` | `DISCORD_WEBHOOK` | `auto` | `auto` (create or reuse an `mcp-agents` webhook), `off`, or a webhook URL |
| `--users` | `DISCORD_ALLOWED_USERS` | anyone | Comma-separated Discord user IDs whose messages are delivered |
| `--avatar` | `DISCORD_AVATAR_URL` | | Avatar image for webhook posts |
| `--state-dir` | `DISCORD_STATE_DIR` | `~/.discord-mcp` | Where read positions are stored |
| `--poll-interval` | `DISCORD_POLL_INTERVAL` | `5` | Seconds between polls in `wait_for_message` |
| `--max-wait` | `DISCORD_MAX_WAIT` | `50` | Longest one `wait_for_message` call blocks, kept under the client's tool timeout. Longer waits span several calls. `0` removes the cap. |

### Thread mode

With `--mode thread`, each session creates (or reuses) a public thread named after itself under the channel. It posts there, and **every** message in that thread goes to its inbox, so you don't need to type `@name`. Messages in the main channel that use `@name` or `@all` are still delivered too. This keeps busy multi-session setups tidy.

## How it works

- Sessions use Discord's REST API only, with no gateway connection. That's why any number of sessions can share one bot token at the same time.
- Webhook posts use the session name as the username. Replies to them are matched back to the session that posted, even after a restart.
- The read position for each session is saved in `~/.discord-mcp/<channel>-<name>.json`. When you restart a session with the same name, it picks up where it left off. A new session starts from "now" and doesn't replay old history.
- Discord doesn't allow "discord" or "clyde" in webhook usernames, so a session named `discord-mcp` is displayed as `disc0rd-mcp`. You still address it as `@discord-mcp`.
- Give each concurrent session a **unique** name. Two sessions with the same name share an inbox and will take each other's messages.

## Security

Anything posted in the channel can reach your agent, and an agent may act on it. Use a private channel and consider `DISCORD_ALLOWED_USERS` to limit whose messages are delivered. Messages from other bots and from webhooks this server didn't create are always ignored.

## Development

```sh
npm install
npm test        # unit tests + end-to-end tests against a fake Discord API
```

`DISCORD_API_BASE` overrides the Discord API URL. The tests use it.
