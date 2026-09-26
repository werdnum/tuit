import { afterEach, beforeEach, expect, test } from "vitest";
import { type Api, TestServer } from "../harness/server.ts";

let server: TestServer;
let alex: Api;

beforeEach(async () => {
  server = await TestServer.start();
  await server.setClock("2026-10-05T09:00:00+11:00"); // Monday
  alex = await server.api("alex", "cli");
});

afterEach(async () => {
  await server.stop();
});

async function nowIds(): Promise<string[]> {
  const now = await alex.get("/api/now");
  return [
    ...now.plan.filter((p: { done: boolean }) => !p.done).map((p: any) => p.item.task.id),
    ...now.new_items.map((i: any) => i.task.id),
    ...now.urgent.map((i: any) => i.task.id),
  ];
}

test("'I did it yesterday' records the actual completion time and rests the routine", async () => {
  const { task } = await alex.post("/api/tasks", {
    title: "Clean the pool filter",
    recurrence: { mode: "after_completion", every_days: 14 },
  });

  const done = await alex.post(`/api/tasks/${task.id}/complete`, { at: "yesterday" });

  expect(done.task.last_done_at).toBe("2026-10-04T01:00:00.000Z"); // Sunday noon, Sydney
  expect(done.status.label).toBe("last done yesterday · every 14 days");
  expect(done.status.available).toBe(false);
});

test("after a long absence a routine is one item, not a backlog", async () => {
  const { task } = await alex.post("/api/tasks", {
    title: "Mow the lawn",
    recurrence: { mode: "after_completion", every_days: 7 },
    last_done: "2026-10-01",
  });

  await server.setClock("2026-12-20T09:00:00+11:00");

  const ids = await nowIds();
  expect(ids.filter((id) => id === task.id)).toHaveLength(1);
  const all = await alex.get("/api/tasks?q=mow");
  expect(all.tasks).toHaveLength(1);
  const detail = await alex.get(`/api/tasks/${task.id}`);
  expect(detail.status.label).toBe("last done 80 days ago · every 7 days");
});

test("a time-since-done routine stays quiet until its threshold", async () => {
  const { task } = await alex.post("/api/tasks", {
    title: "Water the fiddle-leaf fig",
    recurrence: { mode: "since_done", every_days: 10 },
    last_done: "2026-10-01",
  });

  await server.setClock("2026-10-08T09:00:00+11:00");
  expect(await nowIds()).not.toContain(task.id);

  await server.setClock("2026-10-19T09:00:00+11:00");
  const detail = await alex.get(`/api/tasks/${task.id}`);
  expect(detail.status.label).toBe("last done 18 days ago");
  expect(detail.status.available).toBe(true);
  expect(detail.status.label).not.toMatch(/overdue/);
});

test("skipping rests the routine but does not reset time since done", async () => {
  const { task } = await alex.post("/api/tasks", {
    title: "Wash the car",
    recurrence: { mode: "since_done", every_days: 14 },
    last_done: "2026-09-01",
  });

  const skipped = await alex.post(`/api/tasks/${task.id}/skip`, {});

  expect(skipped.task.last_done_at).toBe("2026-09-01T02:00:00.000Z");
  expect(skipped.status.available).toBe(false);
  expect(skipped.status.label).toBe("last done 34 days ago");
});

test("recording an older completion does not move last done backwards", async () => {
  const { task } = await alex.post("/api/tasks", {
    title: "Flea treatment for Milo",
    recurrence: { mode: "after_completion", every_days: 30 },
  });
  await alex.post(`/api/tasks/${task.id}/complete`, {});

  const r = await alex.post(`/api/tasks/${task.id}/complete`, { at: "2026-09-20" });

  expect(r.task.last_done_at).toBe("2026-10-04T22:00:00.000Z");
  const detail = await alex.get(`/api/tasks/${task.id}`);
  expect(detail.activity.filter((a: { kind: string }) => a.kind === "completion")).toHaveLength(2);
});

test("a completion in the future is refused", async () => {
  const { task } = await alex.post("/api/tasks", {
    title: "Take the bins out",
    recurrence: { mode: "after_completion", every_days: 7 },
  });

  const r = await alex.call("POST", `/api/tasks/${task.id}/complete`, { at: "tomorrow" });

  expect(r.status).toBe(400);
});

test("a routine becomes due again the configured number of days after the actual completion", async () => {
  const { task } = await alex.post("/api/tasks", {
    title: "Change the aircon filter",
    recurrence: { mode: "after_completion", every_days: 3 },
  });
  await alex.post(`/api/tasks/${task.id}/complete`, { at: "2026-10-04T08:00:00+11:00" });

  await server.setClock("2026-10-07T07:59:00+11:00");
  expect((await alex.get(`/api/tasks/${task.id}`)).status.available).toBe(false);
  await server.setClock("2026-10-07T08:01:00+11:00");
  expect((await alex.get(`/api/tasks/${task.id}`)).status.available).toBe(true);
});
