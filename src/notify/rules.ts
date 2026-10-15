import { z } from "zod";
import { local } from "../domain/time.ts";
import type { Actor, Task } from "../domain/types.ts";

/**
 * What a notification can be about. Several feed events map to one category: they read the
 * same to the person ("it's ready for you now" covers a wait ending, a follow-up arriving and
 * a routine coming due).
 */
export const CATEGORIES = [
  "handoff",
  "ready",
  "deadline",
  "claim",
  "closed",
  "progress",
  "created",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  handoff: "handed over",
  ready: "ready to act on",
  deadline: "deadline is close",
  claim: "an agent's claim lapses",
  closed: "finished or closed",
  progress: "a note or progress",
  created: "newly added",
};

/** When one change fits several categories, it is reported as the first of them here. */
const PRIORITY: Category[] = [
  "handoff",
  "deadline",
  "claim",
  "ready",
  "closed",
  "progress",
  "created",
];

export const WHOSE = ["mine", "owned", "any"] as const;
export const FROM = ["anyone", "people", "agents"] as const;

const AREA = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export const RuleInput = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9-]{1,40}$/)
      .optional(),
    when: z.array(z.enum(CATEGORIES)).min(1),
    /**
     * mine: handed to me, or my turn now. owned: tasks I own, whoever's turn it is. any:
     * anything I can see.
     */
    whose: z.enum(WHOSE).default("mine"),
    /** One area, or null for every area (and tasks with none). */
    area: z.string().regex(AREA).nullable().default(null),
    /** Who made the change. Time-driven changes (deadlines, waits ending) have no one. */
    from: z.enum(FROM).default("anyone"),
    /** Deliver during quiet hours instead of holding it until they end. */
    quiet_ok: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .strict();
export type Rule = z.output<typeof RuleInput> & { id: string };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const QuietInput = z
  .object({ from: z.string().regex(TIME), to: z.string().regex(TIME) })
  .strict()
  .refine((q) => q.from !== q.to, "Quiet hours need to start and end at different times");
export type Quiet = z.output<typeof QuietInput>;

export const SettingsInput = z
  .object({
    quiet: QuietInput.nullable().optional(),
    rules: z.array(RuleInput).max(50).optional(),
  })
  .strict();

export function withIds(rules: z.output<typeof RuleInput>[]): Rule[] {
  return rules.map((r) => ({ ...r, id: r.id ?? crypto.randomUUID().slice(0, 8) }));
}

/** Where a new person starts: told when something becomes their turn, and about commitments. */
export function defaultRules(): Rule[] {
  return withIds([
    RuleInput.parse({ when: ["handoff", "ready", "deadline"], whose: "mine" }),
    RuleInput.parse({ when: ["deadline", "claim"], whose: "owned" }),
    RuleInput.parse({ when: ["closed", "progress"], whose: "owned", enabled: false }),
  ]);
}

export const DEFAULT_QUIET: Quiet = { from: "22:00", to: "07:00" };

/** A change as the notifier sees it: one or more feed events from one write. */
export interface Change {
  seq: number;
  at: string;
  types: { type: string; data: Record<string, unknown> }[];
  actor: { user: string | null; agent: string | null };
  task: Task;
}

function isMe(a: unknown, me: string): boolean {
  const actor = a as Actor | undefined;
  return actor?.kind === "user" && actor.user === me;
}

/** The categories a change could be reported as, with whether it is "mine" for each. */
export function categorize(change: Change, me: string): Map<Category, boolean> {
  const out = new Map<Category, boolean>();
  const myTurn = isMe(change.task.next_actor, me);
  const add = (cat: Category, mine: boolean) => out.set(cat, (out.get(cat) ?? false) || mine);
  for (const { type, data } of change.types) {
    switch (type) {
      case "handed_off":
        add("handoff", isMe(data.to, me));
        break;
      case "created":
        add("created", myTurn);
        // Captured straight into someone's hands reads as a handoff to them.
        if (change.task.next_actor.kind === "user" && change.actor.user !== me && myTurn) {
          add("handoff", true);
        }
        break;
      case "became_available":
      case "follow_up_due":
      case "routine_due":
      case "routine_stale":
        add("ready", myTurn);
        break;
      case "deadline_approaching":
        add("deadline", myTurn);
        break;
      case "claim_lapsed":
        add("claim", myTurn);
        break;
      case "completed":
      case "expired":
        add("closed", myTurn);
        break;
      case "state_changed":
        if (["done", "expired", "shelved"].includes(String(data.to))) add("closed", myTurn);
        break;
      case "checkpoint":
        add("progress", myTurn);
        break;
    }
  }
  return out;
}

export interface Match {
  category: Category;
  rule: Rule;
}

/**
 * Which rule (if any) says to tell `me` about this change, and as what. A person's own direct
 * changes are never reported back to them; an agent acting for them is someone else.
 */
export function match(change: Change, me: string, rules: Rule[]): Match | null {
  if (change.actor.user === me && change.actor.agent === null) return null;
  const cats = categorize(change, me);
  if (cats.size === 0) return null;
  const t = change.task;
  let best: Match | null = null;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.area !== null && t.area !== rule.area) continue;
    const { user, agent } = change.actor;
    if (rule.from === "people" && agent !== null) continue;
    if (rule.from === "agents" && agent === null && user !== null) continue;
    for (const cat of PRIORITY) {
      const mine = cats.get(cat);
      if (mine === undefined || !rule.when.includes(cat)) continue;
      if (rule.whose === "mine" && !mine) continue;
      if (rule.whose === "owned" && t.owner !== me) continue;
      if (!best || better(cat, rule, best)) best = { category: cat, rule };
      break;
    }
  }
  return best;
}

/** Prefer the more important category; for the same one, a rule that may break quiet hours. */
function better(cat: Category, rule: Rule, than: Match): boolean {
  const a = PRIORITY.indexOf(cat);
  const b = PRIORITY.indexOf(than.category);
  if (a !== b) return a < b;
  return rule.quiet_ok && !than.rule.quiet_ok;
}

export function inQuietHours(quiet: Quiet | null, now: Date): boolean {
  if (!quiet) return false;
  const t = local(now).toFormat("HH:mm");
  return quiet.from < quiet.to ? t >= quiet.from && t < quiet.to : t >= quiet.from || t < quiet.to;
}

/** A rule as a sentence, for the settings page. */
export function describeRule(rule: Rule): string {
  const whose =
    rule.whose === "mine"
      ? "when it's my turn"
      : rule.whose === "owned"
        ? "on tasks I own"
        : "on anything I can see";
  const cats = rule.when.map((c) => CATEGORY_LABELS[c]);
  const list = cats.length > 1 ? `${cats.slice(0, -1).join(", ")} or ${cats.at(-1)}` : cats[0];
  const area = rule.area ? ` in #${rule.area}` : "";
  const from =
    rule.from === "people" ? ", by a person" : rule.from === "agents" ? ", by an agent" : "";
  return `${cap(list as string)}, ${whose}${area}${from}`;
}

const cap = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s);
