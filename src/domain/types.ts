import { z } from "zod";
import type { Moment } from "./time.ts";
import { momentFromColumns } from "./time.ts";

/**
 * Who is calling. Derived only from a verified session or token, never from client input.
 * `userId` is null for a household display token, which sees household items only.
 */
export interface Principal {
  userId: string | null;
  agent: string | null;
  canWrite: boolean;
  /** Stable key for idempotency scoping. */
  key: string;
}

export type Actor =
  | { kind: "user"; user: string }
  | { kind: "agent"; agent: string }
  | {
      kind: "anyone";
    };

export type TaskState = "open" | "waiting" | "done" | "expired" | "shelved";
export const CLOSED_STATES: TaskState[] = ["done", "expired", "shelved"];

export interface OffsetRule {
  anchor: "deadline" | "expires";
  offset_days: number;
}

export interface Recurrence {
  mode: "after_completion" | "since_done";
  every_days: number;
}

export interface Waiting {
  kind: "reply" | "until" | "task";
  for: string;
  task_id: string | null;
  since: string;
  follow_up: Moment | null;
}

export interface Task {
  id: string;
  /** Capture order; a stable tie-breaker when timestamps are equal. */
  seq: number;
  title: string;
  brief: string;
  next_action: string;
  done_means: string;
  owner: string;
  visibility: "household" | "private";
  next_actor: Actor;
  actor_since: string;
  state: TaskState;
  close_reason: string;
  closed_at: string | null;
  waiting: Waiting | null;
  available_from: Moment | null;
  available_rule: OffsetRule | null;
  target: Moment | null;
  target_rule: OffsetRule | null;
  deadline: Moment | null;
  expires: Moment | null;
  requires: string[];
  prefers: string[];
  recurrence: Recurrence | null;
  last_done_at: string | null;
  last_skip_at: string | null;
  claim: {
    id: string;
    agent: string;
    user: string | null;
    expires_at: string;
    side_effects: boolean;
  } | null;
  revision: number;
  created_at: string;
  updated_at: string;
  created_by: { user: string | null; agent: string | null };
}

export interface ActivityEntry {
  id: number;
  task_id: string;
  kind: string;
  body: string;
  data: Record<string, unknown>;
  happened_at: string;
  recorded_at: string;
  author: { user: string | null; agent: string | null };
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

// biome-ignore lint/suspicious/noExplicitAny: raw pg row
export function taskFromRow(r: any): Task {
  const actor: Actor =
    r.actor_kind === "user"
      ? { kind: "user", user: r.actor_user }
      : r.actor_kind === "agent"
        ? { kind: "agent", agent: r.actor_agent }
        : { kind: "anyone" };
  return {
    id: r.id,
    seq: r.seq,
    title: r.title,
    brief: r.brief,
    next_action: r.next_action,
    done_means: r.done_means,
    owner: r.owner_id,
    visibility: r.visibility,
    next_actor: actor,
    actor_since: r.actor_since.toISOString(),
    state: r.state,
    close_reason: r.close_reason,
    closed_at: iso(r.closed_at),
    waiting: r.waiting_kind
      ? {
          kind: r.waiting_kind,
          for: r.waiting_for,
          task_id: r.waiting_task_id,
          since: r.waiting_since.toISOString(),
          follow_up: momentFromColumns(r.follow_up_date, r.follow_up_at),
        }
      : null,
    available_from: momentFromColumns(r.available_from_date, r.available_from_at),
    available_rule: r.available_rule,
    target: momentFromColumns(r.target_date, r.target_at),
    target_rule: r.target_rule,
    deadline: momentFromColumns(r.deadline_date, r.deadline_at),
    expires: momentFromColumns(r.expires_date, r.expires_at),
    requires: r.requires,
    prefers: r.prefers,
    recurrence: r.recurrence,
    last_done_at: iso(r.last_done_at),
    last_skip_at: iso(r.last_skip_at),
    claim: r.claim_id
      ? {
          id: r.claim_id,
          agent: r.claim_agent,
          user: r.claim_user,
          expires_at: r.claim_expires_at.toISOString(),
          side_effects: r.claim_side_effects,
        }
      : null,
    revision: r.revision,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
    created_by: { user: r.created_by_user, agent: r.created_by_agent },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: raw pg row
export function activityFromRow(r: any): ActivityEntry {
  return {
    id: r.id,
    task_id: r.task_id,
    kind: r.kind,
    body: r.body,
    data: r.data,
    happened_at: r.happened_at.toISOString(),
    recorded_at: r.recorded_at.toISOString(),
    author: { user: r.author_user, agent: r.author_agent },
  };
}

// ---- Input schemas (shared by REST, MCP and CLI) ----

/** A moment: rough text ("sat", "tomorrow 9am", "2026-10-03") or {date} / {at}. */
export const MomentInput = z.union([
  z.string(),
  z.object({ date: z.string() }).strict(),
  z.object({ at: z.string() }).strict(),
]);

/**
 * Next actor as text: "me", "anyone", a household user id ("sam"), or "agent:<name>".
 * Structured form is also accepted.
 */
export const ActorInput = z.union([
  z.string(),
  z.object({ kind: z.literal("user"), user: z.string() }),
  z.object({ kind: z.literal("agent"), agent: z.string() }),
  z.object({ kind: z.literal("anyone") }),
]);

export const OffsetRuleInput = z
  .object({ anchor: z.enum(["deadline", "expires"]), offset_days: z.number().int() })
  .strict();

export const RecurrenceInput = z
  .object({
    mode: z.enum(["after_completion", "since_done"]),
    every_days: z.number().int().min(1).max(3650),
  })
  .strict();

const nullable = <T extends z.ZodType>(t: T) => t.nullable().optional();

export const TaskFieldsInput = z
  .object({
    title: z.string().min(1).max(500),
    brief: z.string().max(20_000),
    next_action: z.string().max(2000),
    done_means: z.string().max(2000),
    visibility: z.enum(["household", "private"]),
    next_actor: ActorInput,
    available_from: nullable(MomentInput),
    available_rule: nullable(OffsetRuleInput),
    target: nullable(MomentInput),
    target_rule: nullable(OffsetRuleInput),
    deadline: nullable(MomentInput),
    expires: nullable(MomentInput),
    requires: z.array(z.string().min(1).max(50)).max(20),
    prefers: z.array(z.string().min(1).max(50)).max(20),
    recurrence: nullable(RecurrenceInput),
  })
  .partial()
  .strict();

export const CreateTaskInput = TaskFieldsInput.extend({
  title: z.string().min(1).max(500),
  /** For routines: when it was last actually done, so it doesn't appear due immediately. */
  last_done: MomentInput.optional(),
  idempotency_key: z.string().max(200).optional(),
}).strict();
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

export const UpdateTaskInput = TaskFieldsInput.extend({
  expected_revision: z.number().int().optional(),
  idempotency_key: z.string().max(200).optional(),
}).strict();
export type UpdateTaskInput = z.infer<typeof UpdateTaskInput>;

export const WaitingInput = z
  .object({
    kind: z.enum(["reply", "until", "task"]),
    for: z.string().max(500).optional(),
    task_id: z.string().optional(),
    follow_up: MomentInput.optional(),
  })
  .strict();

export const NOTE_KINDS = ["note", "research", "decision", "attempt"] as const;

export const CheckpointInput = z
  .object({
    note: z.string().min(1).max(20_000),
    kind: z.enum(NOTE_KINDS).optional(),
    brief: z.string().max(20_000).optional(),
    next_action: z.string().max(2000).optional(),
    next_actor: ActorInput.optional(),
    state: z.enum(["open", "waiting"]).optional(),
    waiting: WaitingInput.optional(),
    resurface_in_days: z.number().int().min(1).max(365).optional(),
    release_claim: z.boolean().optional(),
    expected_revision: z.number().int().optional(),
    idempotency_key: z.string().max(200).optional(),
  })
  .strict();
export type CheckpointInput = z.infer<typeof CheckpointInput>;

export const CompleteInput = z
  .object({
    /** When it was actually done ("yesterday", "thu", an ISO instant). Defaults to now. */
    at: MomentInput.optional(),
    note: z.string().max(20_000).optional(),
    expected_revision: z.number().int().optional(),
    idempotency_key: z.string().max(200).optional(),
  })
  .strict();
export type CompleteInput = z.infer<typeof CompleteInput>;

export const CloseInput = z
  .object({
    state: z.enum(["expired", "shelved"]),
    reason: z.string().max(2000).optional(),
    expected_revision: z.number().int().optional(),
    idempotency_key: z.string().max(200).optional(),
  })
  .strict();
export type CloseInput = z.infer<typeof CloseInput>;

export const SnoozeInput = z.object({ until: MomentInput.nullable() }).strict();

export const ClaimInput = z
  .object({
    lease_minutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .optional(),
    side_effects: z.boolean().optional(),
    task_id: z.string().optional(),
    idempotency_key: z.string().max(200).optional(),
  })
  .strict();
export type ClaimInput = z.infer<typeof ClaimInput>;
