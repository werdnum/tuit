import type { Clock } from "../clock.ts";
import type { Database } from "../db/db.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors.ts";
import { type FeedPage, listChanges, notifyLive } from "./feed.ts";
import { addEvent, newId, type TaskService, type UserInfo, visibleSql } from "./tasks.ts";
import { local, localDate } from "./time.ts";
import { type Principal, type Task, taskFromRow } from "./types.ts";
import {
  type Assessment,
  type Attention,
  areaFilter,
  assess,
  compareBy,
  type Explanation,
  evaluateQueue,
  explainTask,
  inAreas,
  parseQueueConfig,
  type QueueConfig,
  type QueueItem,
  type QueueResult,
  queueChecks,
  statusOf,
  type TaskStatus,
  toItem,
} from "./views.ts";

export const NOW_LIMIT = 5;
export const NOW_CONFIG: QueueConfig = parseQueueConfig({
  actor: "me_or_anyone",
  visible_limit: NOW_LIMIT,
});
/** "Enough for now" lasts until this local hour tomorrow. */
const DAY_STARTS_AT_HOUR = 4;

export interface Queue {
  id: string;
  name: string;
  owner: string;
  visibility: "household" | "private";
  enabled: boolean;
  config: QueueConfig;
  revision: number;
  created_at: string;
  updated_at: string;
  created_by_agent: string | null;
}

export interface NowView {
  date: string;
  /** The area this view is narrowed to, if any. */
  area: string | null;
  /** Areas with active tasks the person can see, for filtering. */
  areas: string[];
  plan: { item: QueueItem; done: boolean }[];
  new_items: QueueItem[];
  /** When narrowed to an area: its other eligible tasks, beyond today's plan. */
  also: QueueItem[];
  more_count: number;
  urgent: QueueItem[];
  enough_until: string | null;
  waiting_count: number;
  /** Items hidden because "enough for now" is on. */
  resting_count: number;
  away: { since: string; expired: number; handed_to_you: number; became_due: number } | null;
}

// biome-ignore lint/suspicious/noExplicitAny: raw pg row
function queueFromRow(r: any): Queue {
  return {
    id: r.id,
    name: r.name,
    owner: r.owner_id,
    visibility: r.visibility,
    enabled: r.enabled,
    config: parseQueueConfig(r.config),
    revision: r.revision,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    created_by_agent: r.created_by_agent,
  };
}

interface PlanRow {
  task_ids: string[];
  seen_ids: string[];
  enough_until: Date | null;
}

/** The list's day starts at 4am local time, so a late night still belongs to the day before. */
function planDay(at: Date): string {
  return localDate(new Date(at.getTime() - DAY_STARTS_AT_HOUR * 3_600_000));
}

export class Board {
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly tasks: TaskService;
  private readonly beforeAccess: () => Promise<void>;

  constructor(db: Database, clock: Clock, tasks: TaskService, beforeAccess: () => Promise<void>) {
    this.db = db;
    this.clock = clock;
    this.tasks = tasks;
    this.beforeAccess = beforeAccess;
  }

  async assessments(p: Principal, now: Date): Promise<Assessment[]> {
    const r = await this.db.query(
      `SELECT t.*, a.snoozed_until AS att_snoozed_until, a.pinned AS att_pinned
       FROM tasks t LEFT JOIN attention a ON a.task_id = t.id AND a.user_id = $1::text
       WHERE t.state IN ('open', 'waiting') AND ${visibleSql("t", 1)}`,
      [p.userId],
    );
    return r.rows.map((row) => {
      const att: Attention = {
        snoozed_until: row.att_snoozed_until,
        pinned: row.att_pinned ?? false,
      };
      return assess(taskFromRow(row), now, att);
    });
  }

  private async users(): Promise<UserInfo[]> {
    return this.tasks.users();
  }

  /** The change feed, after bringing time-driven events up to date. */
  async changes(p: Principal, after: string | undefined, limit?: number): Promise<FeedPage> {
    await this.beforeAccess();
    return listChanges(this.db, p, after, limit);
  }

  /** A task with its time-derived status for this viewer. */
  async view(p: Principal, taskId: string): Promise<{ task: Task; status: TaskStatus }> {
    const t = await this.tasks.get(p, taskId);
    const att = await this.tasks.attention(p, taskId);
    const a = assess(t, this.clock.now(), {
      snoozed_until: att.snoozed_until ? new Date(att.snoozed_until) : null,
      pinned: att.pinned,
    });
    return { task: t, status: statusOf(a) };
  }

  /** Why is (or isn't) a task in Now or a queue. */
  async explain(p: Principal, taskId: string, queueId?: string): Promise<Explanation> {
    await this.beforeAccess();
    const now = this.clock.now();
    const cfg = queueId ? (await this.getQueue(p, queueId)).config : NOW_CONFIG;
    const all = await this.assessments(p, now);
    let target = all.find((a) => a.task.id === taskId);
    if (!target) {
      const t = await this.tasks.get(p, taskId);
      target = assess(t, now, undefined);
    }
    return explainTask(cfg, all, target, p, now, await this.users());
  }

  /**
   * Now for this person. While "enough for now" is on, only urgent items come back; the rest is
   * counted in `resting_count` so a client can offer "show anyway".
   */
  async now(p: Principal, opts: { area?: string | null } = {}): Promise<NowView> {
    const view = await this.fullNow(p, opts.area ? areaFilter(opts.area) : null);
    if (!view.enough_until) return view;
    const hidden = [
      ...view.plan.filter((x) => !x.done).map((x) => x.item),
      ...view.new_items,
      ...view.also,
    ];
    // Urgent items already in the list must not disappear along with it.
    const urgent = [...hidden.filter((i) => i.urgent), ...view.urgent];
    return {
      ...view,
      plan: [],
      new_items: [],
      also: [],
      more_count: 0,
      urgent,
      resting_count: hidden.filter((i) => !i.urgent).length,
    };
  }

  /**
   * Narrowing to an area filters what is shown; it never changes the day's plan, which is made
   * from everything, so switching areas can't reshuffle the list.
   */
  private async fullNow(p: Principal, area: string | null = null): Promise<NowView> {
    await this.beforeAccess();
    const now = this.clock.now();
    const users = await this.users();
    const all = await this.assessments(p, now);
    const today = planDay(now);
    const eligible = all
      .filter((a) => onNow(a, p, now))
      .sort(compareBy(NOW_CONFIG.order, NOW_CONFIG, p, now));
    const byId = new Map(eligible.map((a) => [a.task.id, a]));

    let plan: PlanRow | undefined;
    // Only the person themself fixes their day's list; an agent peeking at Now mustn't.
    if (p.userId && !p.agent) {
      const r = await this.db.query<PlanRow>(
        "SELECT task_ids, seen_ids, enough_until FROM day_plans WHERE user_id = $1 AND local_date = $2",
        [p.userId, today],
      );
      plan = r.rows[0];
      if (!plan) {
        const ids = eligible.slice(0, NOW_LIMIT).map((a) => a.task.id);
        await this.db.query(
          `INSERT INTO day_plans (user_id, local_date, task_ids, seen_ids, created_at) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id, local_date) DO NOTHING`,
          [p.userId, today, ids, eligible.map((a) => a.task.id), now],
        );
        const again = await this.db.query<PlanRow>(
          "SELECT task_ids, seen_ids, enough_until FROM day_plans WHERE user_id = $1 AND local_date = $2",
          [p.userId, today],
        );
        plan = again.rows[0];
      }
    }
    const planIds = [
      ...new Set(plan?.task_ids ?? eligible.slice(0, NOW_LIMIT).map((a) => a.task.id)),
    ];
    const seen = new Set(plan?.seen_ids ?? eligible.map((a) => a.task.id));

    const missing = planIds.filter((id) => !byId.has(id));
    const finished = new Map<string, Task>();
    if (missing.length) {
      const r = await this.db.query(
        `SELECT * FROM tasks t WHERE id = ANY($2) AND ${visibleSql("t", 1)}`,
        [p.userId, missing],
      );
      for (const row of r.rows) {
        const t = taskFromRow(row);
        const doneToday =
          (t.state === "done" && planDay(new Date(t.updated_at)) === today) ||
          (!!t.recurrence &&
            !!t.last_done_at &&
            planDay(new Date(t.updated_at)) === today &&
            planDay(new Date(t.last_done_at)) === today);
        if (doneToday) finished.set(t.id, t);
      }
    }
    const planView: NowView["plan"] = [];
    for (const id of planIds) {
      const a = byId.get(id);
      if (a) planView.push({ item: toItem(a, p, now, users), done: false });
      else {
        const t = finished.get(id);
        if (t)
          planView.push({ item: toItem(assess(t, now, undefined), p, now, users), done: true });
      }
    }
    const inPlan = new Set(planIds);
    const rest = eligible.filter((a) => !inPlan.has(a.task.id));
    const fresh = rest.filter((a) => !seen.has(a.task.id));
    const freshIds = new Set(fresh.map((a) => a.task.id));
    const shownIds = new Set([
      ...planView.filter((x) => !x.done).map((x) => x.item.task.id),
      ...freshIds,
    ]);

    const urgent = all
      .filter((a) => a.urgent && !shownIds.has(a.task.id))
      .filter((a) => {
        const t = a.task;
        const mine = t.next_actor.kind === "user" && t.next_actor.user === p.userId;
        return mine || t.next_actor.kind === "anyone" || t.owner === p.userId || !p.userId;
      })
      .sort(compareBy(["urgency"], NOW_CONFIG, p, now));

    const waiting = all.filter(
      (a) =>
        a.task.state === "waiting" &&
        ((a.task.next_actor.kind === "user" && a.task.next_actor.user === p.userId) ||
          a.task.owner === p.userId),
    ).length;

    let away: NowView["away"] = null;
    if (p.userId) {
      const u = await this.db.query<{ last_seen_at: Date | null }>(
        "SELECT last_seen_at FROM now_seen WHERE principal = $1",
        [p.key],
      );
      const lastSeen = u.rows[0]?.last_seen_at;
      if (lastSeen && now.getTime() - lastSeen.getTime() > 3 * 86_400_000) {
        const ev = await this.db.query<{
          type: string;
          data: { to?: { user?: string } };
          n: number;
        }>(
          `SELECT e.type, e.data, count(*)::int AS n FROM events e JOIN tasks t ON t.id = e.task_id
           WHERE e.at > $2 AND ${visibleSql("t", 1)}
             AND e.type IN ('expired', 'handed_off', 'routine_due', 'routine_stale')
           GROUP BY e.type, e.data`,
          [p.userId, lastSeen],
        );
        const count = (pred: (r: (typeof ev.rows)[number]) => boolean) =>
          ev.rows.filter(pred).reduce((s, r) => s + r.n, 0);
        away = {
          since: lastSeen.toISOString(),
          expired: count((r) => r.type === "expired"),
          handed_to_you: count((r) => r.type === "handed_off" && r.data.to?.user === p.userId),
          became_due: count((r) => r.type === "routine_due" || r.type === "routine_stale"),
        };
      }
      await this.db.query(
        `INSERT INTO now_seen (principal, last_seen_at) VALUES ($1, $2)
         ON CONFLICT (principal) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at`,
        [p.key, now],
      );
    }

    const areaRows = await this.db.query<{ area: string }>(
      `SELECT DISTINCT area FROM tasks t WHERE state IN ('open', 'waiting') AND area IS NOT NULL
         AND ${visibleSql("t", 1)} ORDER BY area`,
      [p.userId],
    );
    const inArea = (t: Task) => area === null || inAreas(t, [area]);
    return {
      date: today,
      area,
      areas: areaRows.rows.map((r) => r.area),
      plan: planView.filter((x) => inArea(x.item.task)),
      new_items: fresh.filter((a) => inArea(a.task)).map((a) => toItem(a, p, now, users)),
      also:
        area === null
          ? []
          : rest
              // Urgent ones already show in the urgent list, which is built from everything.
              .filter((a) => !freshIds.has(a.task.id) && !a.urgent && inArea(a.task))
              .map((a) => toItem(a, p, now, users)),
      more_count: area === null ? rest.length - fresh.length : 0,
      urgent: urgent.filter((a) => inArea(a.task)).map((a) => toItem(a, p, now, users)),
      enough_until:
        plan?.enough_until && plan.enough_until > now ? plan.enough_until.toISOString() : null,
      waiting_count: waiting,
      resting_count: 0,
      away,
    };
  }

  /** Explicitly pull the next few items into today's plan. */
  async showMore(p: Principal, count = 3): Promise<void> {
    if (!p.userId || p.agent) throw new ForbiddenError("Only the person can change their own list");
    const view = await this.fullNow(p);
    const now = this.clock.now();
    const planIds = view.plan.map((x) => x.item.task.id);
    const taken = new Set([...planIds, ...view.new_items.map((i) => i.task.id)]);
    const all = await this.assessments(p, now);
    const next = all
      .filter((a) => !taken.has(a.task.id) && queueChecks(NOW_CONFIG, a, p, now).every((c) => c.ok))
      .sort(compareBy(NOW_CONFIG.order, NOW_CONFIG, p, now))
      .slice(0, count)
      .map((a) => a.task.id);
    // Appending only ids not already present keeps concurrent "show more" taps from duplicating.
    // One transaction, so the notification goes out exactly when the change commits.
    const userId = p.userId;
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE day_plans
       SET task_ids = task_ids || ARRAY(SELECT x FROM unnest($3::text[]) x WHERE NOT x = ANY(task_ids)),
           seen_ids = seen_ids || $3::text[],
           enough_until = NULL
       WHERE user_id = $1 AND local_date = $2`,
        [p.userId, view.date, [...view.new_items.map((i) => i.task.id), ...next]],
      );
      await notifyLive(c, userId);
    });
  }

  async enoughForNow(p: Principal, on: boolean): Promise<string | null> {
    if (!p.userId || p.agent) throw new ForbiddenError("Only the person can change their own list");
    const view = await this.fullNow(p);
    const now = this.clock.now();
    let until: Date | null = null;
    if (on) {
      const l = local(now);
      const base = l.hour < DAY_STARTS_AT_HOUR ? l : l.plus({ days: 1 });
      until = base
        .set({ hour: DAY_STARTS_AT_HOUR, minute: 0, second: 0, millisecond: 0 })
        .toJSDate();
    }
    // One transaction, so the notification goes out exactly when the change commits.
    const userId = p.userId;
    await this.db.tx(async (c) => {
      await c.query(
        "UPDATE day_plans SET enough_until = $3 WHERE user_id = $1 AND local_date = $2",
        [p.userId, view.date, until],
      );
      await notifyLive(c, userId);
    });
    return until ? until.toISOString() : null;
  }

  /**
   * Pin (or unpin) a task for this person. Pinning is an explicit "this one first", so it also
   * moves the task to the top of today's list if one has been made; unpinning leaves it in place.
   */
  async pin(p: Principal, id: string, pinned: boolean): Promise<void> {
    const now = this.clock.now();
    const day = planDay(now);
    // Only a task Now would show goes to the top: one finished today would come back ticked.
    const eligible =
      pinned && (await this.assessments(p, now)).some((a) => a.task.id === id && onNow(a, p, now));
    await this.tasks.pin(p, id, pinned, async (c, userId) => {
      if (!eligible) return;
      await c.query(
        `UPDATE day_plans SET task_ids = array_prepend($3::text, array_remove(task_ids, $3::text)),
           seen_ids = array_append(array_remove(seen_ids, $3::text), $3::text)
         WHERE user_id = $1 AND local_date = $2`,
        [userId, day, id],
      );
    });
  }

  // ---- Queues ----

  private queueVisible = "(q.visibility = 'household' OR q.owner_id = $1::text)";

  async listQueues(p: Principal): Promise<Queue[]> {
    const r = await this.db.query(
      `SELECT * FROM queues q WHERE ${this.queueVisible} ORDER BY enabled DESC, name`,
      [p.userId],
    );
    return r.rows.map(queueFromRow);
  }

  async getQueue(p: Principal, id: string): Promise<Queue> {
    const r = await this.db.query(`SELECT * FROM queues q WHERE id = $2 AND ${this.queueVisible}`, [
      p.userId,
      id,
    ]);
    if (!r.rows[0]) throw new NotFoundError(`No queue ${id}`);
    return queueFromRow(r.rows[0]);
  }

  async saveQueue(
    p: Principal,
    input: {
      id?: string;
      name?: string;
      visibility?: "household" | "private";
      enabled?: boolean;
      config?: unknown;
      expected_revision?: number;
      idempotency_key?: string;
    },
  ): Promise<Queue> {
    return this.tasks.mutate(p, input.idempotency_key, async (c, now) => {
      if (!input.id) {
        if (!input.name?.trim()) throw new ValidationError("A queue needs a name");
        const q: Queue = {
          id: newId(),
          name: input.name.trim(),
          owner: p.userId as string,
          visibility: input.visibility ?? "household",
          enabled: input.enabled ?? true,
          config: parseQueueConfig(input.config),
          revision: 1,
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
          created_by_agent: p.agent,
        };
        await c.query(
          `INSERT INTO queues (id, name, owner_id, visibility, enabled, config, revision, created_at, updated_at, created_by_agent)
           VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $7, $8)`,
          [q.id, q.name, q.owner, q.visibility, q.enabled, JSON.stringify(q.config), now, p.agent],
        );
        await addEvent(c, p, "queue_created", { queueId: q.id }, now);
        return q;
      }
      const r = await c.query(
        `SELECT * FROM queues q WHERE id = $2 AND ${this.queueVisible} FOR UPDATE`,
        [p.userId, input.id],
      );
      if (!r.rows[0]) throw new NotFoundError(`No queue ${input.id}`);
      const q = queueFromRow(r.rows[0]);
      if (input.expected_revision !== undefined && input.expected_revision !== q.revision) {
        throw new ConflictError(`Queue changed since revision ${input.expected_revision}`, q);
      }
      if (input.visibility && input.visibility !== q.visibility && q.owner !== p.userId) {
        throw new ForbiddenError("Only the queue's owner can change its visibility");
      }
      const next: Queue = {
        ...q,
        name: input.name?.trim() || q.name,
        visibility: input.visibility ?? q.visibility,
        enabled: input.enabled ?? q.enabled,
        config: input.config !== undefined ? parseQueueConfig(input.config) : q.config,
        revision: q.revision + 1,
        updated_at: now.toISOString(),
      };
      await c.query(
        "UPDATE queues SET name = $2, visibility = $3, enabled = $4, config = $5, revision = $6, updated_at = $7 WHERE id = $1",
        [
          q.id,
          next.name,
          next.visibility,
          next.enabled,
          JSON.stringify(next.config),
          next.revision,
          now,
        ],
      );
      await addEvent(c, p, "queue_updated", { queueId: q.id }, now);
      return next;
    });
  }

  async runQueue(p: Principal, id: string): Promise<{ queue: Queue; result: QueueResult }> {
    await this.beforeAccess();
    const queue = await this.getQueue(p, id);
    const now = this.clock.now();
    const result = evaluateQueue(
      queue.config,
      await this.assessments(p, now),
      p,
      now,
      await this.users(),
    );
    return { queue, result };
  }

  async previewQueue(p: Principal, config: unknown): Promise<QueueResult> {
    await this.beforeAccess();
    const now = this.clock.now();
    return evaluateQueue(
      parseQueueConfig(config),
      await this.assessments(p, now),
      p,
      now,
      await this.users(),
    );
  }

  /** Queues (enabled ones, plus Now) where this task currently appears, for the inspect view. */
  async membership(
    p: Principal,
    taskId: string,
  ): Promise<{ queue: string; id: string | null; explanation: Explanation }[]> {
    const out: { queue: string; id: string | null; explanation: Explanation }[] = [
      { queue: "Now", id: null, explanation: await this.explain(p, taskId) },
    ];
    for (const q of await this.listQueues(p)) {
      if (!q.enabled) continue;
      out.push({ queue: q.name, id: q.id, explanation: await this.explain(p, taskId, q.id) });
    }
    return out;
  }
}

function onNow(a: Assessment, p: Principal, now: Date): boolean {
  return (
    queueChecks(NOW_CONFIG, a, p, now).every((c) => c.ok) ||
    (a.claim_lapsed && a.task.owner === p.userId)
  );
}
