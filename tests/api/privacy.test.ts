import { afterEach, beforeEach, expect, test } from "vitest";
import { Api, TestServer } from "../harness/server.ts";

let server: TestServer;
let alex: Api;
let sam: Api;
let secretId: string;

beforeEach(async () => {
  server = await TestServer.start();
  await server.setClock("2026-10-05T09:00:00+11:00");
  alex = await server.api("alex", "cli");
  sam = await server.api("sam", "family-assistant");
  const { task } = await alex.post("/api/tasks", {
    title: "Sam Xmas — ring size confirmed",
    visibility: "private",
    deadline: "2026-10-06",
  });
  secretId = task.id;
  await alex.post(`/api/tasks/${secretId}/checkpoint`, {
    note: "Size N, per her sister",
    next_actor: "me",
  });
});

afterEach(async () => {
  await server.stop();
});

const json = (x: unknown) => JSON.stringify(x);

test("the other person cannot read a private task, and can't tell it exists", async () => {
  const hidden = await sam.call("GET", `/api/tasks/${secretId}`);
  const missing = await sam.call("GET", "/api/tasks/doesnotexist");

  expect(hidden.status).toBe(404);
  expect(hidden.json.message.replace(secretId, "X")).toBe(
    missing.json.message.replace("doesnotexist", "X"),
  );
});

test("private tasks are absent from the other person's search, lists and Now", async () => {
  const search = await sam.get("/api/tasks?q=ring");
  const list = await sam.get("/api/tasks");
  const now = await sam.get("/api/now");

  expect(json([search, list, now])).not.toMatch(/ring size|Size N/);
});

test("private tasks are absent from the other person's change feed", async () => {
  const mine = await alex.get("/api/changes");
  const theirs = await sam.get("/api/changes");

  expect(mine.events.some((e: any) => e.task?.id === secretId)).toBe(true);
  expect(theirs.events.some((e: any) => e.task?.id === secretId)).toBe(false);
  expect(json(theirs)).not.toMatch(/ring size/);
});

test("a household queue shows each viewer only what they may see", async () => {
  const q = await sam.post("/api/queues", {
    name: "Everything",
    config: { actor: "all", include_resting: true },
  });

  const asSam = await sam.get(`/api/queues/${q.id}`);
  const asAlex = await alex.get(`/api/queues/${q.id}`);

  expect(json(asSam)).not.toMatch(/ring size/);
  expect(json(asAlex)).toMatch(/ring size/);
});

test("a household display token never sees private tasks, even its issuer's", async () => {
  const display = new Api(server.url, await server.mintDisplayToken("alex"));
  await alex.post("/api/tasks", { title: "Buy milk", next_actor: "anyone" });

  const now = await display.get("/api/now");
  const feed = await display.get("/api/changes");
  const task = await display.call("GET", `/api/tasks/${secretId}`);

  expect(json(now)).toMatch(/Buy milk/);
  expect(json([now, feed])).not.toMatch(/ring size/);
  expect(task.status).toBe(404);
});

test("a display token cannot write", async () => {
  const display = new Api(server.url, await server.mintDisplayToken("alex"));

  const r = await display.call("POST", "/api/tasks", { title: "sneaky" });

  expect(r.status).toBe(403);
});

test("the other person's agent cannot mutate a private task", async () => {
  const r = await sam.call("POST", `/api/tasks/${secretId}/checkpoint`, {
    note: "hi",
    next_actor: "me",
  });

  expect(r.status).toBe(404);
});

test("a private task cannot be handed to the other person", async () => {
  const r = await alex.call("POST", `/api/tasks/${secretId}/handoff`, { to: "sam" });

  expect(r.status).toBe(400);
  expect(r.json.message).toMatch(/private/);
});

test("export contains only what the caller may see", async () => {
  const theirs = await sam.get("/api/export");
  const mine = await alex.get("/api/export");

  expect(json(theirs)).not.toMatch(/ring size|Size N/);
  expect(json(mine)).toMatch(/Size N/);
});

test("the other person's feed cursor doesn't move when only private things happen", async () => {
  const { cursor } = await sam.get("/api/changes?after=latest");
  await alex.post(`/api/tasks/${secretId}/checkpoint`, { note: "ordered it", next_actor: "me" });

  const after = await sam.get(`/api/changes?after=${cursor}`);

  expect(after).toEqual({ events: [], cursor });
});

test("a household task can't be made to wait on a private one", async () => {
  const { task } = await alex.post("/api/tasks", { title: "Plan Christmas lunch" });

  const r = await alex.call("POST", `/api/tasks/${task.id}/checkpoint`, {
    note: "after the present is sorted",
    next_actor: "me",
    waiting: { kind: "task", task_id: secretId },
  });

  expect(r.status).toBe(400);
});
