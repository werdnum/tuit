import { afterEach, beforeEach, expect, test } from "vitest";
import { type Api, TestServer } from "../harness/server.ts";
import { Mcp } from "./client.ts";

let server: TestServer;
let alex: Api;
let secretId: string;
let householdQueueId: string;
const sessions: Mcp[] = [];

async function session(token: string): Promise<Mcp> {
  const s = await Mcp.connect(server.url, token);
  sessions.push(s);
  return s;
}
const samsAssistant = async () => session(await server.mintToken("sam", "family-assistant"));

beforeEach(async () => {
  server = await TestServer.start();
  await server.setClock("2026-10-05T09:00:00+11:00");
  alex = await server.api("alex", "phone");
  const { task } = await alex.post("/api/tasks", {
    title: "Sam birthday: confirm ring size",
    brief: "Jeweller in Chatswood holds the ring until Friday",
    visibility: "private",
    deadline: "2026-10-06",
  });
  secretId = task.id;
  await alex.post(`/api/tasks/${secretId}/checkpoint`, {
    note: "Ring size confirmed: N",
    next_actor: "me",
  });
  await alex.post("/api/tasks", { title: "Put the bins out", next_actor: "anyone" });
  householdQueueId = (
    await alex.post("/api/queues", { name: "Everything", config: { actor: "all" } })
  ).id;
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  await server.stop();
});

const titles = (items: { task: { title: string } }[]) => items.map((i) => i.task.title);

test("another person's agent gets the same not-found for a private task as for a missing one", async () => {
  const sam = await samsAssistant();

  const secret = await sam.raw("get_task", { task_id: secretId });
  const missing = await sam.raw("get_task", { task_id: "nosuchtask" });

  expect(secret.isError).toBe(true);
  expect(JSON.stringify(secret.content)).not.toMatch(/ring|birthday/i);
  expect(JSON.parse((secret.content[0] as { text: string }).text).error).toBe(
    JSON.parse((missing.content[0] as { text: string }).text).error,
  );
});

test("another person's agent cannot find a private task by searching its notes", async () => {
  const sam = await samsAssistant();

  const found = await sam.call("find_tasks", { text: "ring size" });

  expect(found.tasks).toEqual([]);
});

test("a private urgent task does not reach another person's Now", async () => {
  const sam = await samsAssistant();

  const now = await sam.call("now");

  expect(JSON.stringify(now)).not.toContain(secretId);
  expect(titles(now.plan.map((x: { item: unknown }) => x.item))).toContain("Put the bins out");
});

test("a household queue shows another person's agent only what they may see", async () => {
  const sam = await samsAssistant();

  const run = await sam.call("run_queue", { queue_id: householdQueueId });

  expect(titles([...run.result.items, ...run.result.urgent])).toEqual(["Put the bins out"]);
});

test("the change feed omits a private task's events for another person's agent", async () => {
  const mine = await session(await server.mintToken("alex", "family-assistant"));
  const sam = await samsAssistant();

  const ownerFeed = await mine.call("get_changes");
  const otherFeed = await sam.call("get_changes");

  const about = (feed: { events: { type: string; task: { id: string } | null }[] }) =>
    feed.events.filter((e) => e.task?.id === secretId);
  expect(about(ownerFeed).map((e) => e.type)).toEqual(
    expect.arrayContaining(["created", "checkpoint"]),
  );
  expect(about(otherFeed)).toEqual([]);
  expect(JSON.stringify(otherFeed)).not.toMatch(/ring|birthday/i);
});

test("a household display credential sees household tasks but not private ones", async () => {
  const display = await session(await server.mintDisplayToken("alex"));

  const run = await display.call("run_queue", { queue_id: householdQueueId });
  const found = await display.call("find_tasks", { text: "ring" });

  expect(titles([...run.result.items, ...run.result.urgent])).toEqual(["Put the bins out"]);
  expect(found.tasks).toEqual([]);
});

test("a display credential cannot change tasks", async () => {
  const display = await session(await server.mintDisplayToken("alex"));

  const r = await display.raw("create_task", { title: "sneaky" });

  expect(r.isError).toBe(true);
  expect(JSON.stringify(r.content)).toMatch(/read-only/);
});
