import { DateTime } from "luxon";
import { z } from "zod";
import { ValidationError } from "./errors.ts";
import { actorLabel, type UserInfo } from "./tasks.ts";
import {
  daysBetween,
  describeAgo,
  describeMoment,
  describeUntil,
  local,
  momentEnd,
  momentStart,
  ZONE,
} from "./time.ts";
import type { Principal, Task } from "./types.ts";

export const URGENT_DEADLINE_HOURS = 48;
export const URGENT_EXPIRY_HOURS = 24;

export const ORDER_RULES = [
  "pinned",
  "urgency",
  "recent_handoff",
  "target",
  "staleness",
  "preferred_context",
  "oldest",
] as const;
export type OrderRule = (typeof ORDER_RULES)[number];
export const DEFAULT_ORDER: OrderRule[] = [...ORDER_RULES];

export const COMPUTED_CONTEXTS: Record<string, (now: Date) => boolean> = {
  business_hours: (now) => {
    const l = local(now);
    return l.weekday <= 5 && l.hour >= 9 && l.hour < 17;
  },
  evening: (now) => {
    const h = local(now).hour;
    return h >= 17 && h < 22;
  },
  weekend: (now) => local(now).weekday >= 6,
};

export const QueueConfig = z
  .object({
    /** "me_or_anyone" (default), "me", "anyone", "all", a user id, or "agent:<name>". */
    actor: z.string().default("me_or_anyone"),
    /** Show waiting tasks too (a wait whose follow-up has arrived always shows). */
    include_waiting: z.boolean().default(false),
    /** Show tasks that are snoozed, resting routines, or not yet available. */
    include_resting: z.boolean().default(false),
    /**
     * Contexts this queue offers (e.g. ["computer"]). Requirements not offered exclude a task.
     * Omit to ignore non-time requirements. Time contexts (business_hours, evening, weekend)
     * are computed from the clock unless listed here.
     */
    contexts: z.array(z.string()).optional(),
    /** Only tasks that require at least one of these contexts. */
    only_requiring: z.array(z.string()).optional(),
    text: z.string().optional(),
    recurring: z.enum(["only", "exclude"]).optional(),
    owner: z.enum(["me"]).optional(),
    visibility: z.enum(["household", "private"]).optional(),
    order: z.array(z.enum(ORDER_RULES)).default(DEFAULT_ORDER),
    visible_limit: z.number().int().min(1).max(200).default(10),
  })
  .strict();
export type QueueConfig = z.infer<typeof QueueConfig>;

export interface Attention {
  snoozed_until: Date | null;
  pinned: boolean;
}

export interface Assessment {
  task: Task;
  /** Open and not held back by available_from or a resting routine. Ignores snooze. */
  available: boolean;
  /** Why it isn't available, if it isn't. */
  held: string | null;
  snoozed_until: Date | null;
  pinned: boolean;
  urgent: { kind: "deadline" | "expiry"; at: Date; label: string } | null;
  follow_up_due: boolean;
  claim_lapsed: boolean;
  routine: { due_at: Date; ratio: number; label: string; stale: boolean } | null;
  /** One short human line describing the time situation. */
  label: string;
}

function routineDueAt(t: Task): Date {
  const anchors = [t.last_done_at, t.last_skip_at].filter((x): x is string => !!x);
  if (anchors.length === 0) return new Date(t.created_at);
  const anchor = anchors.reduce((a, b) => (a > b ? a : b));
  // Day arithmetic in the household zone so DST shifts don't move the due time.
  return DateTime.fromISO(anchor, { zone: ZONE })
    .plus({ days: t.recurrence?.every_days ?? 0 })
    .toJSDate();
}

export function assess(t: Task, now: Date, att: Attention | undefined): Assessment {
  const active = t.state === "open" || t.state === "waiting";
  let held: string | null = null;
  let routine: Assessment["routine"] = null;
  if (t.recurrence) {
    const due = routineDueAt(t);
    const since = t.last_done_at ? new Date(t.last_done_at) : null;
    const ratio = since ? daysBetween(since, now) / t.recurrence.every_days : 1;
    const doneLabel = since ? `last done ${describeAgo(since, now)}` : "not done yet";
    const label =
      t.recurrence.mode === "after_completion"
        ? `${doneLabel} · every ${t.recurrence.every_days} days`
        : doneLabel;
    routine = { due_at: due, ratio, label, stale: ratio >= 1.5 };
    if (due > now) held = `resting until ${describeMoment({ at: due.toISOString() }, now)}`;
  }
  if (t.state === "open" && t.available_from && momentStart(t.available_from) > now) {
    held = `not available until ${describeMoment(t.available_from, now)}`;
  }
  if (t.state === "waiting") held = "waiting";
  if (!active) held = t.state;

  let urgent: Assessment["urgent"] = null;
  if (active && t.deadline) {
    const end = momentEnd(t.deadline);
    const hours = (end.getTime() - now.getTime()) / 3_600_000;
    if (hours <= URGENT_DEADLINE_HOURS) {
      urgent = {
        kind: "deadline",
        at: end,
        label:
          hours < 0
            ? `deadline passed ${describeAgo(end, now)}`
            : `deadline ${describeMoment(t.deadline, now)}`,
      };
    }
  }
  if (active && !urgent && t.expires) {
    const end = momentEnd(t.expires);
    if ((end.getTime() - now.getTime()) / 3_600_000 <= URGENT_EXPIRY_HOURS) {
      urgent = {
        kind: "expiry",
        at: end,
        label: `last chance: expires ${describeUntil(end, now)}`,
      };
    }
  }

  const followUp = t.waiting?.follow_up;
  const follow_up_due =
    t.state === "waiting" &&
    t.waiting?.kind === "reply" &&
    !!followUp &&
    momentStart(followUp) <= now;
  const claim_lapsed =
    !!t.claim && t.claim.side_effects && new Date(t.claim.expires_at) <= now && active;
  const snoozed = att?.snoozed_until && att.snoozed_until > now ? att.snoozed_until : null;

  let label = "";
  if (urgent) label = urgent.label;
  else if (claim_lapsed) label = `agent:${t.claim?.agent} claim lapsed — check before retrying`;
  else if (follow_up_due) {
    label = `waiting${t.waiting?.for ? ` for ${t.waiting.for}` : ""} since ${describeAgo(new Date(t.waiting?.since as string), now)} — chase?`;
  } else if (t.state === "waiting") {
    label = `waiting${t.waiting?.for ? ` for ${t.waiting.for}` : ""}`;
  } else if (routine) label = routine.label;
  else if (t.deadline) label = `deadline ${describeMoment(t.deadline, now)}`;
  else if (t.target) label = `aiming for ${describeMoment(t.target, now)}`;
  else if (t.expires) label = `until ${describeMoment(t.expires, now)}`;

  return {
    task: t,
    available: t.state === "open" && held === null,
    held,
    snoozed_until: snoozed,
    pinned: att?.pinned ?? false,
    urgent,
    follow_up_due,
    claim_lapsed,
    routine,
    label,
  };
}

export interface Check {
  check: string;
  ok: boolean;
  detail: string;
}

function actorMatches(
  cfg: QueueConfig,
  t: Task,
  viewer: Principal,
): { ok: boolean; detail: string } {
  const a = t.next_actor;
  const mine = a.kind === "user" && a.user === viewer.userId;
  const agentMine = viewer.agent !== null && a.kind === "agent" && a.agent === viewer.agent;
  const who = a.kind === "anyone" ? "anyone" : a.kind === "agent" ? `agent:${a.agent}` : a.user;
  switch (cfg.actor) {
    case "all":
      return { ok: true, detail: `next: ${who}` };
    case "me":
      return { ok: mine || agentMine, detail: `next: ${who}` };
    case "anyone":
      return { ok: a.kind === "anyone", detail: `next: ${who}` };
    case "me_or_anyone":
      return { ok: mine || agentMine || a.kind === "anyone", detail: `next: ${who}` };
    default:
      if (cfg.actor.startsWith("agent:")) {
        return { ok: a.kind === "agent" && a.agent === cfg.actor.slice(6), detail: `next: ${who}` };
      }
      return { ok: a.kind === "user" && a.user === cfg.actor, detail: `next: ${who}` };
  }
}

function contextSatisfied(cfg: QueueConfig, ctx: string, now: Date): boolean {
  if (cfg.contexts?.includes(ctx)) return true;
  const computed = COMPUTED_CONTEXTS[ctx];
  if (computed) return computed(now);
  return cfg.contexts === undefined;
}

/** Filters that also bound the urgent list: who, what text, whose, which visibility. */
function scopeChecks(cfg: QueueConfig, a: Assessment, viewer: Principal): Check[] {
  const t = a.task;
  const checks: Check[] = [];
  const actor = actorMatches(cfg, t, viewer);
  checks.push({ check: "actor", ok: actor.ok, detail: actor.detail });
  if (cfg.text) {
    const hay = `${t.title}\n${t.brief}\n${t.next_action}`.toLowerCase();
    checks.push({
      check: "text",
      ok: hay.includes(cfg.text.toLowerCase()),
      detail: `matches "${cfg.text}"`,
    });
  }
  if (cfg.owner === "me") {
    checks.push({ check: "owner", ok: t.owner === viewer.userId, detail: `owner: ${t.owner}` });
  }
  if (cfg.visibility) {
    checks.push({
      check: "visibility",
      ok: t.visibility === cfg.visibility,
      detail: `visibility: ${t.visibility}`,
    });
  }
  if (cfg.recurring) {
    const isR = !!t.recurrence;
    checks.push({
      check: "recurring",
      ok: cfg.recurring === "only" ? isR : !isR,
      detail: isR ? "is a routine" : "one-off",
    });
  }
  return checks;
}

export function queueChecks(
  cfg: QueueConfig,
  a: Assessment,
  viewer: Principal,
  now: Date,
): Check[] {
  const t = a.task;
  const checks = scopeChecks(cfg, a, viewer);
  const stateOk =
    t.state === "open" ||
    (t.state === "waiting" && (cfg.include_waiting || a.follow_up_due)) ||
    false;
  checks.push({
    check: "state",
    ok: stateOk,
    detail:
      t.state === "waiting" && a.follow_up_due ? "waiting, follow-up due" : `state: ${t.state}`,
  });
  if (!cfg.include_resting) {
    if (t.state === "open") {
      checks.push({ check: "available", ok: a.held === null, detail: a.held ?? "available now" });
    }
    checks.push({
      check: "snooze",
      ok: !a.snoozed_until,
      detail: a.snoozed_until
        ? `you snoozed it until ${describeMoment({ at: a.snoozed_until.toISOString() }, now)}`
        : "not snoozed",
    });
    if (t.claim && !a.claim_lapsed) {
      checks.push({
        check: "claim",
        ok: false,
        detail: `agent:${t.claim.agent} is working on it`,
      });
    }
  }
  if (cfg.only_requiring) {
    checks.push({
      check: "only_requiring",
      ok: t.requires.some((r) => cfg.only_requiring?.includes(r)),
      detail: `requires [${t.requires.join(", ")}]`,
    });
  }
  for (const req of t.requires) {
    checks.push({
      check: "requires",
      ok: contextSatisfied(cfg, req, now),
      detail: contextSatisfied(cfg, req, now)
        ? `needs ${req}: available`
        : `needs ${req}: not available in this queue right now`,
    });
  }
  return checks;
}

function preferenceScore(t: Task, cfg: QueueConfig, now: Date): number {
  if (t.prefers.length === 0) return 1;
  return t.prefers.every((p) => contextSatisfied({ ...cfg, contexts: cfg.contexts ?? [] }, p, now))
    ? 0
    : 2;
}

function recentHandoff(a: Assessment, viewer: Principal, now: Date): boolean {
  const t = a.task;
  const handed = t.actor_since !== t.created_at || t.created_by.user !== viewer.userId;
  return (
    t.next_actor.kind === "user" &&
    t.next_actor.user === viewer.userId &&
    handed &&
    daysBetween(new Date(t.actor_since), now) <= 3
  );
}

export function compareBy(
  rules: OrderRule[],
  cfg: QueueConfig,
  viewer: Principal,
  now: Date,
): (x: Assessment, y: Assessment) => number {
  const key = (a: Assessment, rule: OrderRule): number => {
    const t = a.task;
    switch (rule) {
      case "pinned":
        return a.pinned ? 0 : 1;
      case "urgency":
        if (a.urgent) return a.urgent.at.getTime() - 1e15;
        return t.deadline ? momentEnd(t.deadline).getTime() : Number.MAX_SAFE_INTEGER;
      case "recent_handoff":
        return recentHandoff(a, viewer, now) || a.claim_lapsed || a.follow_up_due ? 0 : 1;
      case "target":
        if (!t.target) return Number.MAX_SAFE_INTEGER;
        return momentStart(t.target).getTime() <= now.getTime()
          ? momentStart(t.target).getTime() - 1e15
          : momentStart(t.target).getTime();
      case "staleness":
        return a.routine ? -a.routine.ratio : 0;
      case "preferred_context":
        return preferenceScore(t, cfg, now);
      case "oldest":
        return t.seq;
    }
  };
  return (x, y) => {
    for (const rule of rules) {
      const d = key(x, rule) - key(y, rule);
      if (d !== 0) return d;
    }
    return x.task.seq - y.task.seq;
  };
}

/** Why an item made the list, in one phrase, following the first ordering rule that fired. */
export function whyShown(a: Assessment, viewer: Principal, now: Date, users: UserInfo[]): string {
  const t = a.task;
  if (a.pinned) return "pinned";
  if (a.urgent) return a.urgent.label;
  if (a.claim_lapsed) return a.label;
  if (a.follow_up_due) return a.label;
  if (recentHandoff(a, viewer, now))
    return `handed to you ${describeAgo(new Date(t.actor_since), now)}`;
  if (t.target && momentStart(t.target) <= now) return `target ${describeMoment(t.target, now)}`;
  if (a.routine) return a.routine.label;
  if (t.next_actor.kind === "anyone") return "anyone can do this";
  return a.label || `next: ${actorLabel(t.next_actor, users)}`;
}

export interface QueueItem {
  task: Task;
  why: string;
  label: string;
  urgent: boolean;
  stale: boolean;
  snoozed_until: string | null;
  pinned: boolean;
}

export interface QueueResult {
  items: QueueItem[];
  /** How many more matched beyond visible_limit. */
  hidden_count: number;
  /** Time-critical items, shown regardless of visible_limit and availability. */
  urgent: QueueItem[];
}

export function toItem(a: Assessment, viewer: Principal, now: Date, users: UserInfo[]): QueueItem {
  return {
    task: a.task,
    why: whyShown(a, viewer, now, users),
    label: a.label,
    urgent: !!a.urgent,
    stale: !!a.routine?.stale && a.available,
    snoozed_until: a.snoozed_until ? a.snoozed_until.toISOString() : null,
    pinned: a.pinned,
  };
}

export function evaluateQueue(
  cfg: QueueConfig,
  assessments: Assessment[],
  viewer: Principal,
  now: Date,
  users: UserInfo[],
): QueueResult {
  const cmp = compareBy(cfg.order, cfg, viewer, now);
  const matched = assessments
    .filter((a) => queueChecks(cfg, a, viewer, now).every((c) => c.ok))
    .sort(cmp);
  const shown = matched.slice(0, cfg.visible_limit);
  const shownIds = new Set(shown.map((a) => a.task.id));
  const urgent = assessments
    .filter((a) => a.urgent && !shownIds.has(a.task.id))
    .filter((a) => scopeChecks(cfg, a, viewer).every((c) => c.ok))
    .sort(compareBy(["urgency"], cfg, viewer, now));
  return {
    items: shown.map((a) => toItem(a, viewer, now, users)),
    hidden_count: matched.length - shown.length,
    urgent: urgent.map((a) => toItem(a, viewer, now, users)),
  };
}

export interface Explanation {
  task_id: string;
  verdict: "shown" | "urgent" | "beyond_limit" | "excluded";
  summary: string;
  position: number | null;
  checks: Check[];
  order: OrderRule[];
}

export function explainTask(
  cfg: QueueConfig,
  assessments: Assessment[],
  target: Assessment,
  viewer: Principal,
  now: Date,
  users: UserInfo[],
): Explanation {
  const checks = queueChecks(cfg, target, viewer, now);
  const result = evaluateQueue(cfg, assessments, viewer, now, users);
  const id = target.task.id;
  const pos = result.items.findIndex((i) => i.task.id === id);
  const failed = checks.filter((c) => !c.ok);
  if (pos >= 0) {
    return {
      task_id: id,
      verdict: "shown",
      summary: `Shown at position ${pos + 1}: ${result.items[pos]?.why}`,
      position: pos + 1,
      checks,
      order: cfg.order,
    };
  }
  if (result.urgent.some((i) => i.task.id === id)) {
    return {
      task_id: id,
      verdict: "urgent",
      summary: `Shown as urgent (outside the limit): ${target.urgent?.label}`,
      position: null,
      checks,
      order: cfg.order,
    };
  }
  if (failed.length === 0) {
    const all = assessments
      .filter((a) => queueChecks(cfg, a, viewer, now).every((c) => c.ok))
      .sort(compareBy(cfg.order, cfg, viewer, now));
    const p = all.findIndex((a) => a.task.id === id) + 1;
    return {
      task_id: id,
      verdict: "beyond_limit",
      summary: `Matches, but is number ${p} and the queue shows ${cfg.visible_limit}`,
      position: p,
      checks,
      order: cfg.order,
    };
  }
  return {
    task_id: id,
    verdict: "excluded",
    summary: `Not shown: ${failed.map((c) => c.detail).join("; ")}`,
    position: null,
    checks,
    order: cfg.order,
  };
}

export function parseQueueConfig(raw: unknown): QueueConfig {
  const r = QueueConfig.safeParse(raw ?? {});
  if (!r.success) throw new ValidationError(`Invalid queue config: ${r.error.message}`);
  return r.data;
}

export interface TaskStatus {
  available: boolean;
  held: string | null;
  label: string;
  urgent: string | null;
  follow_up_due: boolean;
  claim_lapsed: boolean;
  routine: { due_at: string; stale: boolean; label: string } | null;
  snoozed_until: string | null;
  pinned: boolean;
}

/** The time-derived status of a task for one viewer, as every interface reports it. */
export function statusOf(a: Assessment): TaskStatus {
  return {
    available: a.available,
    held: a.held,
    label: a.label,
    urgent: a.urgent?.label ?? null,
    follow_up_due: a.follow_up_due,
    claim_lapsed: a.claim_lapsed,
    routine: a.routine
      ? { due_at: a.routine.due_at.toISOString(), stale: a.routine.stale, label: a.routine.label }
      : null,
    snoozed_until: a.snoozed_until ? a.snoozed_until.toISOString() : null,
    pinned: a.pinned,
  };
}
