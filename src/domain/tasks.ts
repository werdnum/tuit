import { randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import type pg from "pg";
import type { z } from "zod";
import type { Clock } from "../clock.ts";
import type { Database, Queryable } from "../db/db.ts";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors.ts";
import {
  addDays,
  isDate,
  local,
  type Moment,
  momentStart,
  momentToColumns,
  toMoment,
  ZONE,
} from "./time.ts";
import {
  type ActivityEntry,
  type Actor,
  type ActorInput,
  activityFromRow,
  CheckpointInput,
  CLOSED_STATES,
  type ClaimInput,
  CloseInput,
  CompleteInput,
  CreateTaskInput,
  type OffsetRule,
  type Principal,
  type Task,
  taskFromRow,
  UpdateTaskInput,
} from "./types.ts";
import { assess } from "./views.ts";

export function newId(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(8);
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

/** SQL predicate: may this principal see task alias `t`? `$n` must bind principal.userId. */
export function visibleSql(alias: string, param: number): string {
  return `(${alias}.visibility = 'household' OR ${alias}.owner_id = $${param}::text)`;
}

export interface UserInfo {
  id: string;
  name: string;
  email: string;
}

const TASK_COLUMNS = [
  "title",
  "brief",
  "next_action",
  "done_means",
  "owner_id",
  "visibility",
  "actor_kind",
  "actor_user",
  "actor_agent",
  "actor_since",
  "state",
  "close_reason",
  "closed_at",
  "waiting_kind",
  "waiting_for",
  "waiting_task_id",
  "waiting_since",
  "follow_up_date",
  "follow_up_at",
  "available_from_date",
  "available_from_at",
  "available_rule",
  "target_date",
  "target_at",
  "target_rule",
  "deadline_date",
  "deadline_at",
  "expires_date",
  "expires_at",
  "requires",
  "prefers",
  "recurrence",
  "last_done_at",
  "last_skip_at",
  "claim_id",
  "claim_agent",
  "claim_user",
  "claim_expires_at",
  "claim_side_effects",
  "revision",
  "updated_at",
] as const;

function taskColumns(t: Task): unknown[] {
  const [fuDate, fuAt] = momentToColumns(t.waiting?.follow_up ?? null);
  const [afDate, afAt] = momentToColumns(t.available_from);
  const [tDate, tAt] = momentToColumns(t.target);
  const [dDate, dAt] = momentToColumns(t.deadline);
  const [eDate, eAt] = momentToColumns(t.expires);
  return [
    t.title,
    t.brief,
    t.next_action,
    t.done_means,
    t.owner,
    t.visibility,
    t.next_actor.kind,
    t.next_actor.kind === "user" ? t.next_actor.user : null,
    t.next_actor.kind === "agent" ? t.next_actor.agent : null,
    t.actor_since,
    t.state,
    t.close_reason,
    t.closed_at,
    t.waiting?.kind ?? null,
    t.waiting?.for ?? "",
    t.waiting?.task_id ?? null,
    t.waiting?.since ?? null,
    fuDate,
    fuAt,
    afDate,
    afAt,
    t.available_rule ? JSON.stringify(t.available_rule) : null,
    tDate,
    tAt,
    t.target_rule ? JSON.stringify(t.target_rule) : null,
    dDate,
    dAt,
    eDate,
    eAt,
    t.requires,
    t.prefers,
    t.recurrence ? JSON.stringify(t.recurrence) : null,
    t.last_done_at,
    t.last_skip_at,
    t.claim?.id ?? null,
    t.claim?.agent ?? null,
    t.claim?.user ?? null,
    t.claim?.expires_at ?? null,
    t.claim?.side_effects ?? false,
    t.revision,
    t.updated_at,
  ];
}

export async function writeTask(c: Queryable, t: Task): Promise<void> {
  const sets = TASK_COLUMNS.map((col, i) => `${col} = $${i + 2}`).join(", ");
  await c.query(`UPDATE tasks SET ${sets} WHERE id = $1`, [t.id, ...taskColumns(t)]);
}

async function insertTask(c: Queryable, t: Task): Promise<void> {
  const cols = ["id", "created_at", "created_by_user", "created_by_agent", ...TASK_COLUMNS];
  const values = [t.id, t.created_at, t.created_by.user, t.created_by.agent, ...taskColumns(t)];
  const ph = values.map((_, i) => `$${i + 1}`).join(", ");
  const r = await c.query<{ seq: number }>(
    `INSERT INTO tasks (${cols.join(", ")}) VALUES (${ph}) RETURNING seq`,
    values,
  );
  t.seq = r.rows[0]?.seq ?? 0;
}

export async function addActivity(
  c: Queryable,
  p: Principal | null,
  taskId: string,
  kind: string,
  body: string,
  now: Date,
  opts: { data?: Record<string, unknown>; happenedAt?: Date } = {},
): Promise<void> {
  await c.query(
    `INSERT INTO activity (task_id, kind, body, data, happened_at, recorded_at, author_user, author_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      taskId,
      kind,
      body,
      JSON.stringify(opts.data ?? {}),
      opts.happenedAt ?? now,
      now,
      p?.userId ?? null,
      p?.agent ?? null,
    ],
  );
}

export async function addEvent(
  c: Queryable,
  p: Principal | null,
  type: string,
  ids: { taskId?: string; queueId?: string },
  now: Date,
  data: Record<string, unknown> = {},
): Promise<void> {
  // Serialise event writers until commit so seq order equals commit order; otherwise a feed
  // reader could see seq N+1 before a slower transaction commits N, and skip N forever.
  await c.query("SELECT pg_advisory_xact_lock(4242003)");
  await c.query(
    `INSERT INTO events (type, task_id, queue_id, at, data, actor_user, actor_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      type,
      ids.taskId ?? null,
      ids.queueId ?? null,
      now,
      JSON.stringify(data),
      p?.userId ?? null,
      p?.agent ?? null,
    ],
  );
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function actorLabel(a: Actor, users: UserInfo[]): string {
  if (a.kind === "anyone") return "anyone";
  if (a.kind === "agent") return `agent:${a.agent}`;
  return users.find((u) => u.id === a.user)?.name ?? a.user;
}

export function recomputeDerivedDates(t: Task): void {
  const anchorOf = (rule: OffsetRule): Moment | null =>
    rule.anchor === "deadline" ? t.deadline : t.expires;
  if (t.available_rule) {
    const a = anchorOf(t.available_rule);
    t.available_from = a ? addDays(a, t.available_rule.offset_days) : null;
  }
  if (t.target_rule) {
    const a = anchorOf(t.target_rule);
    t.target = a ? addDays(a, t.target_rule.offset_days) : null;
  }
}

/** "Thursday" as a completion time means that day; record it at local noon. */
function completionInstant(m: Moment): Date {
  if (isDate(m)) return DateTime.fromISO(m.date, { zone: ZONE }).set({ hour: 12 }).toJSDate();
  return new Date(m.at);
}

export class TaskService {
  readonly db: Database;
  readonly clock: Clock;
  private readonly beforeAccess: () => Promise<void>;

  constructor(db: Database, clock: Clock, beforeAccess: () => Promise<void>) {
    this.db = db;
    this.clock = clock;
    this.beforeAccess = beforeAccess;
  }

  async users(): Promise<UserInfo[]> {
    return (await this.db.query<UserInfo>("SELECT id, name, email FROM users ORDER BY id")).rows;
  }

  async resolveActor(input: z.infer<typeof ActorInput>, p: Principal): Promise<Actor> {
    if (typeof input !== "string") {
      if (input.kind === "user") return this.resolveActor(input.user, p);
      if (input.kind === "agent") return this.resolveActor(`agent:${input.agent}`, p);
      return { kind: "anyone" };
    }
    const s = input.trim();
    const lower = s.toLowerCase();
    if (lower === "anyone" || lower === "anyone-capable") return { kind: "anyone" };
    if (lower === "me") {
      if (!p.userId) throw new ValidationError("A display token has no 'me'");
      return { kind: "user", user: p.userId };
    }
    if (lower.startsWith("agent:")) {
      const agent = s.slice(6).trim();
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(agent)) throw new ValidationError(`Bad agent "${agent}"`);
      return { kind: "agent", agent };
    }
    const users = await this.users();
    const u = users.find(
      (x) => x.id === lower || x.name.toLowerCase() === lower || x.email.toLowerCase() === lower,
    );
    if (!u) {
      throw new ValidationError(
        `Unknown actor "${s}". Use "me", "anyone", "agent:<name>" or one of: ${users.map((x) => x.id).join(", ")}`,
      );
    }
    return { kind: "user", user: u.id };
  }

  private requireWriter(p: Principal): string {
    if (!p.canWrite || !p.userId) throw new ForbiddenError("This credential is read-only");
    return p.userId;
  }

  /**
   * Run a mutation in one transaction, replaying the stored result when the same principal
   * repeats an idempotency key.
   */
  async mutate<T>(
    p: Principal,
    idempotencyKey: string | undefined,
    body: (c: pg.PoolClient, now: Date) => Promise<T>,
  ): Promise<T> {
    this.requireWriter(p);
    await this.beforeAccess();
    const now = this.clock.now();
    return this.db.tx(async (c) => {
      if (idempotencyKey) {
        await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `${p.key}\n${idempotencyKey}`,
        ]);
        const prior = await c.query<{ response: T }>(
          "SELECT response FROM idempotency WHERE principal = $1 AND key = $2",
          [p.key, idempotencyKey],
        );
        if (prior.rows[0]) return prior.rows[0].response;
      }
      const result = await body(c, now);
      if (idempotencyKey) {
        await c.query(
          "INSERT INTO idempotency (principal, key, response, created_at) VALUES ($1, $2, $3, $4)",
          [p.key, idempotencyKey, JSON.stringify(result), now],
        );
      }
      return result;
    });
  }

  private async lockTask(
    c: Queryable,
    p: Principal,
    id: string,
    expectedRevision: number | undefined,
  ): Promise<Task> {
    const r = await c.query(
      `SELECT * FROM tasks t WHERE id = $1 AND ${visibleSql("t", 2)} FOR UPDATE`,
      [id, p.userId],
    );
    if (!r.rows[0]) throw new NotFoundError(`No task ${id}`);
    const t = taskFromRow(r.rows[0]);
    if (expectedRevision !== undefined && expectedRevision !== t.revision) {
      throw new ConflictError(
        `Task ${id} changed since revision ${expectedRevision} (now ${t.revision}). Re-read it and retry.`,
        t,
      );
    }
    return t;
  }

  private bump(t: Task, now: Date): void {
    t.revision += 1;
    t.updated_at = now.toISOString();
  }

  private checkHandoffAllowed(t: Task, actor: Actor): void {
    if (t.visibility === "private" && actor.kind === "user" && actor.user !== t.owner) {
      throw new ValidationError(
        "This task is private. Make it household-visible before handing it to someone else.",
      );
    }
    if (t.visibility === "private" && actor.kind === "anyone") {
      throw new ValidationError("A private task can't be handed to 'anyone'.");
    }
  }

  private async applyActorChange(c: Queryable, t: Task, actor: Actor, now: Date): Promise<boolean> {
    if (sameJson(actor, t.next_actor)) return false;
    this.checkHandoffAllowed(t, actor);
    t.next_actor = actor;
    t.actor_since = now.toISOString();
    if (t.claim && !(actor.kind === "agent" && actor.agent === t.claim.agent)) t.claim = null;
    if (actor.kind === "user") {
      await c.query(
        "UPDATE attention SET snoozed_until = NULL WHERE user_id = $1 AND task_id = $2",
        [actor.user, t.id],
      );
    }
    return true;
  }

  async get(p: Principal, id: string): Promise<Task> {
    await this.beforeAccess();
    const r = await this.db.query(`SELECT * FROM tasks t WHERE id = $1 AND ${visibleSql("t", 2)}`, [
      id,
      p.userId,
    ]);
    if (!r.rows[0]) throw new NotFoundError(`No task ${id}`);
    return taskFromRow(r.rows[0]);
  }

  async activity(p: Principal, id: string): Promise<ActivityEntry[]> {
    await this.get(p, id);
    const r = await this.db.query(
      `SELECT a.* FROM activity a JOIN tasks t ON t.id = a.task_id
       WHERE a.task_id = $1 AND ${visibleSql("t", 2)} ORDER BY a.happened_at, a.id`,
      [id, p.userId],
    );
    return r.rows.map(activityFromRow);
  }

  async attention(
    p: Principal,
    taskId: string,
  ): Promise<{ snoozed_until: string | null; pinned: boolean }> {
    if (!p.userId) return { snoozed_until: null, pinned: false };
    const r = await this.db.query<{ snoozed_until: Date | null; pinned: boolean }>(
      "SELECT snoozed_until, pinned FROM attention WHERE user_id = $1 AND task_id = $2",
      [p.userId, taskId],
    );
    const row = r.rows[0];
    return {
      snoozed_until: row?.snoozed_until ? row.snoozed_until.toISOString() : null,
      pinned: row?.pinned ?? false,
    };
  }

  async create(p: Principal, raw: unknown): Promise<Task> {
    const input = CreateTaskInput.parse(raw);
    const userId = this.requireWriter(p);
    const actor = input.next_actor
      ? await this.resolveActor(input.next_actor, p)
      : ({ kind: "user", user: userId } as Actor);
    return this.mutate(p, input.idempotency_key, async (c, now) => {
      const nowIso = now.toISOString();
      const t: Task = {
        id: newId(),
        seq: 0,
        title: input.title.trim(),
        brief: input.brief ?? "",
        next_action: input.next_action ?? "",
        done_means: input.done_means ?? "",
        owner: userId,
        visibility: input.visibility ?? "household",
        next_actor: actor,
        actor_since: nowIso,
        state: "open",
        close_reason: "",
        closed_at: null,
        waiting: null,
        available_from: toMoment(input.available_from, now),
        available_rule: input.available_rule ?? null,
        target: toMoment(input.target, now),
        target_rule: input.target_rule ?? null,
        deadline: toMoment(input.deadline, now),
        expires: toMoment(input.expires, now),
        requires: input.requires ?? [],
        prefers: input.prefers ?? [],
        recurrence: input.recurrence ?? null,
        last_done_at: null,
        last_skip_at: null,
        claim: null,
        revision: 1,
        created_at: nowIso,
        updated_at: nowIso,
        created_by: { user: p.userId, agent: p.agent },
      };
      this.checkHandoffAllowed(t, actor);
      recomputeDerivedDates(t);
      if (input.last_done) {
        if (!t.recurrence) throw new ValidationError("last_done only applies to routines");
        t.last_done_at = completionInstant(toMoment(input.last_done, now) as Moment).toISOString();
      }
      await insertTask(c, t);
      await addActivity(c, p, t.id, "created", "", now);
      if (t.last_done_at) {
        await addActivity(c, p, t.id, "completion", "Recorded when created", now, {
          happenedAt: new Date(t.last_done_at),
        });
      }
      await addEvent(c, p, "created", { taskId: t.id }, now);
      return t;
    });
  }

  async update(p: Principal, id: string, raw: unknown): Promise<Task> {
    const input = UpdateTaskInput.parse(raw);
    const actor = input.next_actor ? await this.resolveActor(input.next_actor, p) : undefined;
    return this.mutate(p, input.idempotency_key, async (c, now) => {
      const t = await this.lockTask(c, p, id, input.expected_revision);
      const before = structuredClone(t);
      if (input.visibility !== undefined && input.visibility !== t.visibility) {
        if (t.owner !== p.userId) throw new ForbiddenError("Only the owner can change visibility");
        t.visibility = input.visibility;
        if (t.visibility === "private") this.checkHandoffAllowed(t, t.next_actor);
      }
      if (input.title !== undefined) t.title = input.title.trim();
      if (input.brief !== undefined) t.brief = input.brief;
      if (input.next_action !== undefined) t.next_action = input.next_action;
      if (input.done_means !== undefined) t.done_means = input.done_means;
      if (input.requires !== undefined) t.requires = input.requires;
      if (input.prefers !== undefined) t.prefers = input.prefers;
      if (input.recurrence !== undefined) t.recurrence = input.recurrence;
      if (input.deadline !== undefined) t.deadline = toMoment(input.deadline, now);
      if (input.expires !== undefined) t.expires = toMoment(input.expires, now);
      if (input.available_from !== undefined) {
        t.available_from = toMoment(input.available_from, now);
        t.available_rule = null;
      }
      if (input.target !== undefined) {
        t.target = toMoment(input.target, now);
        t.target_rule = null;
      }
      if (input.available_rule !== undefined) t.available_rule = input.available_rule;
      if (input.target_rule !== undefined) t.target_rule = input.target_rule;
      recomputeDerivedDates(t);
      const handedOff = actor ? await this.applyActorChange(c, t, actor, now) : false;

      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of Object.keys(t) as (keyof Task)[]) {
        if (!sameJson(before[k], t[k])) changed[k] = { from: before[k], to: t[k] };
      }
      delete changed.actor_since;
      delete changed.claim;
      if (Object.keys(changed).length === 0) return t;
      this.bump(t, now);
      await writeTask(c, t);
      await addActivity(c, p, t.id, "edit", `Changed ${Object.keys(changed).join(", ")}`, now, {
        data: { changes: changed },
      });
      if (handedOff)
        await addEvent(c, p, "handed_off", { taskId: t.id }, now, { to: t.next_actor });
      await addEvent(c, p, "updated", { taskId: t.id }, now, { fields: Object.keys(changed) });
      return t;
    });
  }

  /**
   * Append progress and move the task on in one transaction: the note and the change of hands
   * (or state) either both happen or neither does.
   */
  async checkpoint(p: Principal, id: string, raw: unknown): Promise<Task> {
    const input = CheckpointInput.parse(raw);
    if (p.agent && input.next_actor === undefined) {
      throw new ValidationError(
        "Agents must say whose turn it is next: pass next_actor (use your own agent:<name> to keep it).",
      );
    }
    const actor = input.next_actor ? await this.resolveActor(input.next_actor, p) : undefined;
    return this.mutate(p, input.idempotency_key, async (c, now) => {
      const t = await this.lockTask(c, p, id, input.expected_revision);
      const wasClosed = CLOSED_STATES.includes(t.state);
      const stateBefore = t.state;
      if (input.brief !== undefined) t.brief = input.brief;
      if (input.next_action !== undefined) t.next_action = input.next_action;
      const handedOff = actor ? await this.applyActorChange(c, t, actor, now) : false;

      const targetState = input.state ?? (input.waiting ? "waiting" : undefined);
      if (targetState === "waiting") {
        const w = input.waiting;
        if (!w) throw new ValidationError("state 'waiting' needs a waiting condition");
        const followUp = toMoment(w.follow_up, now);
        if (p.agent && t.next_actor.kind === "user" && w.kind === "reply" && !followUp) {
          // Otherwise an agent could park work "with Alex" where Alex would never see it.
          throw new ValidationError(
            "Handing a person a task that is waiting for a reply needs follow_up, so it resurfaces for them. If they need to act now, leave it open.",
          );
        }
        if (w.kind === "until" && !followUp) {
          throw new ValidationError(
            "waiting kind 'until' needs follow_up (when it becomes actionable)",
          );
        }
        if (w.kind === "task") {
          if (!w.task_id) throw new ValidationError("waiting kind 'task' needs task_id");
          if (w.task_id === t.id) throw new ValidationError("A task can't wait on itself");
          const dep = await c.query(
            `SELECT state, visibility FROM tasks t WHERE id = $1 AND ${visibleSql("t", 2)}`,
            [w.task_id, p.userId],
          );
          if (!dep.rows[0]) throw new NotFoundError(`No task ${w.task_id}`);
          if (dep.rows[0].visibility === "private" && t.visibility === "household") {
            throw new ValidationError(
              "A household task can't wait on a private one: it would reveal that task",
            );
          }
        }
        t.state = "waiting";
        t.waiting = {
          kind: w.kind,
          for: w.for ?? "",
          task_id: w.kind === "task" ? (w.task_id ?? null) : null,
          since: now.toISOString(),
          follow_up: followUp,
        };
      } else if (targetState === "open") {
        t.state = "open";
        t.waiting = null;
      }
      if (targetState && wasClosed) {
        t.closed_at = null;
        t.close_reason = "";
      }
      if (input.release_claim || (t.claim && targetState === "waiting")) t.claim = null;

      if (input.resurface_in_days) {
        const who = t.next_actor.kind === "user" ? t.next_actor.user : (p.userId as string);
        await c.query(
          `INSERT INTO attention (user_id, task_id, snoozed_until) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, task_id) DO UPDATE SET snoozed_until = EXCLUDED.snoozed_until`,
          [who, t.id, new Date(now.getTime() + input.resurface_in_days * 86_400_000)],
        );
      }

      this.bump(t, now);
      await writeTask(c, t);
      await addActivity(c, p, t.id, input.kind ?? "note", input.note, now, {
        data: {
          ...(handedOff ? { handed_to: t.next_actor } : {}),
          ...(t.state !== stateBefore ? { state: { from: stateBefore, to: t.state } } : {}),
          ...(t.waiting && t.state !== stateBefore ? { waiting: t.waiting } : {}),
          ...(input.next_action !== undefined ? { next_action: t.next_action } : {}),
          ...(input.brief !== undefined ? { brief_updated: true } : {}),
        },
      });
      await addEvent(c, p, "checkpoint", { taskId: t.id }, now, { kind: input.kind ?? "note" });
      if (handedOff)
        await addEvent(c, p, "handed_off", { taskId: t.id }, now, { to: t.next_actor });
      if (t.state !== stateBefore) {
        await addEvent(c, p, "state_changed", { taskId: t.id }, now, {
          from: stateBefore,
          to: t.state,
        });
      }
      return t;
    });
  }

  async complete(p: Principal, id: string, raw: unknown): Promise<Task> {
    const input = CompleteInput.parse(raw ?? {});
    return this.mutate(p, input.idempotency_key, async (c, now) => {
      const t = await this.lockTask(c, p, id, input.expected_revision);
      const at = input.at ? (toMoment(input.at, now) as Moment) : null;
      const happened = at ? completionInstant(at) : now;
      if (at && isDate(at) && at.date === local(now).toISODate()) {
        // "today" without a time means now, not noon.
        happened.setTime(Math.min(happened.getTime(), now.getTime()));
      }
      if (happened.getTime() > now.getTime() + 5 * 60_000) {
        throw new ValidationError("Completion time is in the future");
      }
      if (t.recurrence) {
        if (CLOSED_STATES.includes(t.state)) {
          throw new ValidationError(`This routine is ${t.state}; reopen it first`);
        }
        const prev = t.last_done_at ? new Date(t.last_done_at) : null;
        if (!prev || happened > prev) t.last_done_at = happened.toISOString();
        t.state = "open";
        t.waiting = null;
      } else {
        if (t.state === "done") return t;
        t.state = "done";
        t.closed_at = happened.toISOString();
        t.close_reason = "";
        t.waiting = null;
      }
      t.claim = null;
      this.bump(t, now);
      await writeTask(c, t);
      await addActivity(c, p, t.id, "completion", input.note ?? "", now, {
        happenedAt: happened,
        data: at ? { reported_as: at } : {},
      });
      await addEvent(c, p, "completed", { taskId: t.id }, now, {
        at: happened.toISOString(),
        recurring: !!t.recurrence,
      });
      return t;
    });
  }

  async skip(p: Principal, id: string, raw: unknown): Promise<Task> {
    const input = (raw ?? {}) as {
      note?: string;
      idempotency_key?: string;
      expected_revision?: number;
    };
    return this.mutate(p, input.idempotency_key, async (c, now) => {
      const t = await this.lockTask(c, p, id, input.expected_revision);
      if (!t.recurrence) throw new ValidationError("Only routines can be skipped");
      t.last_skip_at = now.toISOString();
      this.bump(t, now);
      await writeTask(c, t);
      await addActivity(c, p, t.id, "skip", input.note ?? "", now);
      await addEvent(c, p, "skipped", { taskId: t.id }, now);
      return t;
    });
  }

  async close(p: Principal, id: string, raw: unknown): Promise<Task> {
    const input = CloseInput.parse(raw);
    return this.mutate(p, input.idempotency_key, async (c, now) => {
      const t = await this.lockTask(c, p, id, input.expected_revision);
      if (t.state === input.state) return t;
      const from = t.state;
      t.state = input.state;
      t.close_reason = input.reason ?? "";
      t.closed_at = now.toISOString();
      t.waiting = null;
      t.claim = null;
      this.bump(t, now);
      await writeTask(c, t);
      const verb = input.state === "expired" ? "No longer relevant" : "Shelved";
      await addActivity(
        c,
        p,
        t.id,
        "state_change",
        input.reason ? `${verb}: ${input.reason}` : verb,
        now,
        {
          data: { state: { from, to: t.state } },
        },
      );
      await addEvent(
        c,
        p,
        input.state === "expired" ? "expired" : "state_changed",
        { taskId: t.id },
        now,
        {
          from,
          to: t.state,
        },
      );
      return t;
    });
  }

  async reopen(p: Principal, id: string, raw: unknown): Promise<Task> {
    const input = (raw ?? {}) as { idempotency_key?: string; expected_revision?: number };
    return this.mutate(p, input.idempotency_key, async (c, now) => {
      const t = await this.lockTask(c, p, id, input.expected_revision);
      if (t.state === "open") return t;
      const from = t.state;
      t.state = "open";
      t.waiting = null;
      t.closed_at = null;
      t.close_reason = "";
      this.bump(t, now);
      await writeTask(c, t);
      await addActivity(c, p, t.id, "state_change", "Reopened", now, {
        data: { state: { from, to: "open" } },
      });
      await addEvent(c, p, "state_changed", { taskId: t.id }, now, { from, to: "open" });
      return t;
    });
  }

  async snooze(p: Principal, id: string, until: Moment | string | null): Promise<string | null> {
    const userId = this.requireWriter(p);
    await this.get(p, id);
    const now = this.clock.now();
    const m = toMoment(until, now);
    const at = m ? momentStart(m) : null;
    if (at && at <= now) throw new ValidationError("Snooze time must be in the future");
    await this.db.query(
      `INSERT INTO attention (user_id, task_id, snoozed_until) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, task_id) DO UPDATE SET snoozed_until = EXCLUDED.snoozed_until`,
      [userId, id, at],
    );
    return at ? at.toISOString() : null;
  }

  async pin(p: Principal, id: string, pinned: boolean): Promise<void> {
    const userId = this.requireWriter(p);
    await this.get(p, id);
    await this.db.query(
      `INSERT INTO attention (user_id, task_id, pinned) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, task_id) DO UPDATE SET pinned = EXCLUDED.pinned`,
      [userId, id, pinned],
    );
  }

  /**
   * Atomically take the next eligible task handed to this agent. Selection (being in a queue)
   * is not permission; this is the dispatch step, and it records who holds the work.
   */
  async claim(p: Principal, input: ClaimInput): Promise<Task | null> {
    if (!p.agent) throw new ValidationError("Only agent credentials can claim work");
    return this.mutate(p, input.idempotency_key, async (c, now) => {
      const eligible = `state = 'open' AND actor_kind = 'agent' AND actor_agent = $1
        AND claim_id IS NULL AND ${visibleSql("t", 2)}`;
      const r = await c.query(
        `SELECT * FROM tasks t WHERE ${eligible} ${input.task_id ? "AND id = $3" : ""}
         ORDER BY actor_since, id`,
        input.task_id ? [p.agent, p.userId, input.task_id] : [p.agent, p.userId],
      );
      const candidates = r.rows.map(taskFromRow).filter((x) => assess(x, now, undefined).available);
      // Lock one row at a time: locking every candidate would make a concurrent claimer skip
      // them all and come back empty while work remains.
      let t: Task | undefined;
      for (const cand of candidates) {
        const locked = await c.query(
          `SELECT * FROM tasks t WHERE id = $3 AND ${eligible} FOR UPDATE SKIP LOCKED`,
          [p.agent, p.userId, cand.id],
        );
        if (locked.rows[0]) {
          t = taskFromRow(locked.rows[0]);
          break;
        }
      }
      if (!t) return null;
      t.claim = {
        id: newId(),
        agent: p.agent as string,
        user: p.userId,
        expires_at: new Date(now.getTime() + (input.lease_minutes ?? 30) * 60_000).toISOString(),
        // Unless told otherwise, assume the work may touch the outside world, so a lapsed
        // claim is reviewed by a person instead of silently retried.
        side_effects: input.side_effects ?? true,
      };
      this.bump(t, now);
      await writeTask(c, t);
      await addActivity(c, p, t.id, "system", `Claimed by agent:${p.agent}`, now, {
        data: { claim: t.claim },
      });
      await addEvent(c, p, "claimed", { taskId: t.id }, now, { agent: p.agent });
      return t;
    });
  }

  /**
   * Release a claim. Only the claiming agent, or a person (not some other agent), may do it; a
   * `claimId` makes a retried release harmless once a different worker holds the task.
   */
  async releaseClaim(p: Principal, id: string, claimId?: string): Promise<Task> {
    return this.mutate(p, undefined, async (c, now) => {
      const t = await this.lockTask(c, p, id, undefined);
      if (!t.claim || (claimId && t.claim.id !== claimId)) return t;
      const isClaimer = p.agent === t.claim.agent && p.userId === t.claim.user;
      if (p.agent && !isClaimer) {
        throw new ForbiddenError(
          `agent:${t.claim.agent} holds this task; only it or a person can release it`,
        );
      }
      const was = t.claim;
      t.claim = null;
      this.bump(t, now);
      await writeTask(c, t);
      await addActivity(c, p, t.id, "system", `Released claim by agent:${was.agent}`, now, {
        data: { claim: was },
      });
      await addEvent(c, p, "claim_released", { taskId: t.id }, now);
      return t;
    });
  }

  /** Text search over everything the caller can see, including closed tasks and notes. */
  async search(
    p: Principal,
    text: string,
    opts: { includeClosed?: boolean; limit?: number } = {},
  ): Promise<Task[]> {
    await this.beforeAccess();
    const like = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const r = await this.db.query(
      `SELECT * FROM tasks t
       WHERE ${visibleSql("t", 1)}
         ${opts.includeClosed === false ? "AND state IN ('open','waiting')" : ""}
         AND (title ILIKE $2 OR brief ILIKE $2 OR next_action ILIKE $2 OR waiting_for ILIKE $2
              OR EXISTS (SELECT 1 FROM activity a WHERE a.task_id = t.id AND a.body ILIKE $2))
       ORDER BY (state IN ('open','waiting')) DESC, updated_at DESC
       LIMIT $3`,
      [p.userId, like, opts.limit ?? 50],
    );
    return r.rows.map(taskFromRow);
  }

  /** All tasks visible to the caller, optionally filtered by state. */
  async list(p: Principal, states?: string[]): Promise<Task[]> {
    await this.beforeAccess();
    const r = await this.db.query(
      `SELECT * FROM tasks t WHERE ${visibleSql("t", 1)} ${states ? "AND state = ANY($2)" : ""}
       ORDER BY created_at`,
      states ? [p.userId, states] : [p.userId],
    );
    return r.rows.map(taskFromRow);
  }
}
