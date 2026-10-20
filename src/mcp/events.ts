import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { App } from "../app.ts";
import type { Database } from "../db/db.ts";
import { NotFoundError, ValidationError } from "../domain/errors.ts";
import { type FeedEvent, listChanges } from "../domain/feed.ts";
import { newId, visibleSql } from "../domain/tasks.ts";
import { type Actor, type Principal, type Task, taskFromRow } from "../domain/types.ts";
import { changesOf, withoutTrailingWrite } from "../notify/notifier.ts";
import { type Category, type Change, categorize, isMe, PRIORITY } from "../notify/rules.ts";

/**
 * What an agent can watch, named as MCP resource URIs so the same names work for resource
 * subscriptions (pushed on the session's event stream) and for wait_for_events (polled).
 */
export const INBOX_URI = "tuit://inbox";
export const CHANGES_URI = "tuit://changes";
export const TASK_URI_PREFIX = "tuit://tasks/";
export const INBOX_URI_PREFIX = "tuit://inbox/";

export type Watch =
  | { uri: string; kind: "inbox"; actor: Actor }
  | { uri: string; kind: "task"; id: string }
  | { uri: string; kind: "all" };

/** Whose turn "the inbox" means without an actor: this agent's, or the person's own token's. */
export function selfActor(p: Principal): Actor | null {
  if (p.agent) return { kind: "agent", agent: p.agent };
  if (p.userId) return { kind: "user", user: p.userId };
  return null;
}

export async function parseWatch(app: App, p: Principal, uri: string): Promise<Watch> {
  if (uri === CHANGES_URI) return { uri, kind: "all" };
  if (uri === INBOX_URI) {
    const actor = selfActor(p);
    if (!actor) throw new ValidationError("A display token has no inbox; watch tuit://changes");
    return { uri, kind: "inbox", actor };
  }
  if (uri.startsWith(INBOX_URI_PREFIX)) {
    const who = decodeURIComponent(uri.slice(INBOX_URI_PREFIX.length));
    return { uri, kind: "inbox", actor: await app.tasks.resolveActor(who, p) };
  }
  if (uri.startsWith(TASK_URI_PREFIX)) {
    const id = decodeURIComponent(uri.slice(TASK_URI_PREFIX.length));
    // Watching a task you can't see would otherwise confirm nothing, but fail loudly instead
    // of silently never firing.
    await app.tasks.get(p, id);
    return { uri, kind: "task", id };
  }
  throw new ValidationError(
    `Unknown resource "${uri}": watch ${INBOX_URI}, ${INBOX_URI_PREFIX}<actor>, ${TASK_URI_PREFIX}<id> or ${CHANGES_URI}`,
  );
}

/** A change this principal made itself: never reported back to it. */
function ownChange(change: Change, p: Principal): boolean {
  // A display token has no identity of its own: changes with no actor are time's, not its.
  if (p.userId === null && p.agent === null) return false;
  return change.actor.user === p.userId && change.actor.agent === p.agent;
}

/**
 * Whether a change touches what `w` watches. An inbox changes when a task arrives in or leaves
 * the actor's hands, and when anything happens to a task that is theirs.
 */
export function touches(w: Watch, change: Change): boolean {
  if (w.kind === "all") return true;
  if (w.kind === "task") return change.task.id === w.id;
  if (isMe(change.task.next_actor, w.actor)) return true;
  return change.types.some(
    ({ type, data }) =>
      (type === "handed_off" && (isMe(data.to, w.actor) || isMe(data.from, w.actor))) ||
      (type === "created" && isMe(data.next_actor, w.actor)) ||
      (type === "claim_lapsed" && w.actor.kind === "agent" && data.agent === w.actor.agent),
  );
}

export interface WatchedChange {
  seq: number;
  at: string;
  /** The feed events of this one write, e.g. ["checkpoint", "handed_off"]. */
  types: string[];
  /** How a notification would describe it for the watching agent ("handoff", "ready"...). */
  category?: Category;
  task: Pick<Task, "id" | "title" | "state" | "next_actor"> & { area?: string };
  actor: { user?: string; agent?: string };
  /** Which of the watched resources this change touched. */
  watched: string[];
}

function describe(change: Change, p: Principal, watched: string[]): WatchedChange {
  const self = selfActor(p);
  const cats = self ? categorize(change, self) : new Map<Category, boolean>();
  const category =
    PRIORITY.find((c) => cats.get(c) === true) ?? PRIORITY.find((c) => cats.has(c)) ?? undefined;
  const t = change.task;
  return {
    seq: change.seq,
    at: change.at,
    types: change.types.map((x) => x.type),
    ...(category ? { category } : {}),
    task: {
      id: t.id,
      title: t.title,
      state: t.state,
      next_actor: t.next_actor,
      ...(t.area ? { area: t.area } : {}),
    },
    actor: {
      ...(change.actor.user ? { user: change.actor.user } : {}),
      ...(change.actor.agent ? { agent: change.actor.agent } : {}),
    },
    watched,
  };
}

async function visibleTasks(
  db: Database,
  p: Principal,
  events: FeedEvent[],
): Promise<Map<string, Task>> {
  const ids = [...new Set(events.map((e) => e.task?.id).filter((x): x is string => !!x))];
  if (ids.length === 0) return new Map();
  const r = await db.query(
    `SELECT * FROM tasks t WHERE id = ANY($2::text[]) AND ${visibleSql("t", 1)}`,
    [p.userId, ids],
  );
  return new Map(r.rows.map((row) => [row.id as string, taskFromRow(row)]));
}

const PAGE = 200;

/**
 * Changes after `after` that touch any of `watches`, reading whole pages of the feed until at
 * least `limit` are found (so it may return a page's worth more). The cursor moves past
 * everything examined, matching or not, so a caller resumes without rescanning; like the feed,
 * it only ever moves past events this principal can see.
 */
export async function watchedChanges(
  db: Database,
  p: Principal,
  watches: Watch[],
  after: number,
  limit = 100,
): Promise<{ changes: WatchedChange[]; cursor: number }> {
  let cursor = after;
  const out: WatchedChange[] = [];
  for (;;) {
    const page = await listChanges(db, p, String(cursor), PAGE);
    if (page.events.length === 0) break;
    const full = page.events.length === PAGE;
    // A full page may end partway through one write's events; those wait for the next page.
    const events = full ? withoutTrailingWrite(page.events) : page.events;
    const tasks = await visibleTasks(db, p, events);
    for (const change of changesOf(events, tasks)) {
      if (ownChange(change, p)) continue;
      const watched = watches.filter((w) => touches(w, change)).map((w) => w.uri);
      if (watched.length > 0) out.push(describe(change, p, watched));
    }
    cursor = (events.at(-1) as FeedEvent).seq;
    if (!full || out.length >= limit) break;
  }
  return { changes: out, cursor };
}

export async function latestCursor(db: Database, p: Principal): Promise<number> {
  return Number((await listChanges(db, p, "latest")).cursor);
}

/**
 * Wait up to `waitMs` for a change touching `watches`. Woken by the same notifications as the
 * web UI's live pages, so it answers as soon as the write commits.
 */
export async function waitForChanges(
  app: App,
  p: Principal,
  watches: Watch[],
  after: number,
  waitMs: number,
  limit: number,
  signal?: AbortSignal,
): Promise<{ changes: WatchedChange[]; cursor: number }> {
  let moved = false;
  let wake: (() => void) | null = null;
  const unsubscribe = app.live.subscribe(p.userId ?? "", (kind) => {
    if (kind !== "feed") return;
    moved = true;
    wake?.();
  });
  const onAbort = () => wake?.();
  signal?.addEventListener("abort", onAbort);
  const deadline = Date.now() + waitMs;
  try {
    let cursor = after;
    for (;;) {
      moved = false;
      const r = await watchedChanges(app.db, p, watches, cursor, limit);
      cursor = r.cursor;
      const left = deadline - Date.now();
      if (r.changes.length > 0 || left <= 0 || signal?.aborted) return r;
      if (!moved) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, left);
          function done() {
            clearTimeout(timer);
            wake = null;
            resolve();
          }
          wake = done;
        });
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    unsubscribe();
  }
}

/** Sessions idle this long are forgotten; a client that comes back re-initializes. */
const SESSION_IDLE_DAYS = 30;
const idleCutoff = (now: Date) => new Date(now.getTime() - SESSION_IDLE_DAYS * 86_400_000);

export interface McpSession {
  id: string;
  cursor: number;
  subscriptions: string[];
}

/**
 * MCP sessions in the database. Requests stay stateless (a fresh server each time); a session
 * only carries what outlives a request: the resources it subscribed to and how far its event
 * stream has got.
 */
export class McpSessions {
  private readonly app: App;
  /** The open event stream of each session: a newer stream replaces an older one. */
  private readonly streams = new Map<string, () => void>();

  constructor(app: App) {
    this.app = app;
  }

  async create(p: Principal): Promise<string> {
    const now = this.app.clock.now();
    await this.app.db.query("DELETE FROM mcp_sessions WHERE seen_at < $1", [idleCutoff(now)]);
    const id = `${newId()}${newId()}`;
    await this.app.db.query(
      `INSERT INTO mcp_sessions (id, user_id, agent, cursor, created_at, seen_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [id, p.userId, p.agent, await latestCursor(this.app.db, p), now],
    );
    return id;
  }

  /** The session, if it exists and belongs to this principal; touching it keeps it alive. */
  async get(p: Principal, id: string): Promise<McpSession | null> {
    const r = await this.app.db.query(
      `UPDATE mcp_sessions SET seen_at = $4
       WHERE id = $1 AND user_id IS NOT DISTINCT FROM $2 AND agent IS NOT DISTINCT FROM $3
         AND seen_at >= $5
       RETURNING id, cursor, subscriptions`,
      [id, p.userId, p.agent, this.app.clock.now(), idleCutoff(this.app.clock.now())],
    );
    const row = r.rows[0];
    return row
      ? { id: row.id, cursor: Number(row.cursor), subscriptions: row.subscriptions }
      : null;
  }

  async subscribe(id: string, uri: string): Promise<void> {
    await this.app.db.query(
      `UPDATE mcp_sessions SET subscriptions = array_append(subscriptions, $2)
       WHERE id = $1 AND NOT ($2 = ANY(subscriptions))`,
      [id, uri],
    );
  }

  async unsubscribe(id: string, uri: string): Promise<void> {
    await this.app.db.query(
      "UPDATE mcp_sessions SET subscriptions = array_remove(subscriptions, $2) WHERE id = $1",
      [id, uri],
    );
  }

  async delete(id: string): Promise<void> {
    this.streams.get(id)?.();
    await this.app.db.query("DELETE FROM mcp_sessions WHERE id = $1", [id]);
  }

  /**
   * The session's standalone SSE stream (GET /mcp): notifications/resources/updated for each
   * subscribed resource a change touches. A notification carries only the URI; the client
   * reads the resource, which goes through the visibility filter like any other request.
   * Changes made while no stream was open are reported when the next one opens.
   */
  stream(c: Context, p: Principal, session: McpSession): Response {
    const { app } = this;
    c.header("Cache-Control", "no-cache, no-transform");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      this.streams.get(session.id)?.();
      const close = () => abort.abort();
      this.streams.set(session.id, close);
      stream.onAbort(close);
      let moved = true;
      let wake: (() => void) | null = null;
      abort.signal.addEventListener("abort", () => wake?.(), { once: true });
      const unsubscribe = app.live.subscribe(p.userId ?? "", (kind) => {
        if (kind !== "feed") return;
        moved = true;
        wake?.();
      });
      const deadline = Date.now() + MAX_STREAM_MS;
      try {
        while (!abort.signal.aborted && !stream.aborted && Date.now() < deadline) {
          if (moved) {
            moved = false;
            const open = await this.deliver(p, session.id, abort.signal, async (uri) => {
              await stream.writeSSE({
                event: "message",
                data: JSON.stringify({
                  jsonrpc: "2.0",
                  method: "notifications/resources/updated",
                  params: { uri },
                }),
              });
            });
            if (!open) break;
            continue;
          }
          const woken = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(
              () => done(false),
              Math.min(HEARTBEAT_MS, deadline - Date.now()),
            );
            function done(v: boolean) {
              clearTimeout(timer);
              wake = null;
              resolve(v);
            }
            wake = () => done(true);
          });
          if (!woken && !stream.aborted) await stream.write(": ping\n\n");
        }
      } finally {
        unsubscribe();
        if (this.streams.get(session.id) === close) this.streams.delete(session.id);
      }
    });
  }

  private async deliver(
    p: Principal,
    id: string,
    superseded: AbortSignal,
    send: (uri: string) => Promise<void>,
  ): Promise<boolean> {
    for (;;) {
      const row = (
        await this.app.db.query("SELECT cursor, subscriptions FROM mcp_sessions WHERE id = $1", [
          id,
        ])
      ).rows[0];
      if (!row) return false;
      const subscriptions = row.subscriptions as string[];
      const watches: Watch[] = [];
      for (const uri of subscriptions) {
        try {
          watches.push(await parseWatch(this.app, p, uri));
        } catch (err) {
          // A watched task that has since turned private stops firing, as if it were gone.
          if (!(err instanceof NotFoundError)) throw err;
        }
      }
      const r = await watchedChanges(this.app.db, p, watches, Number(row.cursor), Infinity);
      const uris = new Set(r.changes.flatMap((ch) => ch.watched));
      for (const uri of uris) await send(uri);
      // A stream replaced mid-delivery may have been writing to a connection already gone;
      // leave the cursor for its replacement, which then sends these again.
      if (superseded.aborted) return false;
      if (r.cursor === Number(row.cursor)) return true;
      // Only move the cursor past what these subscriptions were checked against: if one was
      // added meanwhile, check again from the same place so its first change isn't skipped.
      const moved = await this.app.db.query(
        "UPDATE mcp_sessions SET cursor = $2 WHERE id = $1 AND subscriptions = $3::text[]",
        [id, r.cursor, subscriptions],
      );
      if (moved.rowCount) return true;
    }
  }
}

/** Comment line sent on an idle stream, well inside common proxy idle timeouts (60s). */
const HEARTBEAT_MS = 25_000;
/** Streams end after this long and the client reconnects, re-checking its credentials. */
const MAX_STREAM_MS = 30 * 60_000;
