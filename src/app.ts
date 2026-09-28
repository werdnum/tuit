import { Hono } from "hono";
import { ZodError } from "zod";
import { Auth, type AuthEnv } from "./api/auth.ts";
import { oauthRoutes } from "./api/oauth.ts";
import { restApi } from "./api/rest.ts";
import { type Clock, SettableClock, systemClock } from "./clock.ts";
import type { Config } from "./config.ts";
import type { Database } from "./db/db.ts";
import { Board } from "./domain/board.ts";
import { DomainError } from "./domain/errors.ts";
import { sweep } from "./domain/sweep.ts";
import { TaskService } from "./domain/tasks.ts";
import { mcpRoutes } from "./mcp/server.ts";
import { LiveHub } from "./web/live.ts";
import { webRoutes } from "./web/routes.ts";

export interface App {
  config: Config;
  db: Database;
  clock: Clock;
  tasks: TaskService;
  board: Board;
  auth: Auth;
  live: LiveHub;
  sweepNow: () => Promise<void>;
}

export function buildApp(config: Config, db: Database): { app: App; http: Hono<AuthEnv> } {
  const clock = config.testClock ? new SettableClock() : systemClock;
  const sweepNow = () => sweep(db, clock.now());
  const tasks = new TaskService(db, clock, sweepNow);
  const board = new Board(db, clock, tasks, sweepNow);
  const auth = new Auth(db, config, clock);
  const live = new LiveHub(db);
  const app: App = { config, db, clock, tasks, board, auth, live, sweepNow };

  const http = new Hono<AuthEnv>();
  http.onError((err, c) => {
    if (err instanceof DomainError) {
      const current = "current" in err ? { current: err.current } : {};
      return c.json({ error: err.code, message: err.message, ...current }, err.status as 400);
    }
    if (err instanceof ZodError) {
      return c.json(
        {
          error: "invalid",
          message: err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
        },
        400,
      );
    }
    console.error(err);
    return c.json({ error: "internal", message: "Internal error" }, 500);
  });

  http.get("/healthz", async (c) => {
    await db.query("SELECT 1");
    return c.text("ok");
  });

  if (config.testClock && clock instanceof SettableClock) {
    http.post("/__test/clock", async (c) => {
      const { now } = (await c.req.json()) as { now: string | null };
      clock.set(now ? new Date(now) : null);
      return c.json({ now: clock.now().toISOString() });
    });
  }

  http.route("/", oauthRoutes(app));
  http.route("/api", restApi(app));
  http.route("/mcp", mcpRoutes(app));
  http.route("/", webRoutes(app));
  return { app, http };
}

export async function seedUsers(db: Database, config: Config): Promise<void> {
  for (const u of config.users) {
    await db.query(
      `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name`,
      [u.id, u.email, u.name],
    );
  }
}
