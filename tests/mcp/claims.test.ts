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

test("a conversation that didn't get the claim can't release the one that did", async () => {
  const id = await handToClaude("Compare electricity plans");
  const [holder, bystander] = [await claudeSession(), await claudeSession()];
  const claimed = await holder.call("claim_next");
  expect((await bystander.call("claim_next")).task).toBeNull();

  await expect(
    bystander.call("checkpoint", {
      task_id: id,
      note: "Nothing to claim, letting go",
      next_actor: "agent:claude",
      release_claim: true,
    }),
  ).rejects.toThrow(/claimed by agent:claude/);
  await expect(bystander.call("release_claim", { task_id: id })).rejects.toThrow(/claim_id/);

  expect((await alex.get(`/api/tasks/${id}`)).task.claim.id).toBe(claimed.task.claim.id);
});

test("the claimer moves its task on by passing its claim id", async () => {
  const id = await handToClaude("Compare electricity plans");
  const claude = await claudeSession();
  const claim_id = (await claude.call("claim_next")).task.claim.id;
  const step = { task_id: id, note: "Found three plans", next_actor: "agent:claude" };

  await expect(claude.call("checkpoint", step)).rejects.toThrow(/Pass claim_id/);
  await expect(claude.call("complete_task", { task_id: id })).rejects.toThrow(/Pass claim_id/);
  await claude.call("checkpoint", { ...step, claim_id });
  const done = await claude.call("complete_task", { task_id: id, claim_id });

  expect(done.task.state).toBe("done");
});

test("a claim id from a lapsed claim can't touch the claim that replaced it", async () => {
  const id = await handToClaude("Compare electricity plans");
  const [first, second] = [await claudeSession(), await claudeSession()];
  const old = (await first.call("claim_next", { lease_minutes: 30, side_effects: false })).task
    .claim.id;
  await server.setClock("2026-10-05T09:31:00+11:00");
  const current = (await second.call("claim_next")).task.claim.id;

  await expect(
    first.call("checkpoint", {
      task_id: id,
      claim_id: old,
      note: "Late result",
      next_actor: "alex",
    }),
  ).rejects.toThrow(/held by a different claim/);
  // A retried release with the old id leaves the newer claim in place.
  await first.call("release_claim", { task_id: id, claim_id: old });

  expect((await alex.get(`/api/tasks/${id}`)).task.claim.id).toBe(current);
});

test("an agent's release with its own claim id frees the task", async () => {
  const id = await handToClaude("Compare electricity plans");
  const claude = await claudeSession();
  const claim_id = (await claude.call("claim_next")).task.claim.id;

  const released = await claude.call("release_claim", { task_id: id, claim_id });

  expect(released.task.claim).toBeFalsy();
  expect((await claude.call("claim_next")).task?.id).toBe(id);
});

test("a person changes a claimed task without the claim id", async () => {
  const id = await handToClaude("Compare electricity plans");
  const claude = await claudeSession();
  await claude.call("claim_next");
  const person = await server.human("alex");

  await person.post(`/api/tasks/${id}/checkpoint`, { note: "I'll take it from here" });
  const done = await person.post(`/api/tasks/${id}/complete`, {});

  expect(done.task.state).toBe("done");
});

test("an agent can create a task already claimed, so no other session takes it", async () => {
  const [a, b] = [await claudeSession(), await claudeSession()];
  const { task } = await a.call("create_task", {
    title: "Research piano teachers now",
    next_actor: "agent:claude",
    claim: { lease_minutes: 60, side_effects: false },
  });
  expect(task.claim).toMatchObject({ agent: "claude", side_effects: false });

  expect((await b.call("claim_next")).task).toBeNull();
  await a.call("checkpoint", {
    task_id: task.id,
    claim_id: task.claim.id,
    note: "Done the research",
    next_actor: "me",
  });
});

test("claiming on create needs the agent itself as next_actor", async () => {
  const claude = await claudeSession();
  await expect(
    claude.call("create_task", { title: "Book the plumber", claim: {} }),
  ).rejects.toThrow(/claim only applies/);
  await expect(
    alex.post("/api/tasks", { title: "Book the plumber", next_actor: "agent:claude", claim: {} }),
  ).rejects.toThrow();
});
