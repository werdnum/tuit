import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type Api, TestServer } from "../harness/server.ts";
import { Mcp } from "./client.ts";

let server: TestServer;
let alex: Api;
let sam: Api;
const sessions: Mcp[] = [];

async function agentSession(user: string, agent: string): Promise<Mcp> {
  const s = await Mcp.connect(server.url, await server.mintToken(user, agent));
  sessions.push(s);
  return s;
}

beforeEach(async () => {
  server = await TestServer.start();
  await server.setClock("2026-10-05T09:00:00+11:00");
  alex = await server.api("alex", "phone");
  sam = await server.api("sam", "phone");
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  await server.stop();
});

/** Resolves with the first resources/updated notification for `uri`. */
function updated(mcp: Mcp, uri: string): Promise<void> {
  return new Promise((resolve) => {
    mcp.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      if (n.params.uri === uri) resolve();
    });
  });
}

async function readJson(mcp: Mcp, uri: string): Promise<any> {
  const r = await mcp.client.readResource({ uri });
  const first = r.contents[0];
  if (!first || !("text" in first)) throw new Error("no text content");
  return JSON.parse(first.text);
}

test("an agent waiting for work wakes when a task is handed to it", async () => {
  const claude = await agentSession("alex", "claude");
  const { task } = await alex.post("/api/tasks", { title: "Find a pool fence repairer" });
  const start = await claude.call("wait_for_events", { wait_seconds: 0 });
  expect(start.changes).toEqual([]);

  const waiting = claude.call("wait_for_events", { after: start.cursor, wait_seconds: 20 });
  await alex.post(`/api/tasks/${task.id}/handoff`, { to: "agent:claude" });
  const got = await waiting;
  expect(got.changes).toHaveLength(1);
  expect(got.changes[0]).toMatchObject({
    category: "handoff",
    task: { id: task.id, next_actor: { kind: "agent", agent: "claude" } },
    actor: { user: "alex", agent: "phone" },
    watched: ["tuit://inbox"],
  });
  expect(got.changes[0].types).toContain("handed_off");

  // The cursor moved past it: the next wait doesn't report it again.
  const again = await claude.call("wait_for_events", { after: got.cursor, wait_seconds: 0 });
  expect(again.changes).toEqual([]);
});

test("the inbox ignores other people's work and the agent's own changes, but not losing a task", async () => {
  const claude = await agentSession("alex", "claude");
  const { task: mine } = await alex.post("/api/tasks", {
    title: "Draft the council letter",
    next_actor: "agent:claude",
  });
  const { task: other } = await alex.post("/api/tasks", { title: "Water the plants" });
  const { cursor } = await claude.call("wait_for_events", { wait_seconds: 0 });

  await alex.post(`/api/tasks/${other.id}/checkpoint`, { note: "Did the front", next_actor: "me" });
  await claude.call("checkpoint", {
    task_id: mine.id,
    note: "Found the council's template",
    next_actor: "agent:claude",
  });
  const quiet = await claude.call("wait_for_events", { after: cursor, wait_seconds: 0 });
  expect(quiet.changes).toEqual([]);

  await alex.post(`/api/tasks/${mine.id}/handoff`, { to: "sam" });
  const taken = await claude.call("wait_for_events", { after: quiet.cursor, wait_seconds: 0 });
  expect(taken.changes.map((c: any) => c.task.id)).toEqual([mine.id]);
  expect(taken.changes[0].task.next_actor).toEqual({ kind: "user", user: "sam" });
});

test("watching one task, or someone else's turn", async () => {
  const claude = await agentSession("alex", "claude");
  const { task } = await alex.post("/api/tasks", { title: "Book the plumber" });
  const { cursor } = await claude.call("wait_for_events", { wait_seconds: 0 });

  await sam.post(`/api/tasks/${task.id}/checkpoint`, {
    note: "Called, no answer",
    next_actor: "sam",
  });
  const got = await claude.call("wait_for_events", {
    watch: [`tuit://tasks/${task.id}`, "tuit://inbox/sam", "tuit://inbox"],
    after: cursor,
    wait_seconds: 0,
  });
  expect(got.changes).toHaveLength(1);
  expect(got.changes[0].watched).toEqual([`tuit://tasks/${task.id}`, "tuit://inbox/sam"]);
});

test("another person's private task never reaches an agent's events", async () => {
  const claude = await agentSession("alex", "claude");
  const { cursor } = await claude.call("wait_for_events", { wait_seconds: 0 });
  const { task } = await sam.post("/api/tasks", {
    title: "Surprise party for Alex",
    visibility: "private",
    next_actor: "agent:claude",
  });
  const got = await claude.call("wait_for_events", {
    watch: ["tuit://inbox", "tuit://changes"],
    after: cursor,
    wait_seconds: 0,
  });
  expect(got.changes).toEqual([]);
  expect(got.cursor).toBe(cursor);
  expect((await readJson(claude, "tuit://inbox")).tasks).toEqual([]);
  const watchIt = await claude.raw("wait_for_events", { watch: [`tuit://tasks/${task.id}`] });
  expect(watchIt.isError).toBe(true);
  await expect(claude.client.subscribeResource({ uri: `tuit://tasks/${task.id}` })).rejects.toThrow(
    /No task/,
  );
});

test("a subscribed agent is notified on its event stream and reads its inbox", async () => {
  const claude = await agentSession("alex", "claude");
  await claude.client.subscribeResource({ uri: "tuit://inbox" });
  const notified = updated(claude, "tuit://inbox");
  const { task } = await alex.post("/api/tasks", {
    title: "Compare health insurance quotes",
    next_actor: "agent:claude",
  });
  await notified;
  const inbox = await readJson(claude, "tuit://inbox");
  expect(inbox.tasks.map((t: any) => t.id)).toEqual([task.id]);
  const one = await readJson(claude, `tuit://tasks/${task.id}`);
  expect(one.task.title).toBe("Compare health insurance quotes");
});

/** The JSON-RPC messages on a session's event stream, as raw SSE. */
async function firstMessage(res: Response): Promise<any> {
  if (!res.body) throw new Error("no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const data = /^data: (.*)$/m.exec(buffer);
      if (data?.[1]) return JSON.parse(data[1]);
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
}

test("subscriptions outlive a restart and catch up on what happened meanwhile", async () => {
  const token = await server.mintToken("alex", "claude");
  const claude = await Mcp.connect(server.url, token);
  const transport = claude.client.transport as { sessionId?: string };
  const sessionId = transport.sessionId;
  expect(sessionId).toBeTruthy();
  await claude.client.subscribeResource({ uri: "tuit://inbox" });
  await claude.close();

  await alex.post("/api/tasks", { title: "Renew the rego", next_actor: "agent:claude" });
  await server.restart();

  const open = (bearer: string) =>
    fetch(`${server.url}/mcp`, {
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: "text/event-stream",
        "mcp-session-id": sessionId as string,
      },
    });
  // A session belongs to the agent and person that started it.
  const stranger = await open(await server.mintToken("sam", "claude"));
  expect(stranger.status).toBe(404);

  const res = await open(token);
  expect(res.status).toBe(200);
  expect(await firstMessage(res)).toEqual({
    jsonrpc: "2.0",
    method: "notifications/resources/updated",
    params: { uri: "tuit://inbox" },
  });
});

test("a display token watching everything hears time-driven changes", async () => {
  const kitchen = await Mcp.connect(server.url, await server.mintDisplayToken("alex"));
  sessions.push(kitchen);
  await alex.post("/api/tasks", { title: "Put the bins out", available_from: "2026-10-06" });
  const { cursor } = await kitchen.call("wait_for_events", {
    watch: ["tuit://changes"],
    wait_seconds: 0,
  });
  await server.setClock("2026-10-06T09:00:00+11:00");
  await alex.get("/api/now");
  const got = await kitchen.call("wait_for_events", {
    watch: ["tuit://changes"],
    after: cursor,
    wait_seconds: 0,
  });
  expect(got.changes.map((c: any) => c.types)).toContainEqual(["became_available"]);
});

test("a session unused for 30 days is forgotten", async () => {
  const token = await server.mintToken("alex", "claude");
  const claude = await Mcp.connect(server.url, token);
  const sessionId = (claude.client.transport as { sessionId?: string }).sessionId as string;
  await claude.close();
  await server.setClock("2026-11-05T09:00:00+11:00");
  const res = await fetch(`${server.url}/mcp`, {
    headers: {
      authorization: `Bearer ${await server.mintToken("alex", "claude")}`,
      accept: "text/event-stream",
      "mcp-session-id": sessionId,
    },
  });
  expect(res.status).toBe(404);
});

test("same-principal conversations deliver inbox arrivals but suppress routine self-updates", async () => {
  const dot = await agentSession("alex", "chatgpt");
  const chat = await agentSession("alex", "chatgpt");
  const ownInbox = "tuit://inbox/agent:chatgpt";
  const watch = ["tuit://inbox", ownInbox, "tuit://changes", "tuit://inbox/sam"];
  let { cursor } = await dot.call("wait_for_events", { watch, wait_seconds: 0 });
  const waiting = dot.call("wait_for_events", { watch, after: cursor, wait_seconds: 20 });
  const { task } = await chat.call("create_task", {
    title: "Delegate from regular ChatGPT to dot",
    next_actor: "agent:chatgpt",
  });
  const arrived = await waiting;
  expect(arrived.changes).toHaveLength(1);
  expect(arrived.changes[0]).toMatchObject({
    types: ["created"],
    task: { id: task.id },
    watched: ["tuit://inbox", ownInbox],
  });
  cursor = arrived.cursor;
  watch.push(`tuit://tasks/${task.id}`);

  const check = async (types: string[] = []) => {
    const got = await dot.call("wait_for_events", { watch, after: cursor, wait_seconds: 0 });
    expect(got.changes).toHaveLength(types.length ? 1 : 0);
    if (types.length) {
      expect(got.changes[0].types).toEqual(types);
      expect(got.changes[0].watched).toEqual(["tuit://inbox", ownInbox]);
    }
    expect(Number(got.cursor)).toBeGreaterThanOrEqual(Number(cursor));
    cursor = got.cursor;
  };
  await check(); // No replay after creation.
  await chat.call("claim_next", { task_id: task.id, side_effects: false });
  await check();
  await chat.call("checkpoint", {
    task_id: task.id,
    note: "Still working",
    next_actor: "agent:chatgpt",
    state: "open",
  });
  await check();
  await chat.call("update_task", { task_id: task.id, brief: "A useful brief" });
  await check();

  // Explicit hand_off to the same actor is a delegation, unlike retaining it in a checkpoint.
  const handoff = { task_id: task.id, to: "agent:chatgpt", idempotency_key: "self-delegation" };
  const handed = await chat.call("hand_off", handoff);
  expect(handed.task.claim).toBeTruthy(); // A self-handoff cannot bypass another worker's claim.
  await check(["checkpoint", "handed_off"]);
  await chat.call("hand_off", handoff);
  await check(); // Idempotent retry cannot generate a second wake-up.
  await chat.call("release_claim", { task_id: task.id, claim_id: handed.task.claim.id });
  await check();

  await chat.call("hand_off", { task_id: task.id, to: "sam" });
  await check(); // Own outgoing work, including the other inbox watch, stays quiet.
  await chat.call("update_task", { task_id: task.id, next_actor: "agent:chatgpt" });
  await check(["handed_off", "updated"]);
  await chat.call("checkpoint", {
    task_id: task.id,
    note: "Waiting for a reply",
    next_actor: "agent:chatgpt",
    waiting: { kind: "reply", for: "supplier" },
  });
  await check();
  await chat.call("checkpoint", {
    task_id: task.id,
    note: "Reply arrived",
    next_actor: "agent:chatgpt",
    state: "open",
  });
  await check(["checkpoint", "state_changed"]);
  await chat.call("complete_task", { task_id: task.id });
  await check();
  await chat.call("reopen_task", { task_id: task.id });
  await check(["state_changed"]);
});

test("same-principal creation reaches an SSE inbox subscription", async () => {
  const dot = await agentSession("alex", "chatgpt");
  const chat = await agentSession("alex", "chatgpt");
  await dot.client.subscribeResource({ uri: "tuit://inbox" });
  const notified = updated(dot, "tuit://inbox");
  const { task } = await chat.call("create_task", {
    title: "Another conversation's request",
    next_actor: "agent:chatgpt",
  });
  await notified;
  expect((await readJson(dot, "tuit://inbox")).tasks.map((t: any) => t.id)).toEqual([task.id]);
});

test("time-driven readiness and claim lapse still wake the shared actor once", async () => {
  const dot = await agentSession("alex", "chatgpt");
  const chat = await agentSession("alex", "chatgpt");
  const { task } = await chat.call("create_task", {
    title: "Research tomorrow",
    next_actor: "agent:chatgpt",
    available_from: "2026-10-06",
  });
  const start = await dot.call("wait_for_events", { wait_seconds: 0 });
  await server.setClock("2026-10-06T09:00:00+11:00");
  await alex.get("/api/now"); // Reads run the time-driven sweep.
  const ready = await dot.call("wait_for_events", { after: start.cursor, wait_seconds: 0 });
  expect(ready.changes).toHaveLength(1);
  expect(ready.changes[0]).toMatchObject({ types: ["became_available"], actor: {} });
  await chat.call("claim_next", { task_id: task.id, lease_minutes: 30, side_effects: true });
  const claimed = await dot.call("wait_for_events", { after: ready.cursor, wait_seconds: 0 });
  expect(claimed.changes).toEqual([]);
  expect(Number(claimed.cursor)).toBeGreaterThan(Number(ready.cursor));
  await server.setClock("2026-10-06T09:31:00+11:00");
  await alex.get("/api/now");
  const lapsed = await dot.call("wait_for_events", { after: claimed.cursor, wait_seconds: 0 });
  expect(lapsed.changes).toHaveLength(1);
  expect(lapsed.changes[0]).toMatchObject({ types: ["claim_lapsed"], actor: {} });
  expect((await chat.call("claim_next", { task_id: task.id })).task).toBeNull();
  expect(
    (await dot.call("wait_for_events", { after: lapsed.cursor, wait_seconds: 0 })).changes,
  ).toEqual([]);
});

test("backlogged self-arrivals use their recorded destination after later reassignment", async () => {
  const dot = await agentSession("alex", "chatgpt");
  const writer = await server.api("alex", "chatgpt");
  const start = await dot.call("wait_for_events", { wait_seconds: 0 });
  const { task } = await writer.post("/api/tasks", {
    title: "Work that moves before dot reconnects",
    next_actor: "agent:chatgpt",
  });
  await server.setClock("2026-10-05T09:01:00+11:00");
  await writer.post(`/api/tasks/${task.id}/complete`);
  await server.setClock("2026-10-05T09:02:00+11:00");
  await writer.post(`/api/tasks/${task.id}/reopen`);
  await server.setClock("2026-10-05T09:03:00+11:00");
  await writer.post(`/api/tasks/${task.id}/handoff`, { to: "sam" });
  const got = await dot.call("wait_for_events", { after: start.cursor, wait_seconds: 0 });
  expect(got.changes.map((c: any) => c.types)).toEqual([["created"], ["state_changed"]]);
  expect(got.changes.every((c: any) => c.task.next_actor.user === "sam")).toBe(true);

  // Conversely, reopening for Sam must not look like an arrival for us after reassignment.
  await server.setClock("2026-10-05T09:04:00+11:00");
  await writer.post(`/api/tasks/${task.id}/complete`);
  await server.setClock("2026-10-05T09:05:00+11:00");
  await writer.post(`/api/tasks/${task.id}/reopen`);
  await server.setClock("2026-10-05T09:06:00+11:00");
  await writer.post(`/api/tasks/${task.id}/handoff`, { to: "agent:chatgpt" });
  const back = await dot.call("wait_for_events", { after: got.cursor, wait_seconds: 0 });
  expect(back.changes.map((c: any) => c.types)).toEqual([["checkpoint", "handed_off"]]);
});
