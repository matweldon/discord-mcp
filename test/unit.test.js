import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, sanitizeName } from "../src/config.js";
import { Session, splitMessage } from "../src/session.js";
import { DiscordClient } from "../src/discord.js";

const env = { DISCORD_BOT_TOKEN: "t", DISCORD_CHANNEL_ID: "100" };

test("config: flags override env, name defaults to folder", () => {
  const c = parseConfig([], env, "/work/My Project");
  assert.equal(c.name, "My-Project");
  assert.deepEqual(c.errors, []);
  const d = parseConfig(["--name", "backend", "--mode=thread"], { ...env, DISCORD_SESSION_NAME: "x" });
  assert.equal(d.name, "backend");
  assert.equal(d.mode, "thread");
});

test("config: max wait defaults to 50s and accepts 0 for no cap", () => {
  assert.equal(parseConfig([], env, "/a").maxWait, 50);
  assert.equal(parseConfig(["--max-wait", "0"], env, "/a").maxWait, 0);
  assert.equal(parseConfig([], { ...env, DISCORD_MAX_WAIT: "-1" }, "/a").errors.length, 1);
});

test("config: reports missing token/channel", () => {
  const c = parseConfig([], {}, "/a");
  assert.equal(c.errors.length, 2);
  assert.throws(() => parseConfig(["--bogus"], env));
});

test("sanitizeName strips odd characters", () => {
  assert.equal(sanitizeName("  my agent!! "), "my-agent");
});

test("splitMessage respects the limit and prefers newlines", () => {
  const text = "a".repeat(15) + "\n" + "b".repeat(15);
  assert.deepEqual(splitMessage(text, 20), ["a".repeat(15), "b".repeat(15)]);
  const long = "x".repeat(45);
  assert.deepEqual(splitMessage(long, 20).map((s) => s.length), [20, 20, 5]);
});

test("addressing rules", () => {
  const s = new Session(parseConfig(["-n", "backend"], env), new DiscordClient("t"));
  assert.ok(s.mentionsMe("hey @backend can you check"));
  assert.ok(s.mentionsMe("@Backend."));
  assert.ok(s.mentionsMe("backend: run tests"));
  assert.ok(s.mentionsMe("@all stop what you're doing"));
  assert.ok(!s.mentionsMe("@backend-2 please"));
  assert.ok(!s.mentionsMe("email me@backend.io"));
  assert.ok(!s.mentionsMe("the backend is down"));
});

test("rate limits are retried", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 });
    return new Response(JSON.stringify({ id: "1" }), { status: 200 });
  };
  const c = new DiscordClient("t", { fetch });
  assert.deepEqual(await c.getMe(), { id: "1" });
  assert.equal(calls, 2);
});
