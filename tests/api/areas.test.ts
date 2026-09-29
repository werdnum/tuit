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

describe("areas", () => {
  test("a #tag at either end of a capture files it in that area", async () => {
    const lead = await alex.post("/api/tasks", { title: "#Tuit fix the feed cursor" });
    const trail = await alex.post("/api/tasks", { title: "prune old backups #cluster" });
    const issue = await alex.post("/api/tasks", { title: "look at #123 before friday" });

    expect(lead.task).toMatchObject({ title: "fix the feed cursor", area: "tuit" });
    expect(trail.task).toMatchObject({ title: "prune old backups", area: "cluster" });
    expect(issue.task.title).toBe("look at #123 before friday");
    expect(issue.task.area).toBeNull();
  });

  test("an area can be set, changed and cleared, and must be one word", async () => {
    const id = await add(alex, "ring the vet", { area: "#Home" });
    expect((await alex.get(`/api/tasks/${id}`)).task.area).toBe("home");

    await alex.patch(`/api/tasks/${id}`, { area: "" });
    expect((await alex.get(`/api/tasks/${id}`)).task.area).toBeNull();

    const bad = await alex.call("PATCH", `/api/tasks/${id}`, { area: "house stuff" });
    expect(bad.status).toBe(400);
    const reserved = await alex.call("PATCH", `/api/tasks/${id}`, { area: "none" });
    expect(reserved.status).toBe(400);
  });

  test("narrowing Now to an area shows its tasks without changing the day's list", async () => {
    for (let i = 1; i <= 5; i++) await add(alex, `chore ${i}`, { area: "home" });
    await add(alex, "fix the feed cursor", { area: "tuit" });
    await add(alex, "write the area docs", { area: "tuit" });
    const all = await alex.get("/api/now");
    expect(all.areas).toEqual(["home", "tuit"]);

    const tuit = await alex.get("/api/now?area=tuit");

    expect(tuit.area).toBe("tuit");
    expect(tuit.plan).toEqual([]);
    expect(titles(tuit.also)).toEqual(["fix the feed cursor", "write the area docs"]);
    expect(planTitles(await alex.get("/api/now"))).toEqual(planTitles(all));
  });

  test("an urgent area task shows once, as urgent, not again beneath the list", async () => {
    for (let i = 1; i <= 5; i++) await add(alex, `chore ${i}`);
    await add(alex, "renew the cluster cert", { area: "cluster" });
    const id = await add(alex, "rotate the backup key", { area: "cluster" });
    await alex.get("/api/now");

    await alex.patch(`/api/tasks/${id}`, { deadline: "2026-10-06" });

    const now = await alex.get("/api/now?area=cluster");
    expect(titles(now.urgent)).toEqual(["rotate the backup key"]);
    expect(titles(now.also)).toEqual(["renew the cluster cert"]);
  });

  test("an area Sam can't see isn't offered to Sam", async () => {
    await add(alex, "birthday present", { area: "secret", visibility: "private" });
    await add(alex, "mow the lawn", { area: "home" });

    expect((await alex.get("/api/now")).areas).toEqual(["home", "secret"]);
    expect((await sam.get("/api/now")).areas).toEqual(["home"]);
  });

  test("a queue can select areas, including tasks with none, and its urgent list follows", async () => {
    await add(alex, "fix the feed cursor", { area: "tuit" });
    await add(alex, "untagged thing");
    await add(alex, "renew the cluster cert", { area: "cluster", deadline: "2026-10-06" });

    const tuit = await alex.post("/api/queues/preview", { config: { areas: ["#Tuit", "none"] } });

    expect(titles(tuit.items)).toEqual(["fix the feed cursor", "untagged thing"]);
    expect(tuit.urgent).toEqual([]);
    const untagged = await alex.get("/api/now?area=none");
    expect(
      titles([...untagged.plan.map((p: any) => p.item), ...untagged.new_items, ...untagged.also]),
    ).toEqual(["untagged thing"]);
  });
});

describe("pinning", () => {
  test("pinning moves a task to the top of today's list and says why", async () => {
    for (let i = 1; i <= 6; i++) await add(alex, `chore ${i}`);
    await alex.get("/api/now");
    const id = await add(alex, "the one that matters");

    await alex.post(`/api/tasks/${id}/pin`, { pinned: true });

    const now = await alex.get("/api/now");
    expect(now.plan[0].item.task.title).toBe("the one that matters");
    expect(now.plan[0].item.why).toBe("pinned");
    expect(titles(now.new_items)).toEqual([]);
  });

  test("a pinned task sorts first when the next day's list is made", async () => {
    for (let i = 1; i <= 6; i++) await add(alex, `chore ${i}`);
    const id = await add(alex, "the one that matters");
    await alex.post(`/api/tasks/${id}/pin`, { pinned: true });

    await server.setClock("2026-10-06T09:00:00+11:00");

    expect(planTitles(await alex.get("/api/now"))[0]).toBe("the one that matters");
  });
});
