import { afterEach, beforeEach, expect, test } from "vitest";
import { TestServer } from "../harness/server.ts";
import { Mcp } from "./client.ts";

let server: TestServer;
let claude: Mcp;

beforeEach(async () => {
  server = await TestServer.start();
  await server.setClock("2026-10-05T09:00:00+11:00");
  claude = await Mcp.connect(server.url, await server.mintToken("alex", "claude"));
});

afterEach(async () => {
  await claude.close();
  await server.stop();
});

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "x", version: "1" },
  },
};

async function postMcp(headers: Record<string, string>): Promise<Response> {
  return fetch(`${server.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(initialize),
  });
}

test("an unauthenticated MCP request is refused with a bearer challenge", async () => {
  const r = await postMcp({});

  expect(r.status).toBe(401);
  expect(r.headers.get("www-authenticate")).toMatch(/^Bearer /);
});

test("an unknown bearer token is refused", async () => {
  const r = await postMcp({ authorization: "Bearer tuit_not-a-real-token" });

  expect(r.status).toBe(401);
  expect(r.headers.get("www-authenticate")).toMatch(/invalid_token/);
});

test("the tool surface is small and task-oriented", async () => {
  const { tools } = await claude.client.listTools();

  expect(tools.map((t) => t.name).sort()).toEqual(
    [
      "checkpoint",
      "claim_next",
      "close_task",
      "complete_task",
      "create_task",
      "explain",
      "find_tasks",
      "get_changes",
      "get_task",
      "hand_off",
      "list_queues",
      "now",
      "preview_queue",
      "release_claim",
      "reopen_task",
      "run_queue",
      "save_queue",
      "skip_routine",
      "snooze_task",
      "update_task",
    ].sort(),
  );
});

test("checkpoint declares next_actor as required", async () => {
  const { tools } = await claude.client.listTools();

  const checkpoint = tools.find((t) => t.name === "checkpoint");

  expect(checkpoint?.inputSchema.required).toEqual(
    expect.arrayContaining(["task_id", "note", "next_actor"]),
  );
});

test("a checkpoint without next_actor fails and names the missing field", async () => {
  const { task } = await claude.call("create_task", { title: "Find a pool fence repairer" });

  const r = await claude.raw("checkpoint", { task_id: task.id, note: "Found two candidates" });

  expect(r.isError).toBe(true);
  expect(JSON.stringify(r.content)).toMatch(/next_actor/);
});

test("the server instructions tell the agent who it acts for", async () => {
  expect(claude.client.getInstructions()).toMatch(/agent:claude acting for Alex/);
});

test("brief and note fields tell agents they are Markdown and how to collapse long material", async () => {
  const { tools } = await claude.client.listTools();
  const props = (name: string) =>
    tools.find((t) => t.name === name)?.inputSchema.properties as Record<
      string,
      { description?: string }
    >;

  for (const [tool, field] of [
    ["create_task", "brief"],
    ["update_task", "brief"],
    ["checkpoint", "brief"],
    ["checkpoint", "note"],
    ["hand_off", "brief"],
    ["hand_off", "note"],
    ["complete_task", "note"],
    ["skip_routine", "note"],
  ] as const) {
    const d = props(tool)[field]?.description ?? "";
    expect(d, `${tool}.${field}`).toMatch(/Markdown/);
    expect(d, `${tool}.${field}`).toMatch(/<details><summary>/);
  }
  expect(claude.client.getInstructions()).toMatch(/render as Markdown/);
});
