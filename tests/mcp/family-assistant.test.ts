import { afterEach, beforeEach, expect, test } from "vitest";
import { Api, TestServer } from "../harness/server.ts";
import { signIn } from "../harness/session.ts";
import { Mcp } from "./client.ts";

let server: TestServer;
const sessions: Mcp[] = [];

beforeEach(async () => {
  server = await TestServer.start({
    env: { MCP_JWT_ISSUER: "https://issuer.example.invalid", MCP_JWT_AUDIENCE: "tuit-mcp" },
  });
});

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  await server.stop();
});

test("agent credentials report the effective identity and capability without caching", async () => {
  const token = await server.mintToken("alex", "family-assistant");

  const response = await fetch(`${server.url}/api/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const identity = await response.json();

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(identity).toMatchObject({
    user: { id: "alex" },
    agent: "family-assistant",
    can_write: true,
  });
  expect(JSON.stringify(identity)).not.toContain(token);
});

test("read-only credentials report their actual capability", async () => {
  const api = new Api(server.url, await server.mintToken("sam", "family-assistant", "read"));

  const identity = await api.get("/api/me");

  expect(identity).toMatchObject({
    user: { id: "sam" },
    agent: "family-assistant",
    can_write: false,
  });
});

test("identity verification rejects missing and revoked credentials", async () => {
  const human = await signIn(server, "alex");
  const issuedResponse = await human.fetch("/api/tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "agent", agent: "family-assistant" }),
  });
  const issued = await issuedResponse.json();
  const revocation = await human.fetch(`/api/tokens/${issued.info.id}`, { method: "DELETE" });
  expect(revocation.status).toBe(200);

  const missing = await fetch(`${server.url}/api/me`);
  const revoked = await new Api(server.url, issued.token).call("GET", "/api/me");

  expect(missing.status).toBe(401);
  expect(revoked.status).toBe(401);
});

test("the same agent acting concurrently for two people preserves ownership and attribution", async () => {
  const alex = await Mcp.connect(server.url, await server.mintToken("alex", "family-assistant"));
  const sam = await Mcp.connect(server.url, await server.mintToken("sam", "family-assistant"));
  sessions.push(alex, sam);

  const results = await Promise.all([
    alex.call("create_task", { title: "Book the plumber" }),
    sam.call("create_task", { title: "Call the school" }),
  ]);

  expect(results.map((result) => result.task.owner)).toEqual(["alex", "sam"]);
  const reader = await server.human("alex");
  const activities = await Promise.all(
    results.map((result) => reader.get(`/api/tasks/${result.task.id}`)),
  );
  expect(activities.map((result) => result.activity[0].author)).toEqual([
    { user: "alex", agent: "family-assistant" },
    { user: "sam", agent: "family-assistant" },
  ]);
});
