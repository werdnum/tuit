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
  type Moment,
  momentEnd,
  momentStart,
  ZONE,
} from "./time.ts";
import type { Principal, Task } from "./types.ts";

export const URGENT_DEADLINE_HOURS = 48;
export const URGENT_EXPIRY_HOURS = 24;

/**
 * A target missed by more than this many days stops ranking: the task sorts as if it had none,
 * so a forgotten target can't hold the top of the list for ever.
 */
export const STALE_TARGET_DAYS = 7;

/**
 * Per-person priority. Three levels only, P1 by default. Order is banded: every P0 task sorts
 * before every P1, and P1 before P2; dates and the rest sort only inside a band.
 */
export const PRIORITIES = ["P0", "P1", "P2"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const DEFAULT_PRIORITY: Priority = "P1";
export const PriorityInput = z.enum(PRIORITIES);
export const priorityFromRank = (n: number | null | undefined): Priority =>
  PRIORITIES[n ?? 1] ?? DEFAULT_PRIORITY;
export const priorityRank = (p: Priority): number => PRIORITIES.indexOf(p);

export const ORDER_RULES = [
  "priority",
  "urgency",
  "follow_up",
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
    /** Only tasks in one of these areas; "none" matches tasks without an area. */
    areas: z.array(z.string().min(1).max(41)).optional(),
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
  priority: Priority;
}

export interface Assessment {
  task: Task;
  /** Open and not held back by available_from or a resting routine. Ignores snooze. */
  available: boolean;
  /** Why it isn't available, if it isn't. */
  held: string | null;
  snoozed_until: Date | null;
  priority: Priority;
  /** The deadline that orders it and makes it urgent: its own, or else its parent's. */
  deadline: Moment | null;
  deadline_from_parent: boolean;
  /** Its target, unless that was missed more than STALE_TARGET_DAYS ago. */
  target: Moment | null;
  target_stale: boolean;
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
  if (t.state === "open" && t.open_parts) {
    held = `${t.open_parts} part${t.open_parts === 1 ? "" : "s"} still open`;
  }
  if (t.state === "waiting") held = "waiting";
  if (!active) held = t.state;

  // A part with no deadline of its own is ordered and made urgent by its parent's. It is
  // computed, never written onto the part.
  const deadline = t.deadline ?? t.parent_deadline ?? null;
  const deadline_from_parent = !t.deadline && !!deadline;
  const deadlineWord = deadline_from_parent ? "parent's deadline" : "deadline";
  const target_stale =
    !!t.target && momentStart(t.target).getTime() < now.getTime() - STALE_TARGET_DAYS * 86_400_000;
  const target = target_stale ? null : t.target;

  let urgent: Assessment["urgent"] = null;
  if (active && deadline) {
    const end = momentEnd(deadline);
    const hours = (end.getTime() - now.getTime()) / 3_600_000;
    if (hours <= URGENT_DEADLINE_HOURS) {
      urgent = {
        kind: "deadline",
        at: end,
        label:
          hours < 0
            ? `${deadlineWord} passed ${describeAgo(end, now)}`
            : `${deadlineWord} ${describeMoment(deadline, now)}`,
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
  else if (deadline) label = `${deadlineWord} ${describeMoment(deadline, now)}`;
  else if (t.target) label = `aiming for ${describeMoment(t.target, now)}`;
  else if (t.expires) label = `until ${describeMoment(t.expires, now)}`;

  return {
    task: t,
    available: t.state === "open" && held === null,
    held,
    snoozed_until: snoozed,
    priority: att?.priority ?? DEFAULT_PRIORITY,
    deadline,
    deadline_from_parent,
    target,
    target_stale,
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

/** An area as a filter names it: case-insensitive, "#" optional, "none" for no area. */
export function areaFilter(v: string): string {
  return v.trim().replace(/^#/, "").toLowerCase();
}

export function inAreas(t: Task, areas: string[]): boolean {
  return areas.map(areaFilter).includes(t.area ?? "none");
}

/**
 * Whether a person's view leaves this task out because its area is hidden by default. Naming
 * areas (any `areas` filter) shows exactly those, and a queue of an agent's turn is that agent's
 * inbox, which hiding never touches.
 */
export function hiddenByArea(cfg: QueueConfig, t: Task, hidden: ReadonlySet<string>): boolean {
  return !!t.area && hidden.has(t.area) && !cfg.areas && !cfg.actor.startsWith("agent:");
}

export const NO_HIDDEN_AREAS: ReadonlySet<string> = new Set();

/** Filters that also bound the urgent list: who, what text, whose, which area and visibility. */
function scopeChecks(cfg: QueueConfig, a: Assessment, viewer: Principal): Check[] {
  const t = a.task;
  const checks: Check[] = [];
  const actor = actorMatches(cfg, t, viewer);
  checks.push({ check: "actor", ok: actor.ok, detail: actor.detail });
  if (cfg.areas) {
    checks.push({
      check: "area",
      ok: inAreas(t, cfg.areas),
      detail: t.area ? `area: ${t.area}` : "no area",
    });
  }
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
  hidden: ReadonlySet<string>,
): Check[] {
  const t = a.task;
  const checks = scopeChecks(cfg, a, viewer);
  // Not a scope check: an urgent task in a hidden area still shows in the urgent list.
  if (hiddenByArea(cfg, t, hidden)) {
    checks.push({
      check: "area_hidden",
      ok: false,
      detail: `area hidden by default (#${t.area}); name the area to see it`,
    });
  }
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

export function compareBy(
  rules: OrderRule[],
  cfg: QueueConfig,
  now: Date,
): (x: Assessment, y: Assessment) => number {
  const key = (a: Assessment, rule: OrderRule): number => {
    const t = a.task;
    switch (rule) {
      case "priority":
        return priorityRank(a.priority);
      case "urgency":
        return a.urgent ? a.urgent.at.getTime() : Number.MAX_SAFE_INTEGER;
      case "follow_up":
        return a.claim_lapsed || a.follow_up_due ? 0 : 1;
      case "target": {
        // A reached target comes first; otherwise the nearest date, target or a deadline too far
        // off to be urgent, so a distant deadline can't jump ahead of missed targets. A target
        // missed long ago counts as none (assess drops it).
        const target = a.target ? momentStart(a.target).getTime() : Number.MAX_SAFE_INTEGER;
        if (target <= now.getTime()) return target - 1e15;
        return Math.min(target, a.deadline ? momentEnd(a.deadline).getTime() : target);
      }
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
export function whyShown(a: Assessment, now: Date, users: UserInfo[]): string {
  const t = a.task;
  if (a.priority === "P0") return "P0";
  if (a.urgent) return a.urgent.label;
  if (a.claim_lapsed) return a.label;
  if (a.follow_up_due) return a.label;
  if (a.target && momentStart(a.target) <= now) return `target ${describeMoment(a.target, now)}`;
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
  priority: Priority;
  /** priority === "P0", for clients that still read the pin (the iOS app). */
  pinned: boolean;
}

export interface QueueResult {
  items: QueueItem[];
  /** How many more matched beyond visible_limit. */
  hidden_count: number;
  /** Time-critical items, shown regardless of visible_limit and availability. */
  urgent: QueueItem[];
}

export function toItem(a: Assessment, now: Date, users: UserInfo[]): QueueItem {
  return {
    task: a.task,
    why: whyShown(a, now, users),
    label: a.label,
    urgent: !!a.urgent,
    stale: !!a.routine?.stale && a.available,
    snoozed_until: a.snoozed_until ? a.snoozed_until.toISOString() : null,
    priority: a.priority,
    pinned: a.priority === "P0",
  };
}

export function evaluateQueue(
  cfg: QueueConfig,
  assessments: Assessment[],
  viewer: Principal,
  now: Date,
  users: UserInfo[],
  hidden: ReadonlySet<string>,
): QueueResult {
  const cmp = compareBy(cfg.order, cfg, now);
  const matched = assessments
    .filter((a) => queueChecks(cfg, a, viewer, now, hidden).every((c) => c.ok))
    .sort(cmp);
  const shown = matched.slice(0, cfg.visible_limit);
  const shownIds = new Set(shown.map((a) => a.task.id));
  const urgent = assessments
    .filter((a) => a.urgent && !shownIds.has(a.task.id))
    .filter((a) => scopeChecks(cfg, a, viewer).every((c) => c.ok))
    .sort(compareBy(["urgency"], cfg, now));
  return {
    items: shown.map((a) => toItem(a, now, users)),
    hidden_count: matched.length - shown.length,
    urgent: urgent.map((a) => toItem(a, now, users)),
  };
}

export interface Explanation {
  task_id: string;
  verdict: "shown" | "urgent" | "beyond_limit" | "excluded";
  summary: string;
  position: number | null;
  checks: Check[];
  order: OrderRule[];
  /** What sets its place in the order, beyond the checks: priority band, borrowed or dropped dates. */
  ranking: { rule: string; detail: string }[];
}

const PRIORITY_DETAIL: Record<Priority, string> = {
  P0: "P0: sorts above every P1 and P2 task",
  P1: "P1 (the default): sorts after P0 tasks and before P2",
  P2: "P2: sorts after every P0 and P1 task, and is never picked for the day's plan",
};

/** The ordering facts explain reports alongside the checks. */
export function rankingOf(a: Assessment, now: Date): Explanation["ranking"] {
  const out: Explanation["ranking"] = [{ rule: "priority", detail: PRIORITY_DETAIL[a.priority] }];
  if (a.deadline_from_parent && a.deadline) {
    out.push({
      rule: "deadline",
      detail: `no deadline of its own; ordered and made urgent by its parent's deadline, ${describeMoment(a.deadline, now)}`,
    });
  }
  if (a.target_stale && a.task.target) {
    out.push({
      rule: "target",
      detail: `target ${describeMoment(a.task.target, now)} was missed more than ${STALE_TARGET_DAYS} days ago, so it sorts as if it had none`,
    });
  }
  return out;
}

export function explainTask(
  cfg: QueueConfig,
  assessments: Assessment[],
  target: Assessment,
  viewer: Principal,
  now: Date,
  users: UserInfo[],
  hidden: ReadonlySet<string>,
): Explanation {
  const checks = queueChecks(cfg, target, viewer, now, hidden);
  const result = evaluateQueue(cfg, assessments, viewer, now, users, hidden);
  const id = target.task.id;
  const pos = result.items.findIndex((i) => i.task.id === id);
  const failed = checks.filter((c) => !c.ok);
  const ranking = rankingOf(target, now);
  if (pos >= 0) {
    return {
      task_id: id,
      verdict: "shown",
      summary: `Shown at position ${pos + 1}: ${result.items[pos]?.why}`,
      position: pos + 1,
      checks,
      order: cfg.order,
      ranking,
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
      ranking,
    };
  }
  if (failed.length === 0) {
    const all = assessments
      .filter((a) => queueChecks(cfg, a, viewer, now, hidden).every((c) => c.ok))
      .sort(compareBy(cfg.order, cfg, now));
    const p = all.findIndex((a) => a.task.id === id) + 1;
    return {
      task_id: id,
      verdict: "beyond_limit",
      summary: `Matches, but is number ${p} and the queue shows ${cfg.visible_limit}`,
      position: p,
      checks,
      order: cfg.order,
      ranking,
    };
  }
  return {
    task_id: id,
    verdict: "excluded",
    summary: `Not shown: ${failed.map((c) => c.detail).join("; ")}`,
    position: null,
    checks,
    order: cfg.order,
    ranking,
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
  priority: Priority;
  /** priority === "P0", for clients that still read the pin (the iOS app). */
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
    priority: a.priority,
    pinned: a.priority === "P0",
  };
}
