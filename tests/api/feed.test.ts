import { afterEach, beforeEach, expect, test } from "vitest";
import type { Api, TestServer as Server } from "../harness/server.ts";
import { TestServer } from "../harness/server.ts";
import { signIn } from "../harness/session.ts";

let server: Server;
let alex: Api;
let sam: Api;

beforeEach(async () => {
  server = await TestServer.start();
  await server.setClock("2026-10-05T09:00:00+11:00");
  alex = await server.human("alex");
  sam = await server.human("sam");
});

afterEach(async () => {
  await server.stop();
});

async function feedHtml(user: string, query = ""): Promise<string> {
  const session = await signIn(server, user);
  const res = await session.fetch(`/feed${query}`);
  expect(res.status).toBe(200);
  return res.text();
}

const entries = (html: string) =>
  [...html.matchAll(/data-entry="(\d+)"/g)].map((m) => Number(m[1]));

test("newest first, across tasks, with note text", async () => {
  const a = await alex.post("/api/tasks", { title: "Renew the car rego" });
  await sam.post("/api/tasks", { title: "Book the vet" });
  await sam.post(`/api/tasks/${a.task.id}/checkpoint`, { note: "Paid online", next_actor: "me" });

  const html = await feedHtml("alex");

  const rows = [...html.matchAll(/<li [^>]*data-entry[\s\S]*?<\/li>/g)].map((m) => m[0]);
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatch(/Renew the car rego[\s\S]*Sam[\s\S]*Paid online/);
  expect(rows[1]).toContain("Book the vet");
  expect(rows[2]).toMatch(/Renew the car rego[\s\S]*Captured/);
});

test("a task made private drops out of the other person's feed, history and all", async () => {
  const { task } = await alex.post("/api/tasks", { title: "Plan the surprise party" });
  await alex.post(`/api/tasks/${task.id}/checkpoint`, { note: "Hall booked", next_actor: "me" });
  expect(await feedHtml("sam")).toContain("Hall booked");

  await alex.call("PATCH", `/api/tasks/${task.id}`, { visibility: "private" });

  const html = await feedHtml("sam");
  expect(html).not.toMatch(/surprise party|Hall booked/);
  expect(await feedHtml("alex")).toContain("Hall booked");
});

test("filters: not me, area, and edits only on request", async () => {
  const { task } = await alex.post("/api/tasks", { title: "#home Fix the gate" });
  await alex.call("PATCH", `/api/tasks/${task.id}`, { next_action: "Buy a hinge" });
  await sam.post("/api/tasks", { title: "#cluster Upgrade k3s" });

  const notMe = await feedHtml("alex", "?who=others");
  expect(notMe).toContain("Upgrade k3s");
  expect(notMe).not.toContain("Fix the gate");

  const home = await feedHtml("alex", "?area=home");
  expect(home).toContain("Fix the gate");
  expect(home).not.toContain("Upgrade k3s");

  expect(await feedHtml("alex")).not.toContain("Changed next_action");
  expect(await feedHtml("alex", "?all=1")).toContain("Changed next_action");
});

test("pages backwards with Older", async () => {
  for (let i = 0; i < 55; i++) await alex.post("/api/tasks", { title: `Task number ${i}` });

  const first = await feedHtml("alex");
  const firstIds = entries(first);
  expect(firstIds).toHaveLength(50);
  const older = /href="(\/feed\?before=\d+)"[^>]*data-older/.exec(first)?.[1];
  expect(older).toBeDefined();

  const second = await feedHtml("alex", (older as string).slice("/feed".length));
  const secondIds = entries(second);
  expect(secondIds).toHaveLength(5);
  expect(Math.max(...secondIds)).toBeLessThan(Math.min(...firstIds));
  expect(second).not.toContain("data-older");
  expect(second).toContain("Task number 0");
});
