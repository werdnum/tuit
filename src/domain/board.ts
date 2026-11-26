import type { Clock } from "../clock.ts";
import type { Database } from "../db/db.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors.ts";
import { type FeedPage, listChanges, notifyLive } from "./feed.ts";
import {
  addEvent,
  newId,
  openPartsSql,
  parentSql,
  type TaskService,
  type UserInfo,
  visibleSql,
} from "./tasks.ts";
import { local, localDate, momentFromColumns } from "./time.ts";
import {
  DEFAULT_PRIORITY,
  normalizeArea,
  type Principal,
  type Priority,
  priorityFromRank,
  type Task,
  taskFromRow,
} from "./types.ts";
import {
  type Assessment,
  type Attention,
  areaFilter,
  assess,
  compareBy,
  type Explanation,
  evaluateQueue,
  explainTask,
  hiddenByArea,
  inAreas,
  NO_HIDDEN_AREAS,
  parseQueueConfig,
  type QueueConfig,
  type QueueItem,
  type QueueResult,
  queueChecks,
  statusOf,
  type TaskStatus,
  toItem,
} from "./views.ts";

/** How many tasks the day's list ("Today") is made from each morning. */
export const NOW_PLAN_SIZE = 5;
/** How many of the remaining tasks Now shows before offering more. */
export const NOW_PAGE_SIZE = 50;
// Now shows every eligible task, so as a queue it has no limit worth speaking of.
export const NOW_CONFIG: QueueConfig = parseQueueConfig({
  actor: "me_or_anyone",
  visible_limit: 200,
});
/**
 * A `limit` from a query string: a positive whole number, or "all". Anything else means the
 * default.
 */
export function nowLimit(raw: string | undefined): number | undefined {
  if (raw === "all") return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : undefined;
}

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

/** A household-wide area setting. An area nobody has changed has no record and the defaults. */
export interface AreaSetting {
  area: string;
  hidden_by_default: boolean;
  updated_at: string;
  updated_by: { user: string | null; agent: string | null };
}

/** A hidden area's tasks that would otherwise be on the person's Now. */
export interface HiddenAreaSummary {
  area: string;
  count: number;
  /** When the longest-waiting of them became the person's (or anyone's) turn. */
  oldest_since: string;
}

export const BROWSE_STATES = [
  "active",
  "open",
  "waiting",
  "closed",
  "done",
  "expired",
  "shelved",
  "all",
] as const;
export type BrowseState = (typeof BROWSE_STATES)[number];

export function parseBrowseState(raw: string | undefined): BrowseState | undefined {
  return raw && (BROWSE_STATES as readonly string[]).includes(raw)
    ? (raw as BrowseState)
    : undefined;
}

export interface BrowseItem {
  task: Task;
  assessment: Assessment | null;
}

export interface BrowseResult {
  state: BrowseState;
  area: string | null;
  q: string;
  items: BrowseItem[];
  total: number;
  more_count: number;
  areas: string[];
  has_no_area: boolean;
}

export interface NowView {
  date: string;
  /** The area this view is narrowed to, if any. */
  area: string | null;
  /** Whether that area is hidden by default (so it shows only when named, as now). */
  area_hidden: boolean;
  /**
   * Active tasks visible to the person in the narrowed area that aren't on their Now
   * (with others or agents, waiting, snoozed, resting, claimed, or held by open parts).
   */
  area_other_count: number;
  /** Areas with active tasks the person can see, for filtering. */
  areas: string[];
  /** Which of `areas` are hidden by default: their tasks show only when the area is named. */
  hidden_by_default: string[];
  /**
   * One line per hidden area holding tasks that would otherwise be on Now (unnarrowed Now only),
   * so a hidden area can't quietly pile up.
   */
  hidden_areas: HiddenAreaSummary[];
  plan: { item: QueueItem; done: boolean }[];
  new_items: QueueItem[];
  /** The other eligible tasks, beyond today's plan and what's new, in order (one page of them). */
  also: QueueItem[];
  /** How many more tasks follow `also`, for a client to page through with a larger limit. */
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

// biome-ignore lint/suspicious/noExplicitAny: raw pg row
function areaSettingFromRow(r: any): AreaSetting {
  return {
    area: r.area,
    hidden_by_default: r.hidden_by_default,
    updated_at: r.updated_at.toISOString(),
    updated_by: { user: r.updated_by_user, agent: r.updated_by_agent },
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
      `SELECT t.*, a.snoozed_until AS att_snoozed_until, a.priority AS att_priority,
         ${openPartsSql("t")}, ${parentSql("t", 1)}
       FROM tasks t LEFT JOIN attention a ON a.task_id = t.id AND a.user_id = $1::text
       WHERE t.state IN ('open', 'waiting') AND ${visibleSql("t", 1)}`,
      [p.userId],
    );
    return r.rows.map((row) => {
      const att: Attention = {
        snoozed_until: row.att_snoozed_until,
        priority: priorityFromRank(row.att_priority),
      };
      return assess(taskFromRow(row), now, att);
    });
  }

  private async users(): Promise<UserInfo[]> {
    return this.tasks.users();
  }

  // ---- Area settings

  /** Areas flagged hidden by default. Filtering only, so it needn't be limited to visible ones. */
  async hiddenAreas(): Promise<Set<string>> {
    const r = await this.db.query<{ area: string }>(
      "SELECT area FROM area_settings WHERE hidden_by_default",
    );
    return new Set(r.rows.map((x) => x.area));
  }

  /**
   * Settings for areas this person can see on a task, or that no task uses yet; an area only on
   * someone else's private tasks stays unnamed.
   */
  async areaSettings(p: Principal): Promise<AreaSetting[]> {
    const r = await this.db.query(
      `SELECT s.* FROM area_settings s
       WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.area = s.area AND ${visibleSql("t", 1)})
          OR NOT EXISTS (SELECT 1 FROM tasks t WHERE t.area = s.area)
       ORDER BY s.area`,
      [p.userId],
    );
    return r.rows.map(areaSettingFromRow);
  }

  async setArea(
    p: Principal,
    rawArea: string,
    input: { hidden_by_default: boolean; idempotency_key?: string },
  ): Promise<AreaSetting> {
    const area = normalizeArea(rawArea);
    if (!area) throw new ValidationError("Name an area");
    return this.tasks.mutate(p, input.idempotency_key, async (c, now) => {
      const r = await c.query(
        `INSERT INTO area_settings (area, hidden_by_default, updated_at, updated_by_user, updated_by_agent)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (area) DO UPDATE SET hidden_by_default = EXCLUDED.hidden_by_default,
           updated_at = EXCLUDED.updated_at, updated_by_user = EXCLUDED.updated_by_user,
           updated_by_agent = EXCLUDED.updated_by_agent
         RETURNING *`,
        [area, input.hidden_by_default, now, p.userId, p.agent],
      );
      // Open Now pages redraw with the area in or out.
      await notifyLive(c);
      return areaSettingFromRow(r.rows[0]);
    });
  }

  /** The change feed, after bringing time-driven events up to date. */
  async changes(p: Principal, after: string | undefined, limit?: number): Promise<FeedPage> {
    await this.beforeAccess();
    return listChanges(this.db, p, after, limit);
  }

  /** A task with its time-derived status for this viewer. */
  async view(p: Principal, taskId: string): Promise<{ task: Task; status: TaskStatus }> {
    const t = await this.tasks.get(p, taskId);
    const openParts = (await this.tasks.parts(p, taskId)).filter(
      (k) => k.state === "open" || k.state === "waiting",
    ).length;
    if (openParts) t.open_parts = openParts;
    if (t.parent_id && !t.deadline) {
      const r = await this.db.query(
        `SELECT deadline_date, deadline_at FROM tasks pt WHERE id = $2 AND ${visibleSql("pt", 1)}`,
        [p.userId, t.parent_id],
      );
      const d = r.rows[0]
        ? momentFromColumns(r.rows[0].deadline_date, r.rows[0].deadline_at)
        : null;
      if (d) t.parent_deadline = d;
    }
    const att = await this.tasks.attention(p, taskId);
    const a = assess(t, this.clock.now(), {
      snoozed_until: att.snoozed_until ? new Date(att.snoozed_until) : null,
      priority: att.priority,
    });
    return { task: t, status: statusOf(a) };
  }

  /** Why is (or isn't) a task in Now or a queue. */
  async explain(p: Principal, taskId: string, queueId?: string): Promise<Explanation> {
    await this.beforeAccess();
    const now = this.clock.now();
    const cfg = queueId ? (await this.getQueue(p, queueId)).config : NOW_CONFIG;
    const all = await this.assessments(p, now);
    const hidden = await this.hiddenAreas();
    let target = all.find((a) => a.task.id === taskId);
    if (!target) {
      const t = await this.tasks.get(p, taskId);
      target = assess(t, now, undefined);
    }
    return explainTask(cfg, all, target, p, now, await this.users(), hidden);
  }

  /**
   * Now for this person. While "enough for now" is on, only urgent items come back; the rest is
   * counted in `resting_count` so a client can offer "show anyway". `limit` is how many of the
   * remaining tasks (`also`) to return; the rest are counted in `more_count`.
   */
  async now(p: Principal, opts: { area?: string | null; limit?: number } = {}): Promise<NowView> {
    const view = await this.fullNow(p, opts.area ? areaFilter(opts.area) : null);
    if (!view.enough_until) {
      // Every eligible task is already loaded and ranked, so a large limit costs only the response.
      const limit = Math.max(1, opts.limit ?? NOW_PAGE_SIZE);
      return {
        ...view,
        also: view.also.slice(0, limit),
        more_count: Math.max(0, view.also.length - limit),
      };
    }
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
   * from everything that isn't hidden, so switching areas can't reshuffle the list. Tasks in an
   * area hidden by default stay eligible, so naming the area shows them, but never join the plan
   * and show unnarrowed only when urgent.
   */
  private async fullNow(p: Principal, area: string | null = null): Promise<NowView> {
    await this.beforeAccess();
    const now = this.clock.now();
    const users = await this.users();
    const all = await this.assessments(p, now);
    const hidden = await this.hiddenAreas();
    const today = planDay(now);
    const eligible = all
      .filter((a) => onNow(a, p, now))
      .sort(compareBy(NOW_CONFIG.order, NOW_CONFIG, now));
    const byId = new Map(eligible.map((a) => [a.task.id, a]));
    const isHidden = (t: Task) => hiddenByArea(NOW_CONFIG, t, hidden);
    // P2 tasks stay on Now, at the bottom, but are never picked for the day's plan.
    const planCandidates = () =>
      eligible
        .filter((a) => !isHidden(a.task) && a.priority !== "P2")
        .slice(0, NOW_PLAN_SIZE)
        .map((a) => a.task.id);

    let plan: PlanRow | undefined;
    // Only the person themself fixes their day's list; an agent peeking at Now mustn't.
    if (p.userId && !p.agent) {
      const r = await this.db.query<PlanRow>(
        "SELECT task_ids, seen_ids, enough_until FROM day_plans WHERE user_id = $1 AND local_date = $2",
        [p.userId, today],
      );
      plan = r.rows[0];
      if (!plan) {
        const ids = planCandidates();
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
    const planIds = [...new Set(plan?.task_ids ?? planCandidates())];
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
    // The plan fixes which tasks are on today's list, not their order: open ones follow the
    // current ranking, so a priority or a deadline coming close moves them, and ticked ones sink.
    const planView: NowView["plan"] = [
      ...planIds
        .flatMap((id) => byId.get(id) ?? [])
        .sort(compareBy(NOW_CONFIG.order, NOW_CONFIG, now))
        .map((a) => ({ item: toItem(a, now, users), done: false })),
      ...planIds
        .flatMap((id) => finished.get(id) ?? [])
        .map((t) => ({ item: toItem(assess(t, now, undefined), now, users), done: true })),
    ];
    const inPlan = new Set(planIds);
    const rest = eligible.filter((a) => !inPlan.has(a.task.id));
    // A P2 task sorts last, so it never shows as new above everything else.
    const fresh = rest.filter((a) => !seen.has(a.task.id) && a.priority !== "P2");
    const freshIds = new Set(fresh.map((a) => a.task.id));
    // Only what the lists will really show: a hidden-area task left out of them must still be
    // able to show as urgent.
    const listed = (t: Task) => area !== null || !isHidden(t);
    const shownIds = new Set([
      ...planView.filter((x) => !x.done && listed(x.item.task)).map((x) => x.item.task.id),
      ...fresh.filter((a) => listed(a.task)).map((a) => a.task.id),
    ]);

    const urgent = all
      .filter((a) => a.urgent && !shownIds.has(a.task.id))
      .filter((a) => {
        const t = a.task;
        const mine = t.next_actor.kind === "user" && t.next_actor.user === p.userId;
        return mine || t.next_actor.kind === "anyone" || t.owner === p.userId || !p.userId;
      })
      .sort(compareBy(["urgency"], NOW_CONFIG, now));

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
    const inArea = (t: Task) => (area === null ? !isHidden(t) : inAreas(t, [area]));
    const areas = areaRows.rows.map((r) => r.area);
    const hiddenAreas: HiddenAreaSummary[] = [];
    if (area === null) {
      for (const h of areas.filter((a) => hidden.has(a))) {
        const since = eligible
          .filter((a) => a.task.area === h)
          .map((a) => a.task.actor_since)
          .sort();
        if (since[0]) hiddenAreas.push({ area: h, count: since.length, oldest_since: since[0] });
      }
    }
    const planInArea = planView.filter((x) => inArea(x.item.task));
    const freshInArea = fresh.filter((a) => inArea(a.task));
    const alsoInArea = rest.filter((a) => !freshIds.has(a.task.id) && !a.urgent && inArea(a.task));
    const urgentInArea = urgent.filter((a) => area === null || inAreas(a.task, [area]));
    let areaOtherCount = 0;
    if (area !== null) {
      const shownInArea = new Set([
        ...planInArea.filter((x) => !x.done).map((x) => x.item.task.id),
        ...freshInArea.map((a) => a.task.id),
        ...alsoInArea.map((a) => a.task.id),
        ...urgentInArea.map((a) => a.task.id),
      ]);
      areaOtherCount = all.filter(
        (a) => inAreas(a.task, [area]) && !shownInArea.has(a.task.id),
      ).length;
    }
    return {
      date: today,
      area,
      area_hidden: area !== null && hidden.has(area),
      area_other_count: areaOtherCount,
      areas,
      hidden_by_default: areas.filter((a) => hidden.has(a)),
      hidden_areas: hiddenAreas,
      plan: planInArea,
      new_items: freshInArea.map((a) => toItem(a, now, users)),
      // Urgent ones already show in the urgent list, which is built from everything.
      also: alsoInArea.map((a) => toItem(a, now, users)),
      more_count: 0,
      // Urgent always shows, hidden area or not.
      urgent: urgentInArea.map((a) => toItem(a, now, users)),
      enough_until:
        plan?.enough_until && plan.enough_until > now ? plan.enough_until.toISOString() : null,
      waiting_count: waiting,
      resting_count: 0,
      away,
    };
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
   * Set this person's priority for a task. P0 is an explicit "this one first", so it also puts
   * the task on today's list if one has been made, where it then sorts first. P2 is never on the
   * day's plan, so it leaves today's list.
   */
  async setPriority(p: Principal, id: string, priority: Priority): Promise<void> {
    const now = this.clock.now();
    const day = planDay(now);
    // Only a task Now would show goes to the top: one finished today would come back ticked.
    const eligible =
      priority === "P0" &&
      (await this.assessments(p, now)).some((a) => a.task.id === id && onNow(a, p, now));
    await this.tasks.setPriority(p, id, priority, async (c, userId) => {
      if (eligible) {
        await c.query(
          `UPDATE day_plans SET task_ids = array_prepend($3::text, array_remove(task_ids, $3::text)),
             seen_ids = array_append(array_remove(seen_ids, $3::text), $3::text)
           WHERE user_id = $1 AND local_date = $2`,
          [userId, day, id],
        );
      } else if (priority === "P2") {
        await c.query(
          `UPDATE day_plans SET task_ids = array_remove(task_ids, $3::text)
           WHERE user_id = $1 AND local_date = $2`,
          [userId, day, id],
        );
      }
    });
  }

  /**
   * The pin, as the iOS app still sends it: pinning sets P0, and unpinning a P0 task sets P1
   * (unpinning anything else leaves its priority alone).
   */
  async pin(p: Principal, id: string, pinned: boolean): Promise<void> {
    if (pinned) return this.setPriority(p, id, "P0");
    if ((await this.tasks.attention(p, id)).priority === "P0") {
      await this.setPriority(p, id, DEFAULT_PRIORITY);
    }
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
      await this.hiddenAreas(),
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
      await this.hiddenAreas(),
    );
  }

  /**
   * Everything visible to the person — regardless of whose turn it is, snooze, resting or
   * hidden-by-default areas — optionally filtered by state, area, and search text.
   */
  async browse(
    p: Principal,
    opts: { q?: string; state?: BrowseState; area?: string | null; limit?: number } = {},
  ): Promise<BrowseResult> {
    await this.beforeAccess();
    const now = this.clock.now();
    const q = (opts.q ?? "").trim();
    const state: BrowseState = opts.state ?? (q ? "all" : "active");
    const area = opts.area ? areaFilter(opts.area) : null;
    const limit = Math.max(1, opts.limit ?? NOW_PAGE_SIZE);

    const statesFor = (s: BrowseState): string[] | undefined => {
      if (s === "active") return ["open", "waiting"];
      if (s === "closed") return ["done", "expired", "shelved"];
      if (s === "all") return undefined;
      return [s];
    };
    const isActiveOnly = state === "active" || state === "open" || state === "waiting";
    const isClosedOnly =
      state === "closed" || state === "done" || state === "expired" || state === "shelved";
    const targetStates = statesFor(state);
    const areaInfo = await this.tasks.areas(p, isActiveOnly ? ["open", "waiting"] : undefined);

    const browseCfg = parseQueueConfig({ actor: "all" });
    const cmpActive = compareBy(["urgency", "priority", "target", "oldest"], browseCfg, now);
    const cmpClosed = (a: Task, b: Task) =>
      (b.closed_at ?? b.updated_at).localeCompare(a.closed_at ?? a.updated_at);

    let items: BrowseItem[];
    if (q) {
      const matched = await this.tasks.search(p, q, {
        states: targetStates,
        area: area ?? undefined,
        limit: 200,
      });
      const hasActive = matched.some((t) => t.state === "open" || t.state === "waiting");
      const activeById = hasActive
        ? new Map((await this.assessments(p, now)).map((a) => [a.task.id, a]))
        : new Map<string, Assessment>();
      items = matched.map((t) => ({ task: t, assessment: activeById.get(t.id) ?? null }));
    } else if (isActiveOnly) {
      const wanted = new Set(targetStates);
      items = (await this.assessments(p, now))
        .filter((a) => wanted.has(a.task.state) && (area === null || inAreas(a.task, [area])))
        .sort(cmpActive)
        .map((a) => ({ task: a.task, assessment: a }));
    } else if (isClosedOnly) {
      const closed = await this.tasks.list(p, targetStates, { area: area ?? undefined });
      closed.sort(cmpClosed);
      items = closed.map((task) => ({ task, assessment: null }));
    } else {
      const active = (await this.assessments(p, now))
        .filter((a) => area === null || inAreas(a.task, [area]))
        .sort(cmpActive)
        .map((a) => ({ task: a.task, assessment: a }));
      const closed = await this.tasks.list(p, ["done", "expired", "shelved"], {
        area: area ?? undefined,
      });
      closed.sort(cmpClosed);
      items = [...active, ...closed.map((task) => ({ task, assessment: null }))];
    }

    const shown = items.slice(0, limit);
    return {
      state,
      area,
      q,
      items: shown,
      total: items.length,
      more_count: Math.max(0, items.length - shown.length),
      areas: areaInfo.areas,
      has_no_area: areaInfo.hasNoArea,
    };
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

// Hidden areas are left out where Now is shown, not here, so naming an area still finds them.
function onNow(a: Assessment, p: Principal, now: Date): boolean {
  return (
    queueChecks(NOW_CONFIG, a, p, now, NO_HIDDEN_AREAS).every((c) => c.ok) ||
    (a.claim_lapsed && a.task.owner === p.userId)
  );
}
