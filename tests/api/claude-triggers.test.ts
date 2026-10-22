import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type Api, TestServer } from "../harness/server.ts";

interface Fire {
  path: string;
  headers: IncomingHttpHeaders;
  text: string;
}

/** Stands in for the Claude Code fire endpoint: records fires, answers like the real one. */
class FireEndpoint {
  readonly fires: Fire[] = [];
  /** Statuses to answer with, in turn; 200 once they run out. */
  failWith: number[] = [];
  private readonly http: Server;
  readonly base: string;
  private constructor(http: Server, base: string) {
    this.http = http;
    this.base = base;
  }

  static async start(): Promise<FireEndpoint> {
    let self: FireEndpoint | null = null;
    const http = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => {
        body += d;
      });
      req.on("end", () => {
        const me = self as FireEndpoint;
        me.fires.push({ path: req.url ?? "", headers: req.headers, text: JSON.parse(body).text });
        const status = me.failWith.shift() ?? 200;
        res.writeHead(status, { "content-type": "application/json" });
        const n = me.fires.length;
        res.end(
          JSON.stringify(
            status === 200
              ? {
                  type: "routine_fire",
                  claude_code_session_id: `session_${n}`,
                  claude_code_session_url: `https://claude.ai/code/session_${n}`,
                }
              : { type: "error", error: { type: "api_error", message: "nope" } },
          ),
        );
      });
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const port = (http.address() as { port: number }).port;
    self = new FireEndpoint(http, `http://127.0.0.1:${port}`);
    return self;
  }

  async waitFor(n: number, ms = 10_000): Promise<Fire[]> {
    const deadline = Date.now() + ms;
    while (this.fires.length < n) {
      if (Date.now() > deadline) throw new Error(`only ${this.fires.length} fires`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.fires;
  }

  close(): Promise<void> {
    return new Promise((r) => this.http.close(() => r()));
  }
}

const FIRE_PATH = "/v1/claude_code/routines/trig_01TEST/fire";
const SETTLE_MS = 300;

let server: TestServer;
let endpoint: FireEndpoint;
let alex: Api;
let sam: Api;

beforeEach(async () => {
  endpoint = await FireEndpoint.start();
  server = await TestServer.start({
    env: {
      TUIT_WEBHOOK_ALLOW_PRIVATE_NETWORKS: "1",
      TUIT_WEBHOOK_RETRY_DELAYS_MS: "50,50",
      TUIT_CLAUDE_TRIGGERS: JSON.stringify([
        {
          for: "alex",
          agent: "claude",
          url: `${endpoint.base}${FIRE_PATH}`,
          token_env: "CLAUDE_TRIGGER_TOKEN",
        },
      ]),
      CLAUDE_TRIGGER_TOKEN: "sk-ant-oat01-test",
      TUIT_CLAUDE_TRIGGER_SETTLE_MS: String(SETTLE_MS),
      TUIT_CLAUDE_TRIGGER_MIN_INTERVAL_MS: "0",
    },
  });
  await server.setClock("2026-10-05T09:00:00+11:00");
  alex = await server.api("alex", "phone");
  sam = await server.api("sam", "phone");
});

afterEach(async () => {
  await server.stop();
  await endpoint.close();
});

const quiet = (ms = SETTLE_MS * 3) => new Promise((r) => setTimeout(r, ms));

const systemNotes = async (id: string): Promise<string[]> => {
  const view = await alex.get(`/api/tasks/${id}?activity=all`);
  return (view.activity ?? [])
    .filter((a: { kind: string }) => a.kind === "system")
    .map((a: { body: string }) => a.body);
};

test("a burst of handoffs to the agent starts one session that lists them all", async () => {
  const { task: a } = await alex.post("/api/tasks", { title: "Compare electricity plans" });
  await alex.post(`/api/tasks/${a.id}/handoff`, { to: "agent:claude" });
  const { task: b } = await alex.post("/api/tasks", {
    title: "Find a piano teacher",
    next_actor: "agent:claude",
  });

  const [fire] = await endpoint.waitFor(1);
  await quiet();
  expect(endpoint.fires).toHaveLength(1);
  expect(fire?.path).toBe(FIRE_PATH);
  expect(fire?.headers.authorization).toBe("Bearer sk-ant-oat01-test");
  expect(fire?.headers["anthropic-version"]).toBe("2023-06-01");
  expect(fire?.text).toContain("2 tasks are newly waiting for agent:claude, acting for Alex");
  expect(fire?.text).toContain(`- Compare electricity plans (${a.id}) ${server.url}/tasks/${a.id}`);
  expect(fire?.text).toContain(`- Find a piano teacher (${b.id})`);
  expect(fire?.text).toContain("claim_next as agent:claude");

  expect(await systemNotes(a.id)).toEqual([
    "Started a Claude Code session for agent:claude: https://claude.ai/code/session_1",
  ]);

  // Covered tasks don't fire again, after a sweep or a restart.
  await server.restart();
  await alex.get("/api/now");
  await quiet();
  expect(endpoint.fires).toHaveLength(1);
});

test("only work the agent could claim fires, and a task handed back later fires again", async () => {
  // Someone else's turn, another agent's, Sam's private task, and one not available yet.
  await alex.post("/api/tasks", { title: "Book the dentist" });
  await alex.post("/api/tasks", { title: "Tidy the feed", next_actor: "agent:chatgpt" });
  await sam.post("/api/tasks", {
    title: "Sam's surprise",
    next_actor: "agent:claude",
    visibility: "private",
  });
  const { task: later } = await alex.post("/api/tasks", {
    title: "Renew the rego",
    next_actor: "agent:claude",
    available_from: "2026-10-07",
  });
  await quiet();
  expect(endpoint.fires).toHaveLength(0);

  // Claimed before the settle window ends: nothing left to start a session for.
  const claude = await server.api("alex", "claude");
  const { task: quick } = await alex.post("/api/tasks", {
    title: "Look up the bin day",
    next_actor: "agent:claude",
  });
  await claude.post("/api/claim", { task_id: quick.id, side_effects: false });
  await quiet();
  expect(endpoint.fires).toHaveLength(0);

  // Time alone makes the held task claimable.
  await server.setClock("2026-10-07T09:00:00+11:00");
  await alex.get("/api/now");
  const [fire] = await endpoint.waitFor(1);
  expect(fire?.text).toContain(`Renew the rego (${later.id})`);

  // Handed to Alex and back again: new work, a new session.
  await alex.post(`/api/tasks/${later.id}/handoff`, { to: "me" });
  await quiet();
  await alex.post(`/api/tasks/${later.id}/handoff`, { to: "agent:claude" });
  const fires = await endpoint.waitFor(2);
  expect(fires[1]?.text).toContain("a task is newly waiting");
  expect(fires[1]?.text).toContain(later.id);
});

test("a failing endpoint is retried, and a refused fire is noted on the task", async () => {
  endpoint.failWith = [503];
  const { task: a } = await alex.post("/api/tasks", {
    title: "Compare electricity plans",
    next_actor: "agent:claude",
  });
  await endpoint.waitFor(2);
  expect(await systemNotes(a.id)).toEqual([
    "Started a Claude Code session for agent:claude: https://claude.ai/code/session_2",
  ]);

  endpoint.failWith = [401];
  const { task: b } = await alex.post("/api/tasks", {
    title: "Find a piano teacher",
    next_actor: "agent:claude",
  });
  await endpoint.waitFor(3);
  await quiet();
  expect(endpoint.fires).toHaveLength(3);
  expect(endpoint.fires[2]?.text).toContain("1 earlier task is also waiting.");
  expect(await systemNotes(b.id)).toEqual([
    "Couldn't start a Claude Code session for agent:claude (HTTP 401)",
  ]);
});
