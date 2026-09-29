import { afterEach, beforeEach, expect, test } from "vitest";
import { type Api, TestServer } from "../harness/server.ts";
import { Mcp } from "./client.ts";

let server: TestServer;
let alex: Api;
let claude: Mcp;

beforeEach(async () => {
  server = await TestServer.start();
  await server.setClock("2026-10-05T09:00:00+11:00");
  alex = await server.human("alex");
  claude = await Mcp.connect(server.url, await server.mintToken("alex", "claude"));
});

afterEach(async () => {
  await claude.close();
  await server.stop();
});

test("an agent files, finds and narrows Now by area", async () => {
  await claude.call("create_task", { title: "fix the feed cursor #tuit" });
  await claude.call("create_task", { title: "prune old backups", area: "cluster" });
  await claude.call("create_task", { title: "ring the vet" });

  const found = await claude.call("find_tasks", { area: "tuit" });
  const untagged = await claude.call("find_tasks", { area: "none" });
  const now = await claude.call("now", { area: "cluster" });

  expect(found.tasks.map((t: any) => t.title)).toEqual(["fix the feed cursor"]);
  const searched = await claude.call("find_tasks", { text: "the", area: "tuit", limit: 1 });
  expect(searched.tasks.map((t: any) => t.title)).toEqual(["fix the feed cursor"]);
  expect(untagged.tasks.map((t: any) => t.title)).toEqual(["ring the vet"]);
  expect(now.areas).toEqual(["cluster", "tuit"]);
  expect(
    [...now.plan.map((p: any) => p.item), ...now.new_items, ...now.also].map(
      (i: any) => i.task.title,
    ),
  ).toEqual(["prune old backups"]);
});

test("an agent pins what the person says matters, and it tops their list", async () => {
  for (let i = 1; i <= 6; i++) await alex.post("/api/tasks", { title: `chore ${i}` });
  await alex.get("/api/now");
  const late = (await alex.post("/api/tasks", { title: "the one that matters" })).task.id;

  const pinned = await claude.call("pin_task", { task_id: late });

  expect(pinned.status.pinned).toBe(true);
  expect((await alex.get("/api/now")).plan[0].item.task.title).toBe("the one that matters");
});
