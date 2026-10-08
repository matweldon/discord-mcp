import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createFakeDiscord } from "./fake-discord.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");

async function connect(base, name, extraEnv = {}, stateDir) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, "--name", name],
    env: {
      PATH: process.env.PATH,
      DISCORD_API_BASE: base,
      DISCORD_BOT_TOKEN: "test-token",
      DISCORD_CHANNEL_ID: "100",
      DISCORD_STATE_DIR: stateDir,
      DISCORD_POLL_INTERVAL: "1",
      ...extraEnv,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.map((c) => c.text).join("\n");
  if (res.isError) throw new Error(text);
  return text;
};

let fake, base, stateDir;
before(async () => {
  fake = createFakeDiscord();
  base = await fake.listen();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-mcp-test-"));
});
after(async () => {
  await fake.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("two named sessions share a channel (webhook mode)", async () => {
  const a = await connect(base, "frontend", {}, stateDir);
  const b = await connect(base, "backend", {}, stateDir);
  try {
    const tools = (await a.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["check_inbox", "list_sessions", "post_message", "wait_for_message"]);

    assert.match(await call(a, "check_inbox"), /No new messages/);
    assert.match(await call(b, "check_inbox"), /No new messages/);

    const posted = await call(a, "post_message", { content: "Build is green" });
    const postedId = /id (\d+)/.exec(posted)[1];
    const msg = fake.channels.get("100").messages.at(-1);
    assert.equal(msg.author.username, "frontend");
    assert.ok(msg.webhook_id);

    // A human replies to frontend, addresses backend, and broadcasts.
    fake.userSays("100", "nice, ship it", { message_reference: { message_id: postedId } });
    fake.userSays("100", "@backend please run migrations");
    fake.userSays("100", "@all lunch time");
    fake.userSays("100", "just chatting");

    const inboxA = await call(a, "check_inbox");
    assert.match(inboxA, /2 new messages/);
    assert.match(inboxA, /nice, ship it/);
    assert.match(inboxA, /lunch time/);
    assert.doesNotMatch(inboxA, /migrations/);
    assert.match(inboxA, /2 other messages/);

    const inboxB = await call(b, "check_inbox");
    assert.match(inboxB, /migrations/);
    assert.match(inboxB, /lunch time/);
    assert.doesNotMatch(inboxB, /ship it/);

    // Messages are delivered once.
    assert.match(await call(a, "check_inbox"), /No new messages/);

    // Session-to-session messaging.
    await call(b, "post_message", { content: "migrations done", to: "frontend" });
    const fromB = await call(a, "check_inbox");
    assert.match(fromB, /from backend \(session\)/);
    assert.match(fromB, /@frontend migrations done/);
    assert.match(await call(b, "check_inbox"), /No new messages/); // doesn't see its own post

    const sessions = await call(a, "list_sessions");
    assert.match(sessions, /frontend \(you\)/);
    assert.match(sessions, /backend/);
  } finally {
    await a.close();
    await b.close();
  }
});

test("wait_for_message returns once a message arrives", async () => {
  const a = await connect(base, "waiter", {}, stateDir);
  try {
    await call(a, "check_inbox");
    setTimeout(() => fake.userSays("100", "waiter: here is your answer"), 1500);
    const t0 = Date.now();
    const res = await call(a, "wait_for_message", { timeout_seconds: 20 });
    assert.match(res, /here is your answer/);
    assert.ok(Date.now() - t0 < 10000);
    assert.match(await call(a, "wait_for_message", { timeout_seconds: 1 }), /arrived within 1s/);
  } finally {
    await a.close();
  }
});

test("inbox cursor survives a restart", async () => {
  let a = await connect(base, "persist", {}, stateDir);
  await call(a, "check_inbox");
  await a.close();
  fake.userSays("100", "@persist while you were away");
  a = await connect(base, "persist", {}, stateDir);
  try {
    assert.match(await call(a, "check_inbox"), /while you were away/);
  } finally {
    await a.close();
  }
});

test("thread mode gives each session its own thread", async () => {
  const a = await connect(base, "worker1", { DISCORD_MODE: "thread" }, stateDir);
  try {
    await call(a, "check_inbox");
    const thread = [...fake.channels.values()].find((c) => c.name === "worker1");
    assert.ok(thread, "thread created");
    await call(a, "post_message", { content: "status: started" });
    assert.equal(thread.messages.at(-1).content, "status: started");
    fake.userSays(thread.id, "no mention needed here");
    fake.userSays("100", "@worker1 from the main channel");
    const inbox = await call(a, "check_inbox");
    assert.match(inbox, /no mention needed here/);
    assert.match(inbox, /from the main channel/);
  } finally {
    await a.close();
  }
  // Reconnecting reuses the same thread.
  const again = await connect(base, "worker1", { DISCORD_MODE: "thread" }, stateDir);
  try {
    await call(again, "check_inbox");
    assert.equal([...fake.channels.values()].filter((c) => c.name === "worker1").length, 1);
  } finally {
    await again.close();
  }
});

test("falls back to bot posts with a name prefix without Manage Webhooks", async () => {
  const f = createFakeDiscord({ manageWebhooks: false });
  const url = await f.listen();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-mcp-test-"));
  const a = await connect(url, "plain", {}, dir);
  try {
    const res = await call(a, "post_message", { content: "hello" });
    assert.match(res, /Manage Webhooks/);
    const msg = f.channels.get("100").messages.at(-1);
    assert.equal(msg.content, "**[plain]** hello");
    f.userSays("100", "reply!", { message_reference: { message_id: msg.id } });
    const inbox = await call(a, "check_inbox");
    assert.match(inbox, /reply to you/);
  } finally {
    await a.close();
    await f.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("session names containing forbidden words still post via webhook", async () => {
  const a = await connect(base, "discord-mcp", {}, stateDir);
  try {
    const res = await call(a, "post_message", { content: "hi" });
    assert.doesNotMatch(res, /Could not use a webhook/);
    const msg = fake.channels.get("100").messages.at(-1);
    assert.equal(msg.author.username, "disc0rd-mcp");
    fake.userSays("100", "thanks", { message_reference: { message_id: msg.id } });
    fake.userSays("100", "@discord-mcp ping");
    const inbox = await call(a, "check_inbox");
    assert.match(inbox, /2 new messages/);
  } finally {
    await a.close();
  }
});

test("missing configuration is reported, not crashed on", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { PATH: process.env.PATH },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: "check_inbox", arguments: {} });
    assert.ok(res.isError);
    assert.match(res.content[0].text, /DISCORD_BOT_TOKEN/);
  } finally {
    await client.close();
  }
});
