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

  test("pinning a task finished today doesn't put it back on today's list", async () => {
    for (let i = 1; i <= 3; i++) await add(alex, `chore ${i}`);
    const id = await add(alex, "already sorted");
    await alex.get("/api/now");
    await alex.post(`/api/tasks/${id}/complete`);
    const before = planTitles(await alex.get("/api/now"));

    await alex.post(`/api/tasks/${id}/pin`, { pinned: true });

    expect(planTitles(await alex.get("/api/now"))).toEqual(before);
  });

  test("a pinned task sorts first when the next day's list is made", async () => {
    for (let i = 1; i <= 6; i++) await add(alex, `chore ${i}`);
    const id = await add(alex, "the one that matters");
    await alex.post(`/api/tasks/${id}/pin`, { pinned: true });

    await server.setClock("2026-10-06T09:00:00+11:00");

    expect(planTitles(await alex.get("/api/now"))[0]).toBe("the one that matters");
  });
});

describe("areas hidden by default", () => {
  const everything = (now: any) =>
    [...now.plan.map((p: any) => p.item), ...now.new_items, ...now.also].map(
      (i: any) => i.task.title,
    );

  test("a hidden area leaves Now and unnamed queues, and naming it brings its tasks back", async () => {
    await add(alex, "mow the lawn", { area: "home" });
    await add(alex, "bump openssl", { area: "security" });
    await add(alex, "bump zlib", { area: "security" });

    const set = await alex.patch("/api/areas/%23Security", { hidden_by_default: true });

    expect(set.area).toMatchObject({ area: "security", hidden_by_default: true });
    const now = await alex.get("/api/now");
    expect(everything(now)).toEqual(["mow the lawn"]);
    expect(now.areas).toEqual(["home", "security"]);
    expect(now.hidden_by_default).toEqual(["security"]);
    expect(now.hidden_areas).toEqual([
      { area: "security", count: 2, oldest_since: "2026-10-05T03:00:00.000Z" },
    ]);

    const named = await alex.get("/api/now?area=security");
    expect(everything(named)).toEqual(["bump openssl", "bump zlib"]);
    expect(named.area_hidden).toBe(true);
    expect(named.hidden_areas).toEqual([]);

    const unnamed = await alex.post("/api/queues/preview", { config: {} });
    expect(titles(unnamed.items)).toEqual(["mow the lawn"]);
    const listed = await alex.post("/api/queues/preview", { config: { areas: ["security"] } });
    expect(titles(listed.items)).toEqual(["bump openssl", "bump zlib"]);
  });

  test("a hidden task never joins the day's plan, so unhiding doesn't reshuffle it", async () => {
    await add(alex, "bump openssl", { area: "security" });
    await alex.patch("/api/areas/security", { hidden_by_default: true });
    for (let i = 1; i <= 6; i++) await add(alex, `chore ${i}`);

    expect(planTitles(await alex.get("/api/now"))).toEqual([
      "chore 1",
      "chore 2",
      "chore 3",
      "chore 4",
      "chore 5",
    ]);
    await alex.patch("/api/areas/security", { hidden_by_default: false });

    const now = await alex.get("/api/now");
    expect(planTitles(now)).toEqual(["chore 1", "chore 2", "chore 3", "chore 4", "chore 5"]);
    expect(titles(now.also)).toEqual(["bump openssl", "chore 6"]);
    expect(now.hidden_areas).toEqual([]);
  });

  test("an urgent task in a hidden area still shows as urgent", async () => {
    await add(alex, "patch the exposed host", { area: "security", deadline: "2026-10-06" });
    await add(alex, "bump zlib", { area: "security" });
    await alex.patch("/api/areas/security", { hidden_by_default: true });

    const now = await alex.get("/api/now");

    expect(titles(now.urgent)).toEqual(["patch the exposed host"]);
    expect(everything(now)).toEqual([]);
    const q = await alex.post("/api/queues/preview", { config: {} });
    expect(titles(q.urgent)).toEqual(["patch the exposed host"]);
  });

  test("an urgent hidden task still shows when it arrives after the plan, or is already on it", async () => {
    const early = await add(alex, "rotate the leaked key", { area: "security" });
    await alex.get("/api/now");
    await add(alex, "patch the exposed host", { area: "security", deadline: "2026-10-06" });
    await alex.patch(`/api/tasks/${early}`, { deadline: "2026-10-06" });
    await alex.patch("/api/areas/security", { hidden_by_default: true });

    const now = await alex.get("/api/now");

    expect(titles(now.urgent).sort()).toEqual(["patch the exposed host", "rotate the leaked key"]);
    expect(everything(now)).toEqual([]);
  });

  test("explain says the area is hidden", async () => {
    const id = await add(alex, "bump openssl", { area: "security" });
    await alex.patch("/api/areas/security", { hidden_by_default: true });

    const why = await alex.get(`/api/tasks/${id}/explain`);

    expect(why.verdict).toBe("excluded");
    expect(why.summary).toMatch(/area hidden by default/);
    expect(why.checks).toContainEqual(expect.objectContaining({ check: "area_hidden", ok: false }));
  });

  test("hiding changes nothing for agents: their queues and claims work as before", async () => {
    const agent = await server.api("alex", "claude");
    await add(alex, "bump openssl", { area: "security", next_actor: "agent:claude" });
    await alex.patch("/api/areas/security", { hidden_by_default: true });

    const inbox = await alex.post("/api/queues/preview", { config: { actor: "agent:claude" } });
    expect(titles(inbox.items)).toEqual(["bump openssl"]);
    const claimed = await agent.post("/api/claim", {});
    expect(claimed.task.title).toBe("bump openssl");
  });

  test("settings list only areas the caller can see, and need a writer", async () => {
    await add(alex, "birthday present", { area: "secret", visibility: "private" });
    await alex.patch("/api/areas/secret", { hidden_by_default: true });
    await alex.patch("/api/areas/security", { hidden_by_default: true });

    expect((await alex.get("/api/areas")).areas.map((a: any) => a.area)).toEqual([
      "secret",
      "security",
    ]);
    expect((await sam.get("/api/areas")).areas.map((a: any) => a.area)).toEqual(["security"]);
    expect((await alex.call("PATCH", "/api/areas/none", { hidden_by_default: true })).status).toBe(
      400,
    );
  });
});
