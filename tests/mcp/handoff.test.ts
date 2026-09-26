import { afterEach, beforeEach, expect, test } from "vitest";
import { type Api, TestServer } from "../harness/server.ts";
import { Mcp } from "./client.ts";

let server: TestServer;
let alex: Api;
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
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  await server.stop();
});

const nowIds = (now: {
  plan: { item: { task: { id: string } } }[];
  new_items: { task: { id: string } }[];
}) => [...now.plan.map((x) => x.item.task.id), ...now.new_items.map((i) => i.task.id)];

test("an agent prepares a decision and hands it back to the human in one checkpoint", async () => {
  const { task } = await alex.post("/api/tasks", { title: "Get the pool fence repaired" });
  await alex.post(`/api/tasks/${task.id}/handoff`, {
    to: "agent:claude",
    next_action: "Shortlist repairers who service Epping",
  });
  const claude = await agentSession("alex", "claude");
  const claimed = await claude.call("claim_next", {});
  expect(claimed.task.id).toBe(task.id);

  await claude.call("checkpoint", {
    task_id: task.id,
    kind: "research",
    note: "Two repairers service Epping; FenceCo can come Thursday",
    brief: "FenceCo: $450, Thursday. PoolSafe: $380, in two weeks.",
    next_action: "Decide: FenceCo Thursday or PoolSafe in two weeks",
    next_actor: "alex",
  });

  const now = await alex.get("/api/now");
  expect(nowIds(now)).toContain(task.id);
  expect((await claude.call("claim_next", {})).task).toBeNull();
  const agentQueue = await claude.call("preview_queue", { config: { actor: "agent:claude" } });
  expect(agentQueue.items).toHaveLength(0);
});

test("the human's decision closes the loop in the change feed", async () => {
  const { task } = await alex.post("/api/tasks", { title: "Get the pool fence repaired" });
  await alex.post(`/api/tasks/${task.id}/handoff`, { to: "agent:claude" });
  const claude = await agentSession("alex", "claude");
  await claude.call("claim_next", {});
  const { cursor } = await claude.call("get_changes", { after: "latest" });
  await claude.call("checkpoint", {
    task_id: task.id,
    note: "FenceCo can come Thursday",
    next_action: "Decide: book FenceCo?",
    next_actor: "alex",
  });

  await alex.post(`/api/tasks/${task.id}/complete`, { note: "Booked FenceCo" });

  const feed = await claude.call("get_changes", { after: cursor });
  expect(
    feed.events.map((e: { type: string; task: { id: string } }) => [e.type, e.task.id]),
  ).toEqual([
    ["checkpoint", task.id],
    ["handed_off", task.id],
    ["completed", task.id],
  ]);
});

test("a second agent in a new session continues from the brief alone", async () => {
  const { task } = await alex.post("/api/tasks", {
    title: "Organise Milo's dental cleaning",
    next_actor: "agent:claude",
  });
  const researcher = await agentSession("alex", "claude");
  await researcher.call("claim_next", {});
  await researcher.call("hand_off", {
    task_id: task.id,
    to: "agent:family-assistant",
    kind: "research",
    note: "Compared three vets",
    brief: "Epping Vet quoted $420 incl. anaesthetic; Friday mornings free. Phone 02 9876 5432.",
    next_action: "Book Epping Vet for a Friday morning and add it to the family calendar",
  });
  await researcher.close();

  const assistant = await agentSession("alex", "family-assistant");
  const picked = await assistant.call("claim_next", {});

  expect(picked.task).toMatchObject({
    id: task.id,
    brief: expect.stringContaining("02 9876 5432"),
    next_action: "Book Epping Vet for a Friday morning and add it to the family calendar",
  });
});

test("the second agent hands the task back to the human with its result", async () => {
  const { task } = await alex.post("/api/tasks", {
    title: "Organise Milo's dental cleaning",
    next_actor: "agent:claude",
  });
  const researcher = await agentSession("alex", "claude");
  await researcher.call("hand_off", {
    task_id: task.id,
    to: "agent:family-assistant",
    brief: "Epping Vet, $420, Friday mornings.",
    next_action: "Book Epping Vet",
  });
  await researcher.close();
  const assistant = await agentSession("alex", "family-assistant");
  const picked = await assistant.call("claim_next", {});

  await assistant.call("checkpoint", {
    task_id: picked.task.id,
    kind: "attempt",
    note: "Held Friday 9am at Epping Vet",
    brief: `${picked.task.brief} Provisional booking Fri 9 Oct 9am.`,
    next_action: "Decide: confirm Friday 9am (they need a yes by Wednesday)",
    next_actor: "me",
  });

  const detail = await alex.get(`/api/tasks/${task.id}`);
  expect(detail.task.next_actor).toEqual({ kind: "user", user: "alex" });
  expect(detail.task.brief).toBe(
    "Epping Vet, $420, Friday mornings. Provisional booking Fri 9 Oct 9am.",
  );
  expect(
    detail.activity
      .filter((a: { kind: string }) => a.kind !== "system" && a.kind !== "created")
      .map((a: { author: { agent: string } }) => a.author.agent),
  ).toEqual(["claude", "family-assistant"]);
});

test("repeating a checkpoint's idempotency key records it once", async () => {
  const claude = await agentSession("alex", "claude");
  const { task } = await claude.call("create_task", { title: "Book the plumber" });
  const cp = {
    task_id: task.id,
    note: "Left a voicemail",
    next_actor: "agent:claude",
    idempotency_key: "run-7-step-3",
  };

  await claude.call("checkpoint", cp);
  await claude.call("checkpoint", cp);

  const detail = await claude.call("get_task", { task_id: task.id });
  expect(
    detail.activity.filter((a: { body: string }) => a.body === "Left a voicemail"),
  ).toHaveLength(1);
  expect(detail.task.revision).toBe(2);
});
