import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide } from "../plugin/hooks/discord-hook.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin", "hooks", "discord-hook.mjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-hook-test-"));
let n = 0;

/** Write a transcript from [toolName, resultText] pairs and return hook input for it. */
function session(calls) {
  const id = `s${++n}`;
  const lines = [{ type: "user", message: { role: "user", content: "do the thing" } }];
  calls.forEach(([name, result], i) => {
    lines.push({ type: "assistant", message: { content: [{ type: "tool_use", id: `t${i}`, name, input: {} }] } });
    if (result !== undefined) {
      lines.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, content: result }] } });
    }
  });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  return { session_id: id, transcript_path: file };
}
const stop = (input) => decide("stop", input, path.join(dir, "state"));

test("hooks do nothing in sessions that never used Discord", () => {
  const input = session([["Bash", "ok"], ["mcp__slack__post_message", "sent"]]);
  assert.equal(stop(input), null);
  assert.equal(decide("ask", input), null);
});

test("stop is blocked until a wait times out", () => {
  const input = session([["mcp__discord__post_message", "Posted message as leo"]]);
  assert.equal(stop(input).decision, "block");
  const done = session([
    ["mcp__discord__post_message", "Posted"],
    ["mcp__discord__wait_for_message", "No messages for leo arrived within 600s."],
  ]);
  assert.equal(stop(done), null);
});

test("stop is blocked again after acting on a received message", () => {
  const input = session([
    ["mcp__discord__wait_for_message", "1 new message for leo: ..."],
    ["Bash", "ok"],
  ]);
  assert.equal(stop(input).decision, "block");
});

test("stop gives up if the agent ignores the request", () => {
  const input = session([["mcp__discord__post_message", "Posted"]]);
  assert.equal(stop(input).decision, "block");
  assert.equal(stop(input), null); // no new Discord call since the block
});

test("stop is allowed when Discord is failing", () => {
  const input = session([["mcp__discord__post_message", "Error: Discord API POST failed (401)"]]);
  assert.equal(stop(input), null);
});

test("plugin-namespaced server names are recognised", () => {
  const input = session([["mcp__plugin_x_discord__check_inbox", "No new messages"]]);
  assert.equal(stop(input).decision, "block");
});

test("ask hook redirects AskUserQuestion to Discord", () => {
  const input = session([["mcp__discord__set_name", "now called leo"]]);
  const out = decide("ask", input);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /post_message/);
});

test("script reads hook input from stdin and prints JSON", () => {
  const input = session([["mcp__discord__post_message", "Posted"]]);
  const res = spawnSync(process.execPath, [HOOK, "stop"], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, DISCORD_HOOK_STATE_DIR: path.join(dir, "cli-state") },
  });
  assert.equal(res.status, 0);
  assert.equal(JSON.parse(res.stdout).decision, "block");
  const quiet = spawnSync(process.execPath, [HOOK, "stop"], { input: "not json", encoding: "utf8" });
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, "");
});
