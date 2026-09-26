import { afterEach, beforeEach, expect, test } from "vitest";
import { type Api, TestServer } from "../harness/server.ts";
import { Mcp } from "./client.ts";

let server: TestServer;
let alex: Api;
let claude: Mcp;
const ids: Record<string, string> = {};

beforeEach(async () => {
  server = await TestServer.start();
  await server.setClock("2026-10-05T09:00:00+11:00");
  alex = await server.api("alex", "phone");
  claude = await Mcp.connect(server.url, await server.mintToken("alex", "claude"));
  const make = async (key: string, body: Record<string, unknown>) => {
    ids[key] = (await alex.post("/api/tasks", body)).task.id;
  };
  await make("tax", {
    title: "Lodge the tax return",
    requires: ["computer"],
    target: "2026-10-06",
  });
  await make("rego", { title: "Renew car rego online", requires: ["computer"] });
  await make("photos", { title: "Back up the photo library", requires: ["computer"] });
  await make("plumber", { title: "Ring the plumber", requires: ["phone"] });
});

afterEach(async () => {
  await claude.close();
  await server.stop();
});

const deskQueue = {
  name: "At the desk",
  config: { contexts: ["computer"], only_requiring: ["computer"], visible_limit: 2 },
};

test("a queue an agent saves behaves identically over MCP and REST", async () => {
  const queue = await claude.call("save_queue", deskQueue);

  const viaMcp = await claude.call("run_queue", { queue_id: queue.id });
  const viaRest = await alex.get(`/api/queues/${queue.id}`);

  const order = (r: { items: { task: { id: string } }[] }) => r.items.map((i) => i.task.id);
  expect(order(viaMcp.result)).toEqual([ids.tax, ids.rego]);
  expect(order(viaMcp.result)).toEqual(order(viaRest.result));
  expect(viaMcp.result.hidden_count).toBe(viaRest.result.hidden_count);
});

test("explain says why a task is excluded from a queue", async () => {
  const queue = await claude.call("save_queue", deskQueue);

  const why = await claude.call("explain", { task_id: ids.plumber, queue_id: queue.id });

  expect(why.verdict).toBe("excluded");
  expect(why.summary).toMatch(/requires \[phone\]/);
});

test("explain says when a matching task is beyond the visible limit", async () => {
  const queue = await claude.call("save_queue", deskQueue);

  const why = await claude.call("explain", { task_id: ids.photos, queue_id: queue.id });

  expect(why.verdict).toBe("beyond_limit");
  expect(why.summary).toBe("Matches, but is number 3 and the queue shows 2");
});

test("modifying a queue from a stale revision is a conflict that returns the current queue", async () => {
  const queue = await claude.call("save_queue", deskQueue);
  await alex.patch(`/api/queues/${queue.id}`, { name: "Desk", expected_revision: 1 });

  const r = await claude.raw("save_queue", {
    queue_id: queue.id,
    config: { ...deskQueue.config, visible_limit: 5 },
    expected_revision: 1,
  });

  expect(r.isError).toBe(true);
  const body = JSON.parse((r.content[0] as { text: string }).text);
  expect(body.error).toBe("conflict");
  expect(body.current).toMatchObject({ name: "Desk", revision: 2 });
});

test("modifying a queue at its current revision takes effect", async () => {
  const queue = await claude.call("save_queue", deskQueue);

  await claude.call("save_queue", {
    queue_id: queue.id,
    config: { ...deskQueue.config, visible_limit: 3 },
    expected_revision: 1,
  });

  const viaRest = await alex.get(`/api/queues/${queue.id}`);
  expect(viaRest.queue.revision).toBe(2);
  expect(viaRest.result.items).toHaveLength(3);
});
