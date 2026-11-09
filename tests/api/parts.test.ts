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

const nowTasks = (now: any) => [
  ...now.plan.filter((p: any) => !p.done).map((p: any) => p.item.task),
  ...now.new_items.map((i: any) => i.task),
  ...now.also.map((i: any) => i.task),
];

describe("parts", () => {
  test("a parent stays out of Now while its parts are open, and comes back when they close", async () => {
    const trip = await add(alex, "Europe trip booked", { area: "travel" });
    const plan = await add(alex, "plan Jan 2–6", { parent_id: trip });
    const train = await add(alex, "book the Eurostar", { parent_id: trip });

    const part = (await alex.get(`/api/tasks/${plan}`)).task;
    expect(part.area).toBe("travel");
    const before = nowTasks(await alex.get("/api/now"));
    expect(before.map((t: any) => t.title)).not.toContain("Europe trip booked");
    expect(before.find((t: any) => t.id === train).parent_title).toBe("Europe trip booked");
    expect((await alex.get(`/api/tasks/${trip}`)).status.held).toBe("2 parts still open");

    await alex.post(`/api/tasks/${plan}/complete`);
    const { cursor } = await alex.get("/api/changes?after=latest");
    await alex.post(`/api/tasks/${train}/close`, { state: "expired", reason: "flying instead" });

    const parent = await alex.get(`/api/tasks/${trip}`);
    expect(parent.status.held).toBeNull();
    expect(parent.activity.at(-1).body).toBe(
      "All its parts are closed: is it done, or is there more to do?",
    );
    expect(parent.parts.map((k: any) => [k.title, k.state])).toEqual([
      ["plan Jan 2–6", "done"],
      ["book the Eurostar", "expired"],
    ]);
    const feed = await alex.get(`/api/changes?after=${cursor}`);
    expect(feed.events.map((e: any) => [e.type, e.task.id])).toContainEqual([
      "became_available",
      trip,
    ]);
    expect(nowTasks(await alex.get("/api/now")).map((t: any) => t.id)).toContain(trip);
  });

  test("closing a parent with open parts needs a decision about them", async () => {
    const trip = await add(alex, "Europe trip booked");
    const a = await add(alex, "plan Jan 2–6", { parent_id: trip });
    const b = await add(alex, "book the Eurostar", { parent_id: trip });

    const refused = await alex.call("POST", `/api/tasks/${trip}/complete`, {});
    expect(refused.status).toBe(400);
    expect(refused.json.message).toMatch(/2 open parts/);

    await alex.post(`/api/tasks/${b}/complete`);
    await alex.post(`/api/tasks/${trip}/complete`, { open_parts: "detach" });
    const kept = (await alex.get(`/api/tasks/${a}`)).task;
    expect([kept.state, kept.parent_id]).toEqual(["open", null]);
    expect((await alex.get(`/api/tasks/${b}`)).task.parent_id).toBe(trip);

    const party = await add(alex, "party planned");
    const cake = await add(alex, "order the cake", { parent_id: party });
    await alex.post(`/api/tasks/${party}/close`, { state: "expired", open_parts: "expire" });
    const dropped = (await alex.get(`/api/tasks/${cake}`)).task;
    expect([dropped.state, dropped.close_reason]).toEqual(["expired", "party planned was closed"]);

    const move = await add(alex, "moved house");
    const boxes = await add(alex, "pack the boxes", { parent_id: move });
    await alex.post(`/api/tasks/${move}/complete`, { open_parts: "done" });
    expect((await alex.get(`/api/tasks/${boxes}`)).task.state).toBe("done");
  });

  test("one level only, no routines, and no private part under a household parent", async () => {
    const trip = await add(alex, "Europe trip booked");
    const plan = await add(alex, "plan Jan 2–6", { parent_id: trip });
    const routine = await add(alex, "water the plants", {
      recurrence: { mode: "after_completion", every_days: 3 },
    });
    const other = await add(alex, "renovation");

    const deeper = await alex.call("POST", "/api/tasks", { title: "x", parent_id: plan });
    expect(deeper.json.message).toMatch(/parts can't have parts/);
    const parentAsPart = await alex.call("PATCH", `/api/tasks/${trip}`, { parent_id: other });
    expect(parentAsPart.json.message).toMatch(/has parts of its own/);
    const routineParent = await alex.call("POST", "/api/tasks", { title: "x", parent_id: routine });
    expect(routineParent.json.message).toMatch(/routine can't have parts/);
    const secret = await alex.call("POST", "/api/tasks", {
      title: "surprise",
      parent_id: trip,
      visibility: "private",
    });
    expect(secret.json.message).toMatch(/can't have a private part/);
    const hidePart = await alex.call("PATCH", `/api/tasks/${plan}`, { visibility: "private" });
    expect(hidePart.status).toBe(400);

    await alex.patch(`/api/tasks/${plan}`, { parent_id: null });
    expect((await alex.get(`/api/tasks/${plan}`)).task.parent_id).toBeNull();
  });

  test("a household part of a private task doesn't reveal its parent", async () => {
    const gift = await add(alex, "Sam's birthday sorted", { visibility: "private" });
    const shared = await add(alex, "book a restaurant for Saturday", {
      parent_id: gift,
      visibility: "household",
    });

    const seen = await sam.get(`/api/tasks/${shared}`);
    expect(seen.part_of).toBeNull();
    expect(JSON.stringify(seen)).not.toContain("birthday");
    const samNow = nowTasks(await sam.get("/api/now")).concat(
      (await sam.get("/api/now")).urgent?.map((i: any) => i.task) ?? [],
    );
    expect(JSON.stringify(samNow)).not.toContain("birthday");
    expect((await alex.get(`/api/tasks/${shared}`)).part_of.title).toBe("Sam's birthday sorted");
  });
});
