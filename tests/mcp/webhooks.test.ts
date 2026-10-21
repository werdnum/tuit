import { createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type Api, TestServer } from "../harness/server.ts";

let server: TestServer;
let alex: Api;
let sam: Api;
let receiver: Receiver;

/** A modern-protocol (2026-07-28) MCP client: one stateless POST per request. */
class Modern {
  readonly base: string;
  readonly token: string;
  constructor(base: string, token: string) {
    this.base = base;
    this.token = token;
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    const named = (params.name ?? params.uri) as string | undefined;
    const res = await fetch(`${this.base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": method,
        ...(named ? { "mcp-name": named } : {}),
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {
              extensions: { "io.modelcontextprotocol/events": {} },
            },
          },
        },
      }),
    });
    return { status: res.status, body: await res.json() };
  }

  /** The result of a request that must succeed. */
  async ok(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const r = await this.send(method, params);
    if (r.status !== 200 || r.body.error) throw new Error(JSON.stringify(r.body));
    expect(r.body.result.resultType).toBe("complete");
    return r.body.result;
  }
}

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
  json: any;
}

/** A webhook endpoint that answers challenges, records deliveries, and can be told to fail. */
class Receiver {
  readonly received: Received[] = [];
  /** Statuses to answer deliveries with, in turn; 200 once they run out. */
  failWith: number[] = [];
  echoChallenge = true;
  private waiters: (() => void)[] = [];
  private readonly http: Server;
  readonly url: string;
  private constructor(http: Server, url: string) {
    this.http = http;
    this.url = url;
  }

  static async start(): Promise<Receiver> {
    let self: Receiver | null = null;
    const http = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => {
        body += d;
      });
      req.on("end", () => (self as Receiver).handle(req.headers, body, res));
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const port = (http.address() as { port: number }).port;
    self = new Receiver(http, `http://127.0.0.1:${port}/hooks/tuit`);
    return self;
  }

  private handle(
    headers: IncomingHttpHeaders,
    body: string,
    res: import("node:http").ServerResponse,
  ) {
    const json = JSON.parse(body);
    this.received.push({ headers, body, json });
    for (const w of this.waiters.splice(0)) w();
    if (json.type === "verification") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ challenge: this.echoChallenge ? json.challenge : "nope" }));
      return;
    }
    res.writeHead(this.failWith.shift() ?? 200);
    res.end();
  }

  deliveries(): Received[] {
    return this.received.filter((r) => r.json.type !== "verification");
  }

  /** Waits until `n` deliveries (not challenges) have arrived. */
  async waitFor(n: number, ms = 10_000): Promise<Received[]> {
    const deadline = Date.now() + ms;
    while (this.deliveries().length < n) {
      if (Date.now() > deadline) throw new Error(`only ${this.deliveries().length} deliveries`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, 500);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
    return this.deliveries();
  }

  close(): Promise<void> {
    return new Promise((r) => this.http.close(() => r()));
  }
}

const newSecret = () => `whsec_${randomBytes(32).toString("base64")}`;

function verifySignature(r: Received, secret: string): boolean {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const signed = `${r.headers["webhook-id"]}.${r.headers["webhook-timestamp"]}.${r.body}`;
  const expected = createHmac("sha256", key).update(signed).digest("base64");
  return String(r.headers["webhook-signature"]).split(" ").includes(`v1,${expected}`);
}

beforeEach(async () => {
  server = await TestServer.start({
    env: { TUIT_WEBHOOK_ALLOW_PRIVATE_NETWORKS: "1", TUIT_WEBHOOK_RETRY_DELAYS_MS: "50,50" },
  });
  await server.setClock("2026-10-05T09:00:00+11:00");
  alex = await server.api("alex", "phone");
  sam = await server.api("sam", "phone");
  receiver = await Receiver.start();
});

afterEach(async () => {
  await receiver.close();
  await server.stop();
});

const agent = async (user: string, name: string) =>
  new Modern(server.url, await server.mintToken(user, name));

test("a modern client discovers the server, its events, and uses tools without a session", async () => {
  const chatgpt = await agent("alex", "chatgpt");
  const discovered = await chatgpt.ok("server/discover");
  expect(discovered.supportedVersions).toContain("2026-07-28");
  expect(discovered.capabilities.extensions).toEqual({ "io.modelcontextprotocol/events": {} });
  expect(discovered.capabilities.tools).toBeDefined();
  expect(discovered.instructions).toContain("inbox.changed");
  expect(discovered._meta["io.modelcontextprotocol/serverInfo"].name).toBe("tuit");

  const { events } = await chatgpt.ok("events/list");
  expect(events.map((e: any) => e.name)).toEqual(["inbox.changed", "task.changed", "feed.changed"]);
  expect(events[0].delivery).toEqual(["poll", "webhook"]);

  const tools = await chatgpt.ok("tools/list");
  expect(tools.tools.map((t: any) => t.name)).toContain("create_task");
  const made = await chatgpt.ok("tools/call", {
    name: "create_task",
    arguments: { title: "Renew the car rego" },
  });
  expect(JSON.parse(made.content[0].text).task.title).toBe("Renew the car rego");
});

test("modern requests are checked against their headers and version", async () => {
  const chatgpt = await agent("alex", "chatgpt");
  const mismatch = await chatgpt.send(
    "tools/call",
    { name: "now", arguments: {} },
    { "mcp-name": "create_task" },
  );
  expect(mismatch.status).toBe(400);
  expect(mismatch.body.error.code).toBe(-32020);

  const future = await chatgpt.send("tools/list", {}, { "mcp-protocol-version": "2099-01-01" });
  expect(future.status).toBe(400);
  expect(future.body.error.code).toBe(-32020);

  const unknown = await chatgpt.send("nothing/here");
  expect(unknown.status).toBe(404);
  expect(unknown.body.error.code).toBe(-32601);
});

test("a webhook subscriber is challenged, then gets each handoff signed and in order", async () => {
  const chatgpt = await agent("alex", "chatgpt");
  const secret = newSecret();
  const sub = await chatgpt.ok("events/subscribe", {
    name: "inbox.changed",
    arguments: {},
    delivery: { mode: "webhook", url: receiver.url, secret },
    cursor: null,
  });
  expect(sub.id).toMatch(/^sub_/);
  expect(Date.parse(sub.refreshBefore)).toBeGreaterThan(Date.parse("2026-10-05T09:00:00+11:00"));
  expect(sub.truncated).toBe(false);
  const [challenge] = receiver.received;
  expect(challenge?.json.type).toBe("verification");
  expect(verifySignature(challenge as Received, secret)).toBe(true);

  const { task: a } = await alex.post("/api/tasks", { title: "Find a pool fence repairer" });
  await alex.post(`/api/tasks/${a.id}/handoff`, { to: "agent:chatgpt" });
  const { task: b } = await alex.post("/api/tasks", {
    title: "Compare health insurance",
    next_actor: "agent:chatgpt",
  });
  const got = await receiver.waitFor(2);
  expect(got.map((r) => r.json.data.task.id)).toEqual([a.id, b.id]);
  const first = got[0] as Received;
  expect(verifySignature(first, secret)).toBe(true);
  expect(first.headers["webhook-id"]).toBe(first.json.eventId);
  expect(first.headers["x-mcp-subscription-id"]).toBe(sub.id);
  expect(first.json).toMatchObject({
    name: "inbox.changed",
    data: {
      category: "handoff",
      task: { id: a.id, next_actor: { kind: "agent", agent: "chatgpt" } },
      actor: { user: "alex", agent: "phone" },
    },
  });
  expect(Number(first.json.cursor)).toBeLessThan(Number((got[1] as Received).json.cursor));

  // Subscribing again (arguments in any order) refreshes the same subscription, unchallenged.
  const again = await chatgpt.ok("events/subscribe", {
    name: "inbox.changed",
    arguments: {},
    delivery: { mode: "webhook", url: receiver.url, secret },
    cursor: sub.cursor,
  });
  expect(again.id).toBe(sub.id);
  expect(receiver.received.filter((r) => r.json.type === "verification")).toHaveLength(1);
});

test("an endpoint that doesn't echo the challenge is refused", async () => {
  const chatgpt = await agent("alex", "chatgpt");
  receiver.echoChallenge = false;
  const r = await chatgpt.send("events/subscribe", {
    name: "inbox.changed",
    arguments: {},
    delivery: { mode: "webhook", url: receiver.url, secret: newSecret() },
    cursor: null,
  });
  expect(r.body.error.code).toBe(-32015);
  expect(r.body.error.data.reason).toBe("challenge_failed");
  await alex.post("/api/tasks", { title: "Book the plumber", next_actor: "agent:chatgpt" });
  await chatgpt.ok("tools/call", { name: "now", arguments: {} });
  expect(receiver.deliveries()).toEqual([]);
});

test("bad subscriptions are rejected", async () => {
  const chatgpt = await agent("alex", "chatgpt");
  const base = {
    name: "inbox.changed",
    arguments: {},
    delivery: { mode: "webhook", url: receiver.url, secret: newSecret() },
    cursor: null,
  };
  const code = async (params: Record<string, unknown>) =>
    (await chatgpt.send("events/subscribe", params)).body.error?.code;
  expect(await code({ ...base, name: "nope" })).toBe(-32023);
  expect(await code({ ...base, delivery: { ...base.delivery, secret: "hunter2" } })).toBe(-32602);
  expect(await code({ ...base, arguments: { colour: "red" } })).toBe(-32602);
  expect(await code({ ...base, delivery: { ...base.delivery, mode: "push" } })).toBe(-32026);
});

test("a failed delivery is retried with the same id, and a 410 ends the subscription", async () => {
  const chatgpt = await agent("alex", "chatgpt");
  await chatgpt.ok("events/subscribe", {
    name: "inbox.changed",
    arguments: {},
    delivery: { mode: "webhook", url: receiver.url, secret: newSecret() },
    cursor: null,
  });
  receiver.failWith = [503];
  await alex.post("/api/tasks", { title: "Renew passport", next_actor: "agent:chatgpt" });
  const [failed, retried] = await receiver.waitFor(2);
  expect(retried?.headers["webhook-id"]).toBe(failed?.headers["webhook-id"]);

  receiver.failWith = [410];
  await alex.post("/api/tasks", { title: "Cancel the gym", next_actor: "agent:chatgpt" });
  await receiver.waitFor(3);
  await alex.post("/api/tasks", { title: "Return the library books", next_actor: "agent:chatgpt" });
  await chatgpt.ok("tools/call", { name: "now", arguments: {} });
  await expect(receiver.waitFor(4, 1500)).rejects.toThrow(/only 3/);
}, 20_000);

test("another person's private task and the agent's own changes are never delivered", async () => {
  const chatgpt = await agent("alex", "chatgpt");
  await chatgpt.ok("events/subscribe", {
    name: "feed.changed",
    arguments: {},
    delivery: { mode: "webhook", url: receiver.url, secret: newSecret() },
    cursor: null,
  });
  await sam.post("/api/tasks", {
    title: "Surprise party for Alex",
    visibility: "private",
    next_actor: "agent:chatgpt",
  });
  await chatgpt.ok("tools/call", { name: "create_task", arguments: { title: "Order flowers" } });
  const { task } = await alex.post("/api/tasks", { title: "Water the plants" });
  const got = await receiver.waitFor(1);
  expect(got.map((r) => r.json.data.task.id)).toEqual([task.id]);

  const priv = await sam.post("/api/tasks", { title: "Sam's secret", visibility: "private" });
  const watchIt = await chatgpt.send("events/subscribe", {
    name: "task.changed",
    arguments: { task_id: priv.task.id },
    delivery: { mode: "webhook", url: receiver.url, secret: newSecret() },
    cursor: null,
  });
  expect(watchIt.body.error.code).toBe(-32024);
});

test("a subscription outlives a restart", async () => {
  // The restarted server checks expiry before the test clock is pinned again.
  await server.setClock(null);
  const chatgpt = await agent("alex", "chatgpt");
  await chatgpt.ok("events/subscribe", {
    name: "inbox.changed",
    arguments: {},
    delivery: { mode: "webhook", url: receiver.url, secret: newSecret() },
    cursor: null,
  });
  await server.restart();
  await alex.post("/api/tasks", { title: "Get the car serviced", next_actor: "agent:chatgpt" });
  await receiver.waitFor(1);
}, 30_000);

test("a subscription lapses unless refreshed", async () => {
  const chatgpt = await agent("alex", "chatgpt");
  const sub = await chatgpt.ok("events/subscribe", {
    name: "inbox.changed",
    arguments: {},
    delivery: { mode: "webhook", url: receiver.url, secret: newSecret() },
    cursor: null,
    ttlMs: 3_600_000,
  });
  expect(sub.refreshBefore).toBe("2026-10-04T23:00:00.000Z");
  await server.setClock("2026-10-05T11:00:00+11:00");
  await alex.post("/api/tasks", { title: "Pay the water bill", next_actor: "agent:chatgpt" });
  await chatgpt.ok("tools/call", { name: "now", arguments: {} });
  await expect(receiver.waitFor(1, 1500)).rejects.toThrow(/only 0/);
});

test("polling picks up where the last poll left off", async () => {
  const chatgpt = await agent("alex", "chatgpt");
  const first = await chatgpt.ok("events/poll", {
    name: "inbox.changed",
    arguments: {},
    cursor: null,
  });
  expect(first.events).toEqual([]);
  const { task } = await alex.post("/api/tasks", {
    title: "Sort the recycling",
    next_actor: "agent:chatgpt",
  });
  const next = await chatgpt.ok("events/poll", {
    name: "inbox.changed",
    arguments: {},
    cursor: first.cursor,
  });
  expect(next.events.map((e: any) => e.data.task.id)).toEqual([task.id]);
  expect(next.hasMore).toBe(false);
  const quiet = await chatgpt.ok("events/poll", {
    name: "inbox.changed",
    arguments: {},
    cursor: next.cursor,
  });
  expect(quiet.events).toEqual([]);
});

test("a legacy client is unaffected", async () => {
  const res = await fetch(`${server.url}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await server.mintToken("alex", "claude")}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "x", version: "1" },
      },
    }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("mcp-session-id")).toBeTruthy();
  expect((await res.json()).result.protocolVersion).toBe("2025-11-25");
});

test("same-principal inbox webhooks and polls agree without waking task or feed watchers", async () => {
  const dot = await agent("alex", "chatgpt");
  const chat = await agent("alex", "chatgpt");
  const writer = await server.api("alex", "chatgpt");
  const { task } = await writer.post("/api/tasks", { title: "Delegation target" });
  const watches = [
    { name: "inbox.changed", arguments: {} },
    { name: "task.changed", arguments: { task_id: task.id } },
    { name: "feed.changed", arguments: {} },
    { name: "inbox.changed", arguments: { actor: "sam" } },
  ];
  const starts: string[] = [];
  for (const watch of watches) {
    const sub = await dot.ok("events/subscribe", {
      ...watch,
      delivery: { mode: "webhook", url: receiver.url, secret: newSecret() },
    });
    starts.push(sub.cursor);
  }
  await server.setClock("2026-10-05T09:01:00+11:00");
  await writer.post(`/api/tasks/${task.id}/handoff`, { to: "agent:chatgpt" });
  await receiver.waitFor(1);
  await server.setClock("2026-10-05T09:02:00+11:00");
  await writer.post(`/api/tasks/${task.id}/checkpoint`, {
    note: "Still working",
    next_actor: "agent:chatgpt",
  });
  await server.setClock("2026-10-05T09:03:00+11:00");
  await writer.post(`/api/tasks/${task.id}/handoff`, {
    to: "agent:chatgpt",
    idempotency_key: "again",
  });
  await receiver.waitFor(2);
  await writer.post(`/api/tasks/${task.id}/handoff`, {
    to: "agent:chatgpt",
    idempotency_key: "again",
  });
  await server.setClock("2026-10-05T09:04:00+11:00");
  await writer.post(`/api/tasks/${task.id}/complete`);
  // A final arrival is a delivery barrier after the suppressed writes.
  await chat.ok("tools/call", {
    name: "create_task",
    arguments: { title: "Next delegation", next_actor: "agent:chatgpt" },
  });
  await receiver.waitFor(3);
  const delivered = receiver.deliveries().map((r) => r.json);
  expect(delivered.map((r) => r.name)).toEqual(["inbox.changed", "inbox.changed", "inbox.changed"]);
  expect(new Set(delivered.map((r) => r.eventId)).size).toBe(3);

  for (const [i, watch] of watches.entries()) {
    const polled = await dot.ok("events/poll", { ...watch, cursor: starts[i], maxEvents: 1 });
    if (i === 0) {
      expect(polled.events).toHaveLength(1);
      expect(polled.hasMore).toBe(true);
      const rest = await dot.ok("events/poll", { ...watch, cursor: polled.cursor });
      expect(rest.hasMore).toBe(false);
      const all = [...polled.events, ...rest.events];
      // Task summaries are current at read time, so compare event identity and types.
      const event = (e: any) => ({ types: e.data.types, id: e.data.task.id, cursor: e.cursor });
      expect(all.map(event)).toEqual(delivered.map(event));
      expect((await dot.ok("events/poll", { ...watch, cursor: rest.cursor })).events).toEqual([]);
    } else {
      expect(polled.events).toEqual([]);
      expect(Number(polled.cursor)).toBeGreaterThan(Number(starts[i]));
    }
  }
});
