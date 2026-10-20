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
