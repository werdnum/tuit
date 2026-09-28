import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type pg from "pg";
import type { Database } from "../db/db.ts";
import { FEED_MOVED, LIVE_CHANNEL, listChanges } from "../domain/feed.ts";
import type { Principal } from "../domain/types.ts";

/** Comment line sent on an idle stream, well inside common proxy idle timeouts (60s). */
const HEARTBEAT_MS = 25_000;
/**
 * Streams end after this long and the browser reconnects (resuming from its last cursor), so
 * a stream never outlives a session that has since been signed out or expired by much.
 */
const MAX_STREAM_MS = 10 * 60_000;
const RELISTEN_MS = 5_000;

type WakeKind = "feed" | "personal";
interface Subscriber {
  userId: string;
  wake: (kind: WakeKind) => void;
}

/**
 * One LISTEN connection per process, fanned out to every open live stream. Notifications carry
 * no content, so the hub decides nothing about visibility: each stream re-reads the feed as its
 * own principal.
 */
export class LiveHub {
  private readonly db: Database;
  private readonly subscribers = new Set<Subscriber>();
  private client: pg.PoolClient | null = null;
  private starting = false;
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(db: Database) {
    this.db = db;
  }

  subscribe(userId: string, wake: (kind: WakeKind) => void): () => void {
    const sub = { userId, wake };
    this.subscribers.add(sub);
    this.ensureListening();
    return () => {
      this.subscribers.delete(sub);
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    const client = this.client;
    this.client = null;
    if (client) drop(client);
  }

  private ensureListening(): void {
    if (this.client || this.starting || this.retry || this.stopped) return;
    this.starting = true;
    this.listen().finally(() => {
      this.starting = false;
    });
  }

  private async listen(): Promise<void> {
    let client: pg.PoolClient;
    try {
      client = await this.db.pool.connect();
    } catch (err) {
      this.lost(null, err);
      return;
    }
    // A checked-out client with no error listener would crash the process on a dropped
    // connection.
    client.on("error", (err) => this.lost(client, err));
    client.on("end", () => this.lost(client, null));
    client.on("notification", (n) => this.dispatch(n.payload || FEED_MOVED));
    try {
      await client.query(`LISTEN ${LIVE_CHANNEL}`);
    } catch (err) {
      this.lost(client, err);
      return;
    }
    if (this.stopped) {
      drop(client);
      return;
    }
    this.client = client;
    // Anything committed while nobody was listening: every stream re-checks.
    this.dispatch(FEED_MOVED);
  }

  private lost(client: pg.PoolClient | null, err: unknown): void {
    if (client) {
      if (this.client !== client && this.client !== null) return;
      this.client = null;
      drop(client);
    }
    if (this.stopped || this.retry) return;
    if (err) console.error("live updates: lost the notification connection", err);
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.subscribers.size > 0) this.ensureListening();
    }, RELISTEN_MS);
  }

  private dispatch(payload: string): void {
    for (const s of this.subscribers) {
      if (payload === FEED_MOVED) s.wake("feed");
      else if (s.userId === payload) s.wake("personal");
    }
  }
}

/** Give a LISTEN connection back to the pool for disposal, exactly once. */
function drop(client: pg.PoolClient): void {
  client.removeAllListeners("end");
  client.removeAllListeners("error");
  client.removeAllListeners("notification");
  client.on("error", () => {});
  client.release(true);
}

function parseCursor(v: string | undefined): number | null {
  if (v === undefined || !/^\d{1,15}$/.test(v)) return null;
  return Number(v);
}

/**
 * Server-sent events telling a signed-in page that something it may be showing has changed.
 * Each `change` event carries only the feed cursor; the page re-fetches itself, so everything
 * it then shows goes through the same visibility checks as any other page load. The feed moves
 * only past events this person can see, so a stream never reveals hidden activity.
 */
export function liveStream(c: Context, db: Database, hub: LiveHub, me: Principal): Response {
  const userId = me.userId;
  if (!userId) return c.text("Not found", 404);
  const resumeFrom = parseCursor(c.req.header("last-event-id") ?? c.req.query("after"));
  const latest = async () => Number((await listChanges(db, me, "latest")).cursor);

  // Stop proxies (nginx-style ones honour X-Accel-Buffering) and transforms from holding events.
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    let feedMoved = true;
    let personal = false;
    let personalAt = 0;
    let woken: (() => void) | null = null;
    const unsubscribe = hub.subscribe(userId, (kind) => {
      if (kind === "feed") feedMoved = true;
      else {
        personal = true;
        personalAt = Date.now();
      }
      woken?.();
    });
    stream.onAbort(() => woken?.());
    const sleep = (ms: number) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          woken = null;
          resolve(false);
        }, ms);
        woken = () => {
          clearTimeout(timer);
          woken = null;
          resolve(true);
        };
      });

    try {
      let cursor = resumeFrom ?? (await latest());
      await stream.writeSSE({ event: "ready", data: String(cursor), retry: 3000 });
      const deadline = Date.now() + MAX_STREAM_MS;
      while (!stream.aborted && Date.now() < deadline) {
        if (feedMoved || personal) {
          const wasPersonal = personal;
          feedMoved = false;
          personal = false;
          const seq = await latest();
          if (seq > cursor || wasPersonal) {
            cursor = Math.max(cursor, seq);
            // A page rendered at or past this cursor (or, for a personal change, after it was
            // announced) already shows it; the page uses these to skip a redundant refresh.
            const data = wasPersonal ? { cursor, at: personalAt } : { cursor };
            await stream.writeSSE({
              event: "change",
              data: JSON.stringify(data),
              id: String(cursor),
            });
          }
          continue;
        }
        const wasWoken = await sleep(Math.min(HEARTBEAT_MS, deadline - Date.now()));
        if (!wasWoken && !stream.aborted) await stream.write(": ping\n\n");
      }
    } finally {
      unsubscribe();
    }
  });
}
