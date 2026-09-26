import type { Database } from "../db/db.ts";
import { ValidationError } from "./errors.ts";
import { visibleSql } from "./tasks.ts";
import type { Principal } from "./types.ts";

const VISIBLE_EVENT = `((e.task_id IS NOT NULL AND ${visibleSql("t", 1)})
  OR (e.queue_id IS NOT NULL AND (q.visibility = 'household' OR q.owner_id = $1::text)))`;

export interface FeedEvent {
  seq: number;
  type: string;
  at: string;
  task: { id: string; title: string; state: string; visibility: string } | null;
  queue: { id: string; name: string } | null;
  actor: { user: string | null; agent: string | null };
  data: Record<string, unknown>;
}

export interface FeedPage {
  events: FeedEvent[];
  cursor: string;
}

/**
 * Cursor-based change feed. Visibility is evaluated against each task's *current* visibility at
 * read time; events carry no title snapshot, so nothing private is ever stored in a form that
 * could escape the filter.
 */
export async function listChanges(
  db: Database,
  p: Principal,
  after: string | undefined,
  limit = 100,
): Promise<FeedPage> {
  if (after === "latest") {
    const r = await db.query<{ seq: number | null }>(
      `SELECT max(e.seq) AS seq FROM events e
       LEFT JOIN tasks t ON t.id = e.task_id LEFT JOIN queues q ON q.id = e.queue_id
       WHERE ${VISIBLE_EVENT}`,
      [p.userId],
    );
    return { events: [], cursor: String(r.rows[0]?.seq ?? 0) };
  }
  const afterSeq = after ? Number(after) : 0;
  if (!Number.isInteger(afterSeq) || afterSeq < 0) throw new ValidationError("Bad cursor");
  const r = await db.query(
    `SELECT e.*, t.title, t.state, t.visibility, q.name AS queue_name
     FROM events e
     LEFT JOIN tasks t ON t.id = e.task_id
     LEFT JOIN queues q ON q.id = e.queue_id
     WHERE e.seq > $2
       AND ((e.task_id IS NOT NULL AND ${visibleSql("t", 1)})
         OR (e.queue_id IS NOT NULL AND (q.visibility = 'household' OR q.owner_id = $1::text)))
     ORDER BY e.seq
     LIMIT $3`,
    [p.userId, afterSeq, Math.min(Math.max(limit, 1), 500)],
  );
  const events: FeedEvent[] = r.rows.map((row) => ({
    seq: row.seq,
    type: row.type,
    at: row.at.toISOString(),
    task: row.task_id
      ? { id: row.task_id, title: row.title, state: row.state, visibility: row.visibility }
      : null,
    queue: row.queue_id ? { id: row.queue_id, name: row.queue_name } : null,
    actor: { user: row.actor_user, agent: row.actor_agent },
    data: row.data,
  }));
  // The cursor only ever moves past events this caller can see, so it can't reveal that
  // hidden activity happened.
  const cursor = events.at(-1)?.seq ?? afterSeq;
  return { events, cursor: String(cursor) };
}
