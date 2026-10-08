#!/usr/bin/env node
// Claude Code hooks for sessions connected to Discord through discord-mcp.
//
//   discord-hook.mjs stop  (Stop)        Don't stop until the session has reported on Discord
//                                         and waited for instructions with nothing arriving.
//   discord-hook.mjs ask   (PreToolUse)  Send AskUserQuestion to Discord instead of the terminal.
//
// Both do nothing in sessions that haven't used a discord tool, so they're safe to enable
// everywhere. Set DISCORD_HOOKS=off to disable them, and DISCORD_IDLE_WAIT to change the
// suggested wait (seconds, default 600).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TOOL_RE = /^mcp__.*discord.*__(post_message|check_inbox|wait_for_message|set_name|list_sessions)$/i;
const WAIT = Number(process.env.DISCORD_IDLE_WAIT) || 600;

/** Discord tool calls in the transcript, oldest first, with their results. */
export function discordCalls(transcriptPath) {
  let text;
  try {
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }
  const calls = [];
  const byId = new Map();
  for (const line of text.split("\n")) {
    if (!line.includes("tool_")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item?.type === "tool_use" && TOOL_RE.test(item.name ?? "")) {
        const call = { id: item.id, tool: TOOL_RE.exec(item.name)[1], result: null, isError: false };
        calls.push(call);
        byId.set(item.id, call);
      } else if (item?.type === "tool_result" && byId.has(item.tool_use_id)) {
        const call = byId.get(item.tool_use_id);
        call.result = resultText(item.content);
        call.isError = !!item.is_error || /^Error|not configured/.test(call.result);
      }
    }
  }
  return calls;
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? "").join("\n");
  return "";
}

export function decide(
  mode,
  input,
  stateDir = process.env.DISCORD_HOOK_STATE_DIR || path.join(os.tmpdir(), "discord-mcp-hooks")
) {
  if (process.env.DISCORD_HOOKS === "off") return null;
  const calls = discordCalls(input.transcript_path);
  if (!calls.length) return null; // not a Discord session

  if (mode === "ask") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "This session takes questions over Discord, not the terminal. Post the question with the discord " +
          "post_message tool (numbered options, and the default you'll take if there's no answer), then call " +
          `wait_for_message with timeout_seconds ${WAIT}.`,
      },
    };
  }

  if (mode === "stop") {
    const last = calls[calls.length - 1];
    // Waited and nobody replied, or Discord is failing: let the session stop.
    if (last.tool === "wait_for_message" && /arrived within/.test(last.result ?? "")) return null;
    if (last.isError) return null;
    // Asked once already and the agent didn't touch Discord since: don't trap it.
    const stateFile = path.join(stateDir, `${String(input.session_id ?? "unknown").replace(/[^\w-]/g, "")}.json`);
    let state = {};
    try {
      state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {}
    if (state.blockedAt === last.id) return null;
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ blockedAt: last.id }));
    } catch {}
    return {
      decision: "block",
      reason:
        "This session is connected to Discord. Before stopping: if you haven't reported the outcome of your " +
        "latest work there, post a short summary with post_message. Then call wait_for_message " +
        `(timeout_seconds ${WAIT}) and act on any instructions that arrive. You can stop once a wait times out ` +
        "with no messages.",
    };
  }
  return null;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {}
  const out = decide(process.argv[2], input);
  if (out) process.stdout.write(JSON.stringify(out));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("discord-hook.mjs")) {
  main().catch(() => process.exit(0)); // never break the session because of this hook
}
