import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { type Api, TestServer } from "../harness/server.ts";

let server: TestServer;
let alex: Api;
let sam: Api;

beforeEach(async () => {
  server = await TestServer.start();
  await server.setClock("2026-10-05T14:00:00+11:00"); // Monday afternoon
  alex = await server.human("alex");
  sam = await server.human("sam");
});

afterEach(async () => {
  await server.stop();
});

async function add(api: Api, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await api.post("/api/tasks", { title, ...extra })).task.id;
}

const planTitles = (now: any, done = false) =>
  now.plan.filter((p: any) => p.done === done).map((p: any) => p.item.task.title);
const itemTitles = (items: any[]) => items.map((i: any) => i.task.title);

describe("Now", () => {
  test("finishing shortlist items leaves them ticked instead of sliding in replacements", async () => {
    for (let i = 1; i <= 7; i++) await add(alex, `chore ${i}`);
    const first = await alex.get("/api/now");
    const shown = planTitles(first);

    for (const p of first.plan.slice(0, 3))
      await alex.post(`/api/tasks/${p.item.task.id}/complete`);

    const after = await alex.get("/api/now");
    expect(shown).toHaveLength(5);
    expect(planTitles(after, true)).toEqual(shown.slice(0, 3));
    expect(planTitles(after)).toEqual(shown.slice(3));
    expect(after.more_count).toBe(2);
  });

  test("'show more' pulls the next items into today's list", async () => {
    for (let i = 1; i <= 7; i++) await add(alex, `chore ${i}`);
    await alex.get("/api/now");

    const more = await alex.post("/api/now/more");

    expect(planTitles(more)).toHaveLength(7);
    expect(more.more_count).toBe(0);
  });

  test("something captured after the list was made shows as new, not reshuffled in", async () => {
    await add(alex, "existing");
    await alex.get("/api/now");

    await add(alex, "just thought of this");

    const now = await alex.get("/api/now");
    expect(planTitles(now)).toEqual(["existing"]);
    expect(itemTitles(now.new_items)).toEqual(["just thought of this"]);
  });

  test("'enough for now' hides the list until tomorrow but urgent things still show", async () => {
    await add(alex, "tidy the shed");
    await add(alex, "pay the council rates", { deadline: "2026-10-06" });
    await alex.get("/api/now");

    const enough = await alex.post("/api/now/enough", { on: true });

    expect(enough.enough_until).toBe("2026-10-05T17:00:00.000Z"); // 4am Tuesday, Sydney
    expect(itemTitles(enough.urgent).concat(planTitles(enough))).toContain("pay the council rates");
    await server.setClock("2026-10-06T08:00:00+11:00");
    expect((await alex.get("/api/now")).enough_until).toBeNull();
  });

  test("a snoozed task leaves my list but a snoozed deadline still shows as urgent", async () => {
    const calm = await add(alex, "sort the photo backup");
    const due = await add(alex, "submit the tax return", { deadline: "2026-10-06" });

    await alex.post(`/api/tasks/${calm}/snooze`, { until: "saturday" });
    await alex.post(`/api/tasks/${due}/snooze`, { until: "saturday" });

    const now = await alex.get("/api/now");
    expect(planTitles(now)).not.toContain("sort the photo backup");
    expect(itemTitles(now.urgent)).toContain("submit the tax return");
  });

  test("snoozing is personal: it never changes the task's dates or the other person's view", async () => {
    const id = await add(alex, "book the chimney sweep", {
      next_actor: "anyone",
      target: "2026-10-09",
    });

    await alex.post(`/api/tasks/${id}/snooze`, { until: "2026-10-20" });

    const task = (await sam.get(`/api/tasks/${id}`)).task;
    expect(task.target).toEqual({ date: "2026-10-09" });
    expect(planTitles(await sam.get("/api/now"))).toContain("book the chimney sweep");
  });

  test("a task handed to me shows up with why", async () => {
    const id = await add(alex, "choose paint colour for the hall");
    await sam.get("/api/now");

    await alex.post(`/api/tasks/${id}/handoff`, {
      to: "sam",
      next_action: "Decide: sage or white",
    });

    const now = await sam.get("/api/now");
    expect(now.new_items[0].task.title).toBe("choose paint colour for the hall");
    expect(now.new_items[0].why).toBe("handed to you just now");
  });

  test("a commitment I own stays in my urgent list while someone else holds it", async () => {
    const id = await add(alex, "get the pool fence certified", { deadline: "2026-10-06" });

    await alex.post(`/api/tasks/${id}/handoff`, {
      to: "agent:claude",
      note: "find an inspector",
    });

    expect(itemTitles((await alex.get("/api/now")).urgent)).toContain(
      "get the pool fence certified",
    );
  });

  test("after a month away: expired things are gone, commitments surface, and the list is short", async () => {
    for (let i = 1; i <= 12; i++) await add(alex, `someday ${i}`);
    await add(alex, "enter the school raffle", { expires: "2026-10-10" });
    await add(alex, "renew passport", { deadline: "2026-11-06" });
    await add(alex, "descale the kettle", {
      recurrence: { mode: "since_done", every_days: 14 },
      last_done: "2026-10-01",
    });
    await alex.get("/api/now");

    await server.setClock("2026-11-05T08:00:00+11:00");

    const now = await alex.get("/api/now");
    const everything = JSON.stringify(now);
    expect(now.plan.length).toBeLessThanOrEqual(5);
    expect(everything).not.toMatch(/school raffle/);
    expect(itemTitles(now.urgent).concat(planTitles(now))).toContain("renew passport");
    expect(now.away).toMatchObject({ expired: 1 });
    expect((await alex.get("/api/tasks?q=raffle")).tasks[0].state).toBe("expired");
  });
});

describe("waiting", () => {
  test("a reply I'm waiting for resurfaces as a chase on its follow-up date", async () => {
    const id = await add(alex, "get a quote from the tiler");
    await alex.post(`/api/tasks/${id}/checkpoint`, {
      note: "Emailed Marco",
      waiting: { kind: "reply", for: "Marco's quote", follow_up: "friday" },
    });
    expect(planTitles(await alex.get("/api/now"))).not.toContain("get a quote from the tiler");

    await server.setClock("2026-10-09T09:00:00+11:00");

    const now = await alex.get("/api/now");
    const item = now.plan.find((p: any) => p.item.task.id === id)?.item;
    expect(item.label).toBe("waiting for Marco's quote since 4 days ago — chase?");
    expect(item.task.state).toBe("waiting");
  });

  test("waiting on another task reopens when it is done", async () => {
    const blocker = await add(alex, "get the builder's report");
    const id = await add(alex, "decide on the renovation");
    await alex.post(`/api/tasks/${id}/checkpoint`, {
      note: "need the report first",
      waiting: { kind: "task", task_id: blocker },
    });

    await alex.post(`/api/tasks/${blocker}/complete`);

    const detail = await alex.get(`/api/tasks/${id}`);
    expect(detail.task.state).toBe("open");
    expect(detail.activity.at(-1).body).toBe("The task this was waiting on is done");
  });

  test("waiting on a task that gets shelved reopens with a warning, not as if it were done", async () => {
    const blocker = await add(alex, "get the builder's report");
    const id = await add(alex, "decide on the renovation");
    await alex.post(`/api/tasks/${id}/checkpoint`, {
      note: "need the report first",
      waiting: { kind: "task", task_id: blocker },
    });

    await alex.post(`/api/tasks/${blocker}/close`, {
      state: "shelved",
      reason: "builder went quiet",
    });

    const detail = await alex.get(`/api/tasks/${id}`);
    expect(detail.task.state).toBe("open");
    expect(detail.activity.at(-1).body).toMatch(/shelved, not done/);
  });

  test("waiting until a date reopens by itself and says so in the feed", async () => {
    const id = await add(alex, "plant the tomatoes");
    await alex.post(`/api/tasks/${id}/checkpoint`, {
      note: "too cold yet",
      waiting: { kind: "until", follow_up: "2026-10-20" },
    });
    const { cursor } = await alex.get("/api/changes?after=latest");

    await server.setClock("2026-10-20T07:00:00+11:00");

    const feed = await alex.get(`/api/changes?after=${cursor}`);
    expect(feed.events.map((e: any) => [e.type, e.task.id])).toContainEqual([
      "became_available",
      id,
    ]);
    expect((await alex.get(`/api/tasks/${id}`)).task.state).toBe("open");
  });
});

describe("dates", () => {
  test("a date and an instant stay distinct types", async () => {
    const r = await alex.post("/api/tasks", {
      title: "fly to Brisbane",
      deadline: "saturday",
      expires: "sat 9am",
    });

    expect(r.task.deadline).toEqual({ date: "2026-10-10" });
    expect(r.task.expires).toEqual({ at: "2026-10-09T22:00:00.000Z" });
  });

  test("a derived date follows its anchor when the anchor moves", async () => {
    const r = await alex.post("/api/tasks", {
      title: "prepare the BAS",
      deadline: "2026-10-28",
      available_rule: { anchor: "deadline", offset_days: -14 },
      target_rule: { anchor: "deadline", offset_days: -7 },
    });
    expect(r.task.available_from).toEqual({ date: "2026-10-14" });

    const moved = await alex.patch(`/api/tasks/${r.task.id}`, { deadline: "2026-11-11" });

    expect(moved.task.available_from).toEqual({ date: "2026-10-28" });
    expect(moved.task.target).toEqual({ date: "2026-11-04" });
    expect(moved.task.target_rule).toEqual({ anchor: "deadline", offset_days: -7 });
  });

  test("a task isn't in Now before it is available", async () => {
    const id = await add(alex, "book summer holiday", { available_from: "2026-10-12" });

    expect(planTitles(await alex.get("/api/now"))).not.toContain("book summer holiday");
    const why = await alex.get(`/api/tasks/${id}/explain`);
    expect(why.verdict).toBe("excluded");
    expect(why.summary).toMatch(/not available until/);
  });
});

describe("queues", () => {
  test("urgent items appear outside the visible limit", async () => {
    for (let i = 1; i <= 4; i++) await add(alex, `pinned-ish ${i}`, { target: "2026-10-01" });
    await add(alex, "lodge insurance claim", { deadline: "2026-10-06T17:00:00+11:00" });
    const q = await alex.post("/api/queues", {
      name: "Top 3",
      config: { visible_limit: 3, order: ["target", "oldest"] },
    });

    const run = await alex.get(`/api/queues/${q.id}`);

    expect(run.result.items).toHaveLength(3);
    expect(itemTitles(run.result.urgent)).toEqual(["lodge insurance claim"]);
    expect(run.result.hidden_count).toBe(2);
  });

  test("requirements filter, preferences only reorder", async () => {
    await add(alex, "wash the car", { requires: ["car"] });
    await add(alex, "read the strata minutes", { prefers: ["evening"] });
    await add(alex, "file receipts", { requires: ["computer"] });
    const q = await alex.post("/api/queues", {
      name: "At the desk",
      config: { contexts: ["computer"] },
    });

    const run = await alex.get(`/api/queues/${q.id}`);

    expect(itemTitles(run.result.items)).toEqual(["file receipts", "read the strata minutes"]);
  });

  test("a business-hours requirement is computed from the clock", async () => {
    const id = await add(alex, "call the bank", { requires: ["business_hours"] });

    await server.setClock("2026-10-05T19:30:00+11:00");

    const why = await alex.get(`/api/tasks/${id}/explain`);
    expect(why.verdict).toBe("excluded");
    expect(why.summary).toMatch(/needs business_hours/);
  });

  test("explain says when a task matches but is beyond the limit", async () => {
    for (let i = 1; i <= 3; i++) await add(alex, `thing ${i}`);
    const last = await add(alex, "thing 4");
    const q = await alex.post("/api/queues", {
      name: "Two",
      config: { visible_limit: 2, order: ["oldest"] },
    });

    const why = await alex.get(`/api/tasks/${last}/explain?queue=${q.id}`);

    expect(why.verdict).toBe("beyond_limit");
    expect(why.summary).toBe("Matches, but is number 4 and the queue shows 2");
  });

  test("preview evaluates a config without saving it", async () => {
    await add(alex, "call mum", { next_actor: "anyone" });

    const preview = await alex.post("/api/queues/preview", { config: { actor: "anyone" } });

    expect(itemTitles(preview.items)).toEqual(["call mum"]);
    expect((await alex.get("/api/queues")).queues).toHaveLength(0);
  });

  test("a disabled queue keeps its config", async () => {
    const q = await alex.post("/api/queues", {
      name: "Weekend",
      config: { contexts: ["weekend"] },
    });

    const off = await alex.patch(`/api/queues/${q.id}`, { enabled: false, expected_revision: 1 });

    expect(off.enabled).toBe(false);
    expect(off.config.contexts).toEqual(["weekend"]);
  });
});

test("an agent looking at someone's Now doesn't fix their list for the day", async () => {
  const agent = await server.api("alex", "family-assistant");
  await add(alex, "first thing");
  await agent.get("/api/now");

  await add(alex, "second thing");

  expect(planTitles(await alex.get("/api/now"))).toEqual(["first thing", "second thing"]);
});

test("a human checkpoint may leave whose turn it is unchanged", async () => {
  const id = await add(alex, "sort out the gutters");

  const r = await alex.post(`/api/tasks/${id}/checkpoint`, { note: "ladder borrowed from Sam" });

  expect(r.task.next_actor).toEqual({ kind: "user", user: "alex" });
});

test("the day's list belongs to the day until 4am", async () => {
  for (let i = 1; i <= 7; i++) await add(alex, `chore ${i}`);
  await server.setClock("2026-10-05T23:00:00+11:00");
  const evening = await alex.post("/api/now/enough", { on: true });

  await server.setClock("2026-10-06T00:30:00+11:00");

  const late = await alex.get("/api/now");
  expect(late.enough_until).toBe(evening.enough_until);
  expect(late.plan).toEqual([]);
});

test("an agent handing a person a task that waits on a reply must set a follow-up", async () => {
  const agent = await server.api("alex", "claude");
  const id = await add(alex, "get the strata quote");

  const r = await agent.call("POST", `/api/tasks/${id}/checkpoint`, {
    note: "emailed the strata manager",
    next_actor: "alex",
    waiting: { kind: "reply", for: "strata manager" },
  });

  expect(r.status).toBe(400);
  expect(r.json.message).toMatch(/follow_up/);
});

test("a resting routine can't be claimed by its agent", async () => {
  const agent = await server.api("alex", "claude");
  await add(alex, "check the bank feed", {
    next_actor: "agent:claude",
    recurrence: { mode: "after_completion", every_days: 7 },
    last_done: "2026-10-04",
  });

  const r = await agent.post("/api/claim", {});

  expect(r.task).toBeNull();
});
