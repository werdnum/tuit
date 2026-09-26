import { afterEach, beforeEach, expect, test } from "vitest";
import { type Api, TestServer } from "../harness/server.ts";
import { Mcp } from "./client.ts";

let server: TestServer;
let alex: Api;
let token: string;
const sessions: Mcp[] = [];

async function claudeSession(): Promise<Mcp> {
  const s = await Mcp.connect(server.url, token);
  sessions.push(s);
  return s;
}

const handToClaude = async (title: string): Promise<string> =>
  (await alex.post("/api/tasks", { title, next_actor: "agent:claude" })).task.id;

beforeEach(async () => {
  server = await TestServer.start();
  await server.setClock("2026-10-05T09:00:00+11:00");
  alex = await server.api("alex", "phone");
  token = await server.mintToken("alex", "claude");
});

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  await server.stop();
});

const nowIds = (now: {
  plan: { item: { task: { id: string } } }[];
  new_items: { task: { id: string } }[];
}) => [...now.plan.map((x) => x.item.task.id), ...now.new_items.map((i) => i.task.id)];

test("two sessions of one agent claiming at once get different tasks", async () => {
  const ids = [
    await handToClaude("Compare electricity plans"),
    await handToClaude("Find a piano teacher"),
  ];
  const [a, b] = [await claudeSession(), await claudeSession()];

  const [x, y] = await Promise.all([a.call("claim_next"), b.call("claim_next")]);

  expect([x.task?.id, y.task?.id].sort()).toEqual(ids.sort());
});

test("only one of two concurrent claimers gets the single available task", async () => {
  const id = await handToClaude("Compare electricity plans");
  const [a, b] = [await claudeSession(), await claudeSession()];

  const [x, y] = await Promise.all([a.call("claim_next"), b.call("claim_next")]);

  expect([x.task?.id ?? null, y.task?.id ?? null].sort()).toEqual([id, null].sort());
});

test("a lapsed claim without side effects returns to the pool", async () => {
  const id = await handToClaude("Compare electricity plans");
  const claude = await claudeSession();
  await claude.call("claim_next", { lease_minutes: 30, side_effects: false });

  await server.setClock("2026-10-05T09:31:00+11:00");

  expect((await claude.call("claim_next")).task?.id).toBe(id);
});

test("a lapsed claim with side effects is not claimable again", async () => {
  await handToClaude("Email the strata manager about the leak");
  const claude = await claudeSession();
  await claude.call("claim_next", { lease_minutes: 30, side_effects: true });

  await server.setClock("2026-10-05T09:31:00+11:00");

  expect((await claude.call("claim_next")).task).toBeNull();
});

test("a lapsed claim with side effects surfaces in the owner's Now as needing a check", async () => {
  const id = await handToClaude("Email the strata manager about the leak");
  await alex.get("/api/now"); // Alex has already looked at today's plan
  const claude = await claudeSession();
  await claude.call("claim_next", { lease_minutes: 30, side_effects: true });

  await server.setClock("2026-10-05T09:31:00+11:00");

  const now = await alex.get("/api/now");
  expect(nowIds(now)).toContain(id);
  const detail = await alex.get(`/api/tasks/${id}`);
  expect(detail.status.claim_lapsed).toBe(true);
  expect(detail.status.label).toMatch(/check before retrying/);
});

test("releasing a lapsed side-effect claim makes the task claimable again", async () => {
  const id = await handToClaude("Email the strata manager about the leak");
  const claude = await claudeSession();
  await claude.call("claim_next", { lease_minutes: 30, side_effects: true });
  await server.setClock("2026-10-05T09:31:00+11:00");

  const person = await server.human("alex");
  await person.post(`/api/tasks/${id}/release`);

  expect((await claude.call("claim_next")).task?.id).toBe(id);
});

test("another agent cannot release a claim it doesn't hold", async () => {
  const id = await handToClaude("Book the carpet cleaner");
  const claude = await claudeSession();
  await claude.call("claim_next", { lease_minutes: 30 });
  const other = await server.api("alex", "family-assistant");

  const r = await other.call("POST", `/api/tasks/${id}/release`, {});

  expect(r.status).toBe(403);
});
