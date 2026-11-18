import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Api, TestServer } from "../harness/server.ts";

let server: TestServer;
let alex: Api;
let sam: Api;

beforeEach(async () => {
  server = await TestServer.start();
  await server.setClock("2026-10-05T14:00:00+11:00");
  alex = await server.human("alex");
  sam = await server.human("sam");
});

afterEach(async () => {
  await server.stop();
});

async function add(api: Api, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await api.post("/api/tasks", { title, ...extra })).task.id;
}

const titles = (items: any[]) => items.map((i: any) => i.task.title);
const planTitles = (now: any) => now.plan.map((p: any) => p.item.task.title);
const listed = (now: any) => [
  ...now.plan.filter((p: any) => !p.done).map((p: any) => p.item.task.title),
  ...titles(now.new_items),
  ...titles(now.also),
];
const ranked = async (api: Api) =>
  titles((await api.post("/api/queues/preview", { config: { visible_limit: 50 } })).items);
const setPriority = (api: Api, id: string, priority: string) =>
  api.post(`/api/tasks/${id}/priority`, { priority });

describe("priority bands", () => {
  test("P0 sorts before P1 and P1 before P2, whatever their dates", async () => {
    const sink = await add(alex, "sort the photo albums", { target: "2026-10-01" });
    await add(alex, "fix the gate latch");
    const top = await add(alex, "renew the passports");
    await setPriority(alex, sink, "P2");
    await setPriority(alex, top, "P0");

    expect(await ranked(alex)).toEqual([
      "renew the passports",
      "fix the gate latch",
      "sort the photo albums",
    ]);
    const why = await alex.get(`/api/tasks/${sink}/explain`);
    expect(why.ranking).toContainEqual({
      rule: "priority",
      detail: "P2: sorts after every P0 and P1 task, and is never picked for the day's plan",
    });
  });

  test("a P2 task stays on Now but is never picked for the day's plan", async () => {
    const sink = await add(alex, "sort the photo albums");
    await setPriority(alex, sink, "P2");
    await add(alex, "fix the gate latch");

    const now = await alex.get("/api/now");

    expect(planTitles(now)).toEqual(["fix the gate latch"]);
    expect(titles(now.also)).toEqual(["sort the photo albums"]);
    expect(now.also[0].priority).toBe("P2");
  });

  test("setting P2 takes a task off today's list", async () => {
    const id = await add(alex, "sort the photo albums");
    await add(alex, "fix the gate latch");
    expect(planTitles(await alex.get("/api/now"))).toContain("sort the photo albums");

    await setPriority(alex, id, "P2");

    const now = await alex.get("/api/now");
    expect(planTitles(now)).toEqual(["fix the gate latch"]);
    expect(listed(now)).toEqual(["fix the gate latch", "sort the photo albums"]);
  });

  test("a P2 task with a close deadline still shows as urgent", async () => {
    const id = await add(alex, "lodge the rates objection", { deadline: "2026-10-06" });
    await setPriority(alex, id, "P2");

    const now = await alex.get("/api/now");

    expect(titles(now.urgent)).toEqual(["lodge the rates objection"]);
  });

  test("priority is per person", async () => {
    const id = await add(alex, "book the plumber", { next_actor: "anyone" });
    await add(alex, "call the council", { next_actor: "anyone" });
    await setPriority(alex, id, "P2");

    expect(await ranked(alex)).toEqual(["call the council", "book the plumber"]);
    expect(await ranked(sam)).toEqual(["book the plumber", "call the council"]);
    expect((await sam.get(`/api/tasks/${id}`)).status.priority).toBe("P1");
  });

  test("only P0, P1 and P2 are accepted", async () => {
    const id = await add(alex, "book the plumber");
    expect((await alex.call("POST", `/api/tasks/${id}/priority`, { priority: "P3" })).status).toBe(
      400,
    );
  });

  test("the iOS pin sets P0, and unpinning only undoes a P0", async () => {
    const pinned = await add(alex, "renew the passports");
    const sunk = await add(alex, "sort the photo albums");
    await setPriority(alex, sunk, "P2");

    await alex.post(`/api/tasks/${pinned}/pin`, { pinned: true });
    const status = (await alex.get(`/api/tasks/${pinned}`)).status;
    expect(status).toMatchObject({ priority: "P0", pinned: true });

    await alex.post(`/api/tasks/${pinned}/pin`, { pinned: false });
    await alex.post(`/api/tasks/${sunk}/pin`, { pinned: false });
    expect((await alex.get(`/api/tasks/${pinned}`)).status.priority).toBe("P1");
    expect((await alex.get(`/api/tasks/${sunk}`)).status.priority).toBe("P2");
  });
});

describe("ordering", () => {
  test("a recent handoff doesn't move a task up", async () => {
    await add(sam, "clean the gutters");
    const id = await add(alex, "choose paint colour for the hall");
    await alex.post(`/api/tasks/${id}/handoff`, { to: "sam", next_action: "Decide" });

    expect(await ranked(sam)).toEqual(["clean the gutters", "choose paint colour for the hall"]);
  });

  test("a target missed more than a week ago sorts as if there were none", async () => {
    const old = await add(alex, "do the tax return", { target: "2026-09-20" });
    await add(alex, "return the library books", { target: "2026-10-03" });
    await add(alex, "service the bike", { target: "2026-10-10" });
    await add(alex, "fix the gate latch");

    expect(await ranked(alex)).toEqual([
      "return the library books",
      "service the bike",
      "do the tax return",
      "fix the gate latch",
    ]);
    const why = await alex.get(`/api/tasks/${old}/explain`);
    expect(why.ranking.find((r: any) => r.rule === "target")?.detail).toMatch(
      /missed more than 7 days ago, so it sorts as if it had none/,
    );
  });

  test("a part with no deadline is ordered and made urgent by its parent's", async () => {
    await add(alex, "fix the gate latch");
    const trip = await add(alex, "Europe trip", { deadline: "2026-12-16" });
    const meds = await add(alex, "verify medication for the trip", { parent_id: trip });
    await add(alex, "book the Eurostar", { parent_id: trip, deadline: "2027-01-02" });

    expect(await ranked(alex)).toEqual([
      "verify medication for the trip",
      "book the Eurostar",
      "fix the gate latch",
    ]);
    const why = await alex.get(`/api/tasks/${meds}/explain`);
    expect(why.ranking.find((r: any) => r.rule === "deadline")?.detail).toMatch(
      /no deadline of its own; ordered and made urgent by its parent's deadline/,
    );
    expect((await alex.get(`/api/tasks/${meds}`)).task.deadline).toBeNull();

    await server.setClock("2026-12-15T10:00:00+11:00");
    const now = await alex.get("/api/now");
    const urgent = [...now.urgent, ...now.plan.map((p: any) => p.item)].filter((i) => i.urgent);
    expect(titles(urgent)).toContain("verify medication for the trip");
    const status = (await alex.get(`/api/tasks/${meds}`)).status;
    expect(status.urgent).toMatch(/^parent's deadline/);
  });

  test("a part doesn't borrow a deadline from a parent its reader can't see", async () => {
    const trip = await add(alex, "surprise party", {
      deadline: "2026-10-06",
      visibility: "private",
    });
    const part = await add(alex, "order the cake", { parent_id: trip });
    await alex.patch(`/api/tasks/${part}`, { visibility: "household", next_actor: "sam" });

    expect((await sam.get(`/api/tasks/${part}`)).status.urgent).toBeNull();
    expect((await alex.get(`/api/tasks/${part}`)).status.urgent).toMatch(/parent's deadline/);
  });
});
