import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Api, ApiError, TestServer } from "../harness/server.ts";

let server: TestServer;
let alex: Api;

beforeEach(async () => {
  server = await TestServer.start();
  await server.setClock("2026-10-05T09:00:00+11:00"); // Monday morning, Sydney
  alex = await server.api("alex", "cli");
});

afterEach(async () => {
  await server.stop();
});

const titles = (items: { item?: { task: { title: string } }; task?: { title: string } }[]) =>
  items.map((i) => (i.item ?? i).task?.title);

test("a title-only capture appears in Now", async () => {
  await alex.post("/api/tasks", { title: "ring the vet about Milo's teeth" });

  const now = await alex.get("/api/now");

  expect(titles(now.plan)).toContain("ring the vet about Milo's teeth");
});

test("a one-off task expires without being done and keeps its notes", async () => {
  const { task } = await alex.post("/api/tasks", {
    title: "Check in for the Melbourne flight",
    expires: "2026-10-07T07:15:00+11:00",
  });
  await alex.post(`/api/tasks/${task.id}/checkpoint`, {
    note: "Qantas check-in opens 24h before",
    next_actor: "me",
  });

  await server.setClock("2026-10-07T08:00:00+11:00");

  const after = await alex.get(`/api/tasks/${task.id}`);
  expect(after.task.state).toBe("expired");
  expect(after.activity.map((a: { body: string }) => a.body)).toContain(
    "Qantas check-in opens 24h before",
  );
  const found = await alex.get("/api/tasks?q=melbourne");
  expect(found.tasks.map((t: { id: string }) => t.id)).toContain(task.id);
  const now = await alex.get("/api/now");
  expect(titles(now.plan)).not.toContain("Check in for the Melbourne flight");
});

test("an agent checkpoint without saying whose turn it is is refused", async () => {
  const { task } = await alex.post("/api/tasks", { title: "Find a pool fence repairer" });

  const r = await alex.call("POST", `/api/tasks/${task.id}/checkpoint`, {
    note: "Found two candidates",
  });

  expect(r.status).toBe(400);
  expect(r.json.message).toMatch(/next_actor/);
});

test("a stale revision is rejected with the current task", async () => {
  const { task } = await alex.post("/api/tasks", { title: "Renew car rego" });
  await alex.patch(`/api/tasks/${task.id}`, {
    brief: "edited on the phone",
    expected_revision: 1,
  });

  const r = await alex.call("PATCH", `/api/tasks/${task.id}`, {
    brief: "agent retry",
    expected_revision: 1,
  });

  expect(r.status).toBe(409);
  expect(r.json.current.brief).toBe("edited on the phone");
});

test("repeating an idempotency key does not apply the checkpoint twice", async () => {
  const { task } = await alex.post("/api/tasks", { title: "Book the plumber" });
  const cp = { note: "Left a voicemail", next_actor: "me", idempotency_key: "run-7-step-3" };

  await alex.post(`/api/tasks/${task.id}/checkpoint`, cp);
  await alex.post(`/api/tasks/${task.id}/checkpoint`, cp);

  const detail = await alex.get(`/api/tasks/${task.id}`);
  expect(
    detail.activity.filter((a: { body: string }) => a.body === "Left a voicemail"),
  ).toHaveLength(1);
  expect(detail.task.revision).toBe(2);
});

test("tasks and history survive a server restart", async () => {
  const { task } = await alex.post("/api/tasks", { title: "Replace the smoke alarm battery" });
  await alex.post(`/api/tasks/${task.id}/checkpoint`, {
    note: "Bought 9V batteries",
    next_actor: "me",
  });

  await server.restart();

  const detail = await alex.get(`/api/tasks/${task.id}`);
  expect(detail.activity.map((a: { body: string }) => a.body)).toContain("Bought 9V batteries");
});

describe("read-only credentials", () => {
  test("cannot mutate", async () => {
    const ro = new (alex.constructor as typeof Api)(
      server.url,
      await server.mintToken("alex", "viewer", "read"),
    );

    const r = await ro.call("POST", "/api/tasks", { title: "nope" });

    expect(r.status).toBe(403);
  });
});

test("unauthenticated API calls are refused", async () => {
  const r = await fetch(`${server.url}/api/now`);
  expect(r.status).toBe(401);
  expect(ApiError).toBeDefined();
});
