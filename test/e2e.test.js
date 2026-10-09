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

test("instructions and results remind the session to keep listening on Discord", async () => {
  const a = await connect(base, "reminded", {}, stateDir);
  try {
    assert.match(a.getInstructions(), /ask questions on Discord/);
    assert.match(a.getInstructions(), /Don't end your turn until a wait times out/);
    assert.match(await call(a, "post_message", { content: "any thoughts?" }), /then call wait_for_message/);
    fake.userSays("100", "@reminded yes");
    assert.match(await call(a, "check_inbox"), /report back with post_message, then call wait_for_message/);
    assert.match(await call(a, "wait_for_message", { timeout_seconds: 1 }), /arrived within 1s\. If your work is done, you can stop now/);
  } finally {
    await a.close();
  }
});

test("two named sessions share a channel (webhook mode)", async () => {
  const a = await connect(base, "frontend", {}, stateDir);
  const b = await connect(base, "backend", {}, stateDir);
  try {
    const tools = (await a.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, [
      "check_inbox", "enter_thread", "leave_thread", "list_sessions", "listen_to", "post_message", "read_channel", "set_name", "wait_for_message",
    ]);

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

    const [inboxA, contextA] = (await call(a, "check_inbox")).split("Also in the channel");
    assert.match(inboxA, /2 new messages/);
    assert.match(inboxA, /nice, ship it/);
    assert.match(inboxA, /lunch time/);
    assert.doesNotMatch(inboxA, /migrations/);
    assert.match(contextA, /migrations/); // the rest is shown as context
    assert.match(contextA, /just chatting/);

    const [inboxB, contextB] = (await call(b, "check_inbox")).split("Also in the channel");
    assert.match(inboxB, /migrations/);
    assert.match(inboxB, /lunch time/);
    assert.doesNotMatch(inboxB, /ship it/);
    assert.match(contextB, /ship it/);

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

test("wait_for_message caps each call at max-wait and resumes the same wait", async () => {
  const a = await connect(base, "capped", { DISCORD_MAX_WAIT: "1" }, stateDir);
  try {
    await call(a, "check_inbox");
    const t0 = Date.now();
    const first = await call(a, "wait_for_message", { timeout_seconds: 3 });
    assert.match(first, /Still waiting/);
    assert.doesNotMatch(first, /arrived within/);
    assert.ok(Date.now() - t0 < 2500);
    let res = first;
    while (/Still waiting/.test(res)) res = await call(a, "wait_for_message", { timeout_seconds: 3 });
    assert.match(res, /arrived within 3s/);
    const total = Date.now() - t0;
    assert.ok(total >= 2500 && total < 6000, `took ${total}ms`);

    setTimeout(() => fake.userSays("100", "capped: answer after a resume"), 1500);
    res = await call(a, "wait_for_message", { timeout_seconds: 10 });
    while (/Still waiting/.test(res)) res = await call(a, "wait_for_message", { timeout_seconds: 10 });
    assert.match(res, /answer after a resume/);
  } finally {
    await a.close();
  }
});

test("a cancelled wait_for_message stops reading the inbox", async () => {
  const a = await connect(base, "quitter", { DISCORD_MAX_WAIT: "0" }, stateDir);
  try {
    await call(a, "check_inbox");
    const ac = new AbortController();
    const waiting = a.callTool({ name: "wait_for_message", arguments: { timeout_seconds: 30 } }, undefined, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 500));
    ac.abort();
    await assert.rejects(waiting);
    await new Promise((r) => setTimeout(r, 300));
    fake.userSays("100", "quitter: did the abandoned wait eat this?");
    await new Promise((r) => setTimeout(r, 2500)); // a few poll intervals
    assert.match(await call(a, "check_inbox"), /did the abandoned wait eat this/);
  } finally {
    await a.close();
  }
});

test("unaddressed messages come back as context, and read_channel shows everything", async () => {
  const a = await connect(base, "ctx", { DISCORD_ALLOWED_USERS: "u1" }, stateDir);
  const b = await connect(base, "ctx-peer", {}, stateDir);
  try {
    await call(a, "check_inbox");
    await call(b, "post_message", { content: "peer chatter for nobody" });
    fake.userSays("100", "ok stop a minute", { author: { id: "u1", username: "sensei" } });
    fake.userSays("100", "stranger says hi", { author: { id: "u9", username: "stranger" } });
    fake.userSays("100", "@ctx your turn", { author: { id: "u1", username: "sensei" } });
    const inbox = await call(a, "check_inbox");
    const [addressed, context] = inbox.split("Also in the channel");
    assert.match(addressed, /1 new message for ctx/);
    assert.match(addressed, /your turn/);
    assert.match(context, /not addressed to you/);
    assert.match(context, /peer chatter for nobody/);
    assert.match(context, /ok stop a minute/);
    assert.doesNotMatch(inbox, /stranger says hi/); // not an allowed user
    assert.match(inbox, /1 other message from bots or other users/);

    const recent = await call(a, "read_channel", { limit: 3 });
    assert.match(recent, /Last 2 messages \(oldest first\)/);
    assert.ok(recent.indexOf("ok stop a minute") < recent.indexOf("your turn"));
    assert.match(recent, /— mentions you/);
    assert.doesNotMatch(recent, /stranger says hi/); // the allowlist applies here too
    assert.match(recent, /1 message from bots or other users not shown/);
    assert.match(await call(a, "check_inbox"), /No new messages/); // read_channel didn't touch the inbox
  } finally {
    await a.close();
    await b.close();
  }
});

test("listen_to limits a session to chosen people and sessions", async () => {
  const a = await connect(base, "lis", {}, stateDir);
  const joe = await connect(base, "joe", {}, stateDir);
  const bob = await connect(base, "bob", {}, stateDir);
  try {
    await call(a, "check_inbox");
    assert.match(await call(a, "listen_to", { names: ["@Joe", "sensei"] }), /listens only to: joe, sensei/);
    await call(joe, "post_message", { content: "joe here", to: "lis" });
    await call(bob, "post_message", { content: "bob here", to: "lis" });
    await call(bob, "post_message", { content: "bob chatter" });
    fake.userSays("100", "@lis from sensei", { author: { id: "u1", username: "sensei", global_name: "Sensei" } });
    fake.userSays("100", "@lis from stranger", { author: { id: "u9", username: "stranger" } });
    fake.userSays("100", "@all stranger broadcast", { author: { id: "u9", username: "stranger" } });

    const inbox = await call(a, "check_inbox");
    assert.match(inbox, /2 new messages for lis/);
    assert.match(inbox, /joe here/);
    assert.match(inbox, /from sensei/);
    assert.doesNotMatch(inbox, /bob here|bob chatter|stranger/);
    assert.match(inbox, /4 other messages from bots, or from people and sessions you aren't listening to, were not shown/);
    assert.match(inbox, /Listening only to: joe, sensei/);

    const recent = await call(a, "read_channel", { limit: 6 });
    assert.match(recent, /joe here/);
    assert.doesNotMatch(recent, /bob|stranger/);
    assert.match(recent, /4 messages from bots, or from people and sessions you aren't listening to not shown/);

    // A display name copied from someone in the filter doesn't get through.
    fake.userSays("100", "@lis impostor", { author: { id: "u8", username: "mallory", global_name: "joe" } });
    const spoof = await call(a, "check_inbox");
    assert.doesNotMatch(spoof, /impostor/);
    assert.match(spoof, /1 other message/);

    // A user id works too, and [] listens to everyone again.
    await call(a, "listen_to", { names: ["u9"] });
    fake.userSays("100", "@lis id match", { author: { id: "u9", username: "stranger" } });
    assert.match(await call(a, "check_inbox"), /id match/);
    assert.match(await call(a, "listen_to", { names: [] }), /listens to everyone/);
    await call(bob, "post_message", { content: "bob again", to: "lis" });
    const all = await call(a, "check_inbox");
    assert.match(all, /bob again/);
    assert.doesNotMatch(all, /Listening only/);
  } finally {
    await a.close();
    await joe.close();
    await bob.close();
  }
});

test("owners are always heard, and listen_to flags names it hasn't seen", async () => {
  const a = await connect(base, "own", { DISCORD_OWNER: "u7", DISCORD_ALLOWED_USERS: "u1" }, stateDir);
  try {
    await call(a, "check_inbox");
    const set = await call(a, "listen_to", { names: ["sensei", "nobody-here"] });
    assert.match(set, /always heard too/);
    assert.match(set, /No one called "nobody-here" has posted/);
    assert.doesNotMatch(set, /"sensei"/); // posted earlier in this channel
    fake.userSays("100", "@own owner speaking", { author: { id: "u7", username: "boss" } });
    const inbox = await call(a, "check_inbox");
    assert.match(inbox, /owner speaking/); // not in the filter or the allowlist, but an owner
    assert.match(inbox, /Listening only to: sensei, nobody-here, plus the owners in DISCORD_OWNER/);
  } finally {
    await a.close();
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

const threadsNamed = (name) => [...fake.channels.values()].filter((c) => c.type === 11 && c.name === name);

test("enter_thread moves a session into its own thread, and a restart resumes it", async () => {
  const a = await connect(base, "worker1", {}, stateDir);
  try {
    await call(a, "check_inbox");
    // Before entering, posts go to the main channel and thread messages aren't seen.
    await call(a, "post_message", { content: "status: before" });
    assert.equal(fake.channels.get("100").messages.at(-1).content, "status: before");

    const res = await call(a, "enter_thread");
    assert.match(res, /now in a new thread "worker1"/);
    const [thread] = threadsNamed("worker1");
    assert.ok(thread, "thread created");
    // The main channel gets a link; the thread gets no "connected" line.
    const announced = fake.channels.get("100").messages.at(-1).content;
    assert.match(announced, /worker1\*\* is now working in the thread/);
    assert.ok(announced.includes(`/${thread.id}`), "links to the thread");
    assert.equal(thread.messages.length, 0);

    await call(a, "post_message", { content: "status: started" });
    assert.equal(thread.messages.at(-1).content, "status: started");
    fake.userSays(thread.id, "no mention needed here");
    fake.userSays("100", "@worker1 from the main channel");
    const inbox = await call(a, "check_inbox");
    assert.match(inbox, /no mention needed here/);
    assert.match(inbox, /in your thread/);
    assert.match(inbox, /from the main channel/);

    // Entering the thread you're in does nothing.
    const before = thread.messages.length;
    assert.match(await call(a, "enter_thread"), /already in the thread "worker1"/);
    assert.equal(thread.messages.length, before);
  } finally {
    await a.close();
  }
  // Restarting with the same name goes back into the same thread, without a new one.
  const [thread] = threadsNamed("worker1");
  fake.userSays(thread.id, "sent while restarting");
  const again = await connect(base, "worker1", {}, stateDir);
  try {
    assert.match(await call(again, "check_inbox"), /sent while restarting/);
    await call(again, "post_message", { content: "back" });
    assert.equal(thread.messages.at(-1).content, "back");
    assert.equal(threadsNamed("worker1").length, 1);
  } finally {
    await again.close();
  }
});

test("leave_thread works even when the thread was deleted", async () => {
  const a = await connect(base, "orphan", {}, stateDir);
  try {
    await call(a, "enter_thread");
    const [thread] = threadsNamed("orphan");
    fake.channels.delete(thread.id);
    assert.match(await call(a, "leave_thread"), /left the thread "orphan"[\s\S]*Couldn't post the goodbye/);
    await call(a, "post_message", { content: "made it out" });
    assert.equal(fake.channels.get("100").messages.at(-1).content, "made it out");
    // Entering another thread from a deleted one works too.
    await call(a, "enter_thread", { name: "orphan-2" });
    fake.channels.delete(threadsNamed("orphan-2")[0].id);
    assert.match(await call(a, "enter_thread", { name: "orphan-3" }), /now in a new thread "orphan-3"/);
  } finally {
    await a.close();
  }
});

test("leave_thread returns to the main channel and stays there after a restart", async () => {
  const a = await connect(base, "leaver", {}, stateDir);
  try {
    assert.match(await call(a, "leave_thread"), /isn't in a thread/);
    await call(a, "enter_thread");
    const [thread] = threadsNamed("leaver");
    assert.match(await call(a, "leave_thread"), /left the thread "leaver"/);
    assert.match(thread.messages.at(-1).content, /has left this thread/);

    await call(a, "post_message", { content: "main again" });
    assert.equal(fake.channels.get("100").messages.at(-1).content, "main again");
    // Messages in the thread are no longer delivered, but @mentions in the channel still are.
    fake.userSays(thread.id, "anyone in here?");
    fake.userSays("100", "@leaver hello");
    const inbox = await call(a, "check_inbox");
    assert.match(inbox, /1 new message for leaver/);
    assert.match(inbox, /hello/);
    assert.doesNotMatch(inbox, /anyone in here/);
  } finally {
    await a.close();
  }
  const again = await connect(base, "leaver", {}, stateDir);
  try {
    await call(again, "post_message", { content: "still main" });
    assert.equal(fake.channels.get("100").messages.at(-1).content, "still main");
    // Entering again starts from the latest message, not the history from while it was away.
    fake.userSays(threadsNamed("leaver")[0].id, "old news");
    await call(again, "enter_thread");
    assert.match(await call(again, "check_inbox"), /No new messages/);
    assert.equal(threadsNamed("leaver").length, 1);
  } finally {
    await again.close();
  }
});

test("a shared thread only delivers messages addressed to the session", async () => {
  const a = await connect(base, "sharer1", {}, stateDir);
  const b = await connect(base, "sharer2", {}, stateDir);
  try {
    await call(a, "enter_thread", { name: "Release Prep" });
    // Names match case-insensitively, so the second session joins the same thread.
    assert.match(await call(b, "enter_thread", { name: "release prep" }), /now in the thread "Release Prep"/);
    const threads = threadsNamed("Release Prep");
    assert.equal(threads.length, 1);
    const links = fake.channels.get("100").messages.filter((m) => /sharer[12]\*\* is now working in the thread/.test(m.content));
    assert.equal(links.length, 2);
    assert.ok(links.every((m) => m.content.includes(`/${threads[0].id}`)));
    const [thread] = threads;

    const posted = await call(a, "post_message", { content: "who has the changelog?" });
    assert.equal(thread.messages.at(-1).content, "who has the changelog?");
    fake.userSays(thread.id, "thinking out loud");
    fake.userSays(thread.id, "@sharer2 you take it");
    fake.userSays(thread.id, "thanks", { message_reference: { message_id: /id (\d+)/.exec(posted)[1] } });

    const forB = await call(b, "check_inbox");
    assert.match(forB, /1 new message for sharer2/);
    assert.match(forB, /you take it/);
    assert.doesNotMatch(forB.split("Also in the channel")[0], /thinking out loud/);
    // The unaddressed message is still shown as context.
    assert.match(forB, /thinking out loud/);

    const forA = await call(a, "check_inbox");
    assert.match(forA, /1 new message for sharer1/);
    assert.match(forA, /reply to you/);
    assert.doesNotMatch(forA.split("Also in the channel")[0], /you take it/);
  } finally {
    await a.close();
    await b.close();
  }
});

test("entering another thread leaves the first one", async () => {
  const a = await connect(base, "hopper", {}, stateDir);
  try {
    await call(a, "enter_thread", { name: "topic-a" });
    const res = await call(a, "enter_thread", { name: "topic-b" });
    assert.match(res, /Left the thread "topic-a"/);
    assert.match(res, /now in a new thread "topic-b"/);
    assert.match(threadsNamed("topic-a")[0].messages.at(-1).content, /has left this thread/);
    await call(a, "post_message", { content: "in b" });
    assert.equal(threadsNamed("topic-b")[0].messages.at(-1).content, "in b");
    fake.userSays(threadsNamed("topic-a")[0].id, "@hopper still there?");
    // Not in topic-a any more, so a mention there isn't seen.
    assert.match(await call(a, "check_inbox"), /No new messages/);
  } finally {
    await a.close();
  }
});

test("read_channel where=thread needs a thread", async () => {
  const a = await connect(base, "reader", {}, stateDir);
  try {
    await assert.rejects(call(a, "read_channel", { where: "thread" }), /Not in a thread/);
    await call(a, "enter_thread");
    const [thread] = threadsNamed("reader");
    fake.userSays(thread.id, "thread chatter");
    assert.match(await call(a, "read_channel", { where: "thread" }), /thread chatter/);
    assert.doesNotMatch(await call(a, "read_channel"), /thread chatter/);
    await call(a, "leave_thread");
    await assert.rejects(call(a, "read_channel", { where: "thread" }), /Not in a thread/);
  } finally {
    await a.close();
  }
});

test("list_sessions includes sessions in active threads", async () => {
  const a = await connect(base, "lister", {}, stateDir);
  const b = await connect(base, "threaded", {}, stateDir);
  try {
    await call(b, "enter_thread");
    await call(b, "post_message", { content: "working here" });
    const list = await call(a, "list_sessions");
    assert.match(list, /threaded.*thread "threaded"/);
  } finally {
    await a.close();
    await b.close();
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

test("set_name renames a running session", async () => {
  const a = await connect(base, "unnamed-folder", {}, stateDir);
  try {
    await call(a, "check_inbox");
    fake.userSays("100", "@donnie sent before the rename");
    assert.match(await call(a, "set_name", { name: "Donnie" }), /now called Donnie \(was unnamed-folder\)/);
    assert.match(await call(a, "set_name", { name: "Donnie" }), /already called Donnie/);
    await call(a, "post_message", { content: "hi" });
    assert.equal(fake.channels.get("100").messages.at(-1).author.username, "Donnie");
    fake.userSays("100", "@unnamed-folder old name");
    fake.userSays("100", "@donnie new name");
    const inbox = await call(a, "check_inbox");
    // Unread messages to the new name count, even if sent just before the rename.
    assert.match(inbox, /2 new messages for Donnie/);
    assert.match(inbox, /before the rename/);
    assert.match(inbox, /new name/);
    // Messages to the old name are only context now.
    const [addressed, context] = inbox.split("Also in the channel");
    assert.doesNotMatch(addressed, /old name/);
    assert.match(context, /old name/);
    await assert.rejects(call(a, "set_name", { name: "!!!" }), /not a usable name/);
  } finally {
    await a.close();
  }
});

test("set_name doesn't replay messages the name already read", async () => {
  // This session starts first, so its read position is older than leo-again's below.
  const other = await connect(base, "elsewhere", {}, stateDir);
  try {
    await call(other, "check_inbox");
    const leo = await connect(base, "leo-again", {}, stateDir);
    try {
      await call(leo, "check_inbox");
      fake.userSays("100", "@leo-again first");
      assert.match(await call(leo, "check_inbox"), /first/);
    } finally {
      await leo.close();
    }
    fake.userSays("100", "@leo-again second");
    await call(other, "set_name", { name: "leo-again" });
    const inbox = await call(other, "check_inbox");
    assert.match(inbox, /second/);
    assert.doesNotMatch(inbox, /first/);
  } finally {
    await other.close();
  }
});

test("set_name moves a session in its own thread to the new name's thread", async () => {
  const a = await connect(base, "temp", {}, stateDir);
  try {
    await call(a, "enter_thread");
    await call(a, "set_name", { name: "mikey" });
    const thread = threadsNamed("mikey")[0];
    assert.ok(thread, "new thread created");
    await call(a, "post_message", { content: "renamed" });
    assert.equal(thread.messages.at(-1).content, "renamed");
    fake.userSays(thread.id, "cowabunga");
    assert.match(await call(a, "check_inbox"), /cowabunga/);
  } finally {
    await a.close();
  }
});

test("set_name leaves a shared thread alone, and a rename in the main channel stays there", async () => {
  const a = await connect(base, "shy", {}, stateDir);
  try {
    await call(a, "enter_thread", { name: "crew" });
    await call(a, "set_name", { name: "bold" });
    assert.equal(threadsNamed("bold").length, 0);
    await call(a, "post_message", { content: "still in crew" });
    assert.equal(threadsNamed("crew")[0].messages.at(-1).content, "still in crew");
    // It's a shared thread, so only a mention gets through under the new name.
    fake.userSays(threadsNamed("crew")[0].id, "unaddressed");
    fake.userSays(threadsNamed("crew")[0].id, "@bold you there");
    assert.match(await call(a, "check_inbox"), /1 new message for bold/);

    await call(a, "leave_thread");
    await call(a, "set_name", { name: "plain" });
    assert.equal(threadsNamed("plain").length, 0);
    await call(a, "post_message", { content: "in the channel" });
    assert.equal(fake.channels.get("100").messages.at(-1).content, "in the channel");
  } finally {
    await a.close();
  }
});

test("a leftover DISCORD_MODE setting is ignored", async () => {
  const a = await connect(base, "oldconfig", { DISCORD_MODE: "thread" }, stateDir);
  try {
    await call(a, "post_message", { content: "channel as usual" });
    assert.equal(fake.channels.get("100").messages.at(-1).content, "channel as usual");
    assert.equal(threadsNamed("oldconfig").length, 0);
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
