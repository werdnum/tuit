/**
 * `tuit`: a command-line client of the REST API. It is deliberately thin: every rule about
 * recurrence, completion, visibility and attention lives on the server, and this file only
 * turns arguments into requests and responses into readable text (or `--json`).
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type ParseArgsConfig, parseArgs } from "node:util";
import type { NowView, Queue } from "../domain/board.ts";
import type { FeedPage } from "../domain/feed.ts";
import type { Moment } from "../domain/time.ts";
import type { ActivityEntry, Actor, Task } from "../domain/types.ts";
import type { Explanation, QueueItem, QueueResult, TaskStatus } from "../domain/views.ts";

// ---- Errors and exit codes ----

const EXIT = { error: 1, usage: 2, notFound: 3, conflict: 4 } as const;

class CliError extends Error {
  readonly code: number;
  constructor(message: string, code: number = EXIT.error) {
    super(message);
    this.code = code;
  }
}

// ---- Output ----

const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { bold: sgr("1"), dim: sgr("2"), red: sgr("31"), green: sgr("32"), yellow: sgr("33") };

const out = (s = ""): void => {
  process.stdout.write(`${s}\n`);
};
const printJson = (v: unknown): void => out(JSON.stringify(v, null, 2));

// Dates are shown in the household zone. The CLI never computes "relative to now" itself: the
// server's clock is authoritative (and controllable), so relative phrases come from the server.
const ZONE = process.env.TUIT_TIMEZONE ?? "Australia/Sydney";

function fmtDate(date: string): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).formatToParts(new Date(`${date}T12:00:00Z`));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}`;
}

function fmtInstant(iso: string, withYear = true): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = `${get("weekday")} ${get("day")} ${get("month")}${withYear ? ` ${get("year")}` : ""}`;
  return `${day} ${get("hour")}:${get("minute")}${get("dayPeriod").toLowerCase()}`;
}

/** A calendar date and an exact instant never look alike. */
function fmtMoment(m: Moment): string {
  return "date" in m ? `${fmtDate(m.date)}  (date)` : `${fmtInstant(m.at)}  (exact time)`;
}

function actorText(a: Actor, names: Map<string, string> = new Map()): string {
  if (a.kind === "anyone") return "anyone";
  if (a.kind === "agent") return `agent:${a.agent}`;
  return names.get(a.user) ?? a.user;
}

function authorText(a: { user: string | null; agent: string | null }, names: Map<string, string>) {
  const who = a.user ? (names.get(a.user) ?? a.user) : "system";
  return a.agent ? `${who} via agent:${a.agent}` : who;
}

function stateBadge(state: string): string {
  const badge = `[${state}]`;
  if (state === "done") return c.green(badge);
  if (state === "expired" || state === "shelved") return c.dim(badge);
  if (state === "waiting") return c.yellow(badge);
  return badge;
}

function itemLine(i: QueueItem, prefix: string): string {
  const why = i.why ? c.dim(` — ${i.why}`) : "";
  return `${prefix}${c.dim(i.task.id)}  ${i.task.title}${why}`;
}

// ---- Config ----

interface Config {
  url: string;
  token: string;
}

function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "tuit", "config.json");
}

function loadConfig(): Config {
  let file: Partial<Config> = {};
  try {
    file = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<Config>;
  } catch {}
  const url = process.env.TUIT_URL || file.url;
  const token = process.env.TUIT_TOKEN || file.token;
  if (!url || !token) {
    throw new CliError(
      "Not configured. Set TUIT_URL and TUIT_TOKEN, or run: tuit login --url <server> --token <token>\n" +
        "(Tokens are issued from the web app's settings page.)",
      EXIT.usage,
    );
  }
  return { url: url.replace(/\/+$/, ""), token };
}

// ---- HTTP ----

interface ErrorBody {
  error?: string;
  message?: string;
  current?: { revision?: number };
}

class Client {
  readonly cfg: Config;
  /** One key per invocation: a retry after a dropped connection can't apply twice. */
  readonly idempotencyKey = `cli-${randomUUID()}`;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    retry = method === "GET",
  ): Promise<T> {
    const attempts = retry ? 3 : 1;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.cfg.url}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.cfg.token}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        lastErr = e;
        if (attempt < attempts) await new Promise((r) => setTimeout(r, 250 * attempt));
        continue;
      }
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      if (res.ok) return json as T;
      throw httpError(res.status, (json ?? {}) as ErrorBody, text);
    }
    const cause = lastErr instanceof Error ? (lastErr.cause ?? lastErr) : lastErr;
    throw new CliError(
      `Can't reach ${this.cfg.url}: ${String((cause as Error)?.message ?? cause)}`,
    );
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /** A task mutation: carries the invocation's idempotency key, so it is safe to retry. */
  mutate<T>(method: string, path: string, body: Record<string, unknown> = {}): Promise<T> {
    return this.request<T>(method, path, { ...body, idempotency_key: this.idempotencyKey }, true);
  }
}

function httpError(status: number, body: ErrorBody, text: string): CliError {
  const msg = body.message || text || `HTTP ${status}`;
  if (status === 401) {
    return new CliError(`Not signed in: ${msg}. Check TUIT_TOKEN or run tuit login.`);
  }
  if (status === 403) return new CliError(`Not allowed: ${msg}`);
  if (status === 404) return new CliError(`Not found: ${msg}`, EXIT.notFound);
  if (status === 409) {
    const rev = body.current?.revision;
    return new CliError(
      `Conflict: ${msg}\nSomeone else changed it first. Re-read it (tuit show <id>), then retry` +
        (rev !== undefined ? ` with --rev ${rev}.` : "."),
      EXIT.conflict,
    );
  }
  // The server speaks in field names; point CLI users at the matching flag.
  const hint = /next_actor/.test(msg)
    ? "\nWith the CLI: add --next <actor> (me, anyone, a person, or agent:<name>)."
    : "";
  return new CliError(msg + hint);
}

// ---- Resolving ids ----

async function resolveTask(client: Client, ref: string): Promise<string> {
  // Server ids are 8 characters; anything shorter is a prefix.
  if (ref.length >= 8) return ref;
  for (const query of ["?state=active", ""]) {
    const { tasks } = await client.get<{ tasks: Task[] }>(`/api/tasks${query}`);
    const hits = tasks.filter((t) => t.id.startsWith(ref));
    if (hits.length === 1) return (hits[0] as Task).id;
    if (hits.length > 1) {
      const list = hits.map((t) => `  ${t.id}  ${t.title}`).join("\n");
      throw new CliError(`"${ref}" matches several tasks:\n${list}`);
    }
  }
  throw new CliError(`Not found: no task matching "${ref}"`, EXIT.notFound);
}

async function resolveQueue(client: Client, ref: string): Promise<Queue> {
  const { queues } = await client.get<{ queues: Queue[] }>("/api/queues");
  const exact = queues.find((q) => q.id === ref);
  if (exact) return exact;
  const byName = queues.filter((q) => q.name.toLowerCase() === ref.toLowerCase());
  const hits = byName.length ? byName : queues.filter((q) => q.id.startsWith(ref));
  if (hits.length === 1) return hits[0] as Queue;
  if (hits.length > 1) {
    const list = hits.map((q) => `  ${q.id}  ${q.name}`).join("\n");
    throw new CliError(`"${ref}" matches several queues:\n${list}`);
  }
  throw new CliError(`Not found: no queue matching "${ref}"`, EXIT.notFound);
}

// ---- Commands ----

type Values = Record<string, string | boolean | string[] | undefined>;

interface Ctx {
  values: Values;
  args: string[];
  json: boolean;
  client: () => Client;
}

interface Command {
  usage: string;
  summary: string;
  options?: ParseArgsConfig["options"];
  run: (ctx: Ctx) => Promise<void>;
}

const str = (v: Values, k: string): string | undefined => v[k] as string | undefined;

function need(args: string[], n: number, what: string): string {
  const v = args[n];
  if (v === undefined || v === "") throw new CliError(`Missing ${what}`, EXIT.usage);
  return v;
}

function intOpt(v: Values, k: string): number | undefined {
  const s = str(v, k);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n))
    throw new CliError(`--${k} needs a whole number, got "${s}"`, EXIT.usage);
  return n;
}

/** "none" (or "-") clears a date. */
const momentOpt = (s: string | undefined): string | null | undefined =>
  s === undefined ? undefined : s === "none" || s === "-" ? null : s;

const listOpt = (s: string | undefined): string[] | undefined =>
  s === undefined
    ? undefined
    : s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);

function readConfigArg(s: string): unknown {
  let text = s;
  if (s === "@-") text = readFileSync(0, "utf8");
  else if (s.startsWith("@")) text = readFileSync(s.slice(1), "utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CliError(`--config is not valid JSON: ${(e as Error).message}`, EXIT.usage);
  }
}

function dropUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

async function householdNames(client: Client): Promise<Map<string, string>> {
  const me = await client.get<{ household: { id: string; name: string }[] }>("/api/me");
  return new Map(me.household.map((u) => [u.id, u.name]));
}

/** One line confirming a mutation, with the server's own status phrase. */
function confirm(ctx: Ctx, verb: string, v: { task: Task; status: TaskStatus }): void {
  if (ctx.json) {
    printJson(v);
    return;
  }
  const closed = ["done", "expired", "shelved"].includes(v.task.state);
  const label = closed ? v.task.close_reason : (v.status.urgent ?? v.status.label);
  out(
    `${verb} ${c.dim(v.task.id)}  ${v.task.title}  ${stateBadge(v.task.state)}${label ? c.dim(` · ${label}`) : ""}`,
  );
}

function awayParts(a: NonNullable<NowView["away"]>): string {
  const parts = [
    a.expired ? `${a.expired} expired` : "",
    a.handed_to_you ? `${a.handed_to_you} handed to you` : "",
    a.became_due ? `${a.became_due} routines came due` : "",
  ].filter(Boolean);
  return parts.length ? `: ${parts.join(", ")}.` : ".";
}

function printNow(v: NowView): void {
  if (v.away) {
    const a = v.away;
    out(c.bold(`Welcome back (away since ${fmtInstant(a.since, false)})${awayParts(a)}`));
    out();
  }
  if (v.urgent.length) {
    out(c.red(c.bold("Urgent")));
    for (const i of v.urgent) out(itemLine(i, c.red("  ! ")));
    out();
  }
  if (v.enough_until) {
    out(`Enough for now, until ${fmtInstant(v.enough_until, false)}. Only urgent items show.`);
    out(c.dim("  (tuit enough --off to bring the list back)"));
  } else {
    out(c.bold(`Now · ${fmtDate(v.date)}`));
    if (v.plan.length === 0) out(c.dim("  Nothing needs you right now."));
    for (const p of v.plan) {
      out(
        p.done
          ? c.dim(`  [x] ${p.item.task.id}  ${p.item.task.title}`)
          : itemLine(p.item, "  [ ] "),
      );
    }
    if (v.new_items.length) {
      out();
      out(c.bold("New since this morning"));
      for (const i of v.new_items) out(itemLine(i, "  [ ] "));
    }
    if (v.more_count > 0) out(c.dim(`  +${v.more_count} more (tuit now --more)`));
  }
  if (v.waiting_count > 0) {
    out(c.dim(`${v.waiting_count} waiting on someone or something (tuit search to find them)`));
  }
}

function printQueueResult(r: QueueResult): void {
  if (r.items.length === 0) out(c.dim("  (nothing matches)"));
  r.items.forEach((i, n) => {
    out(itemLine(i, `  ${String(n + 1).padStart(2)}. `));
  });
  if (r.hidden_count > 0) out(c.dim(`  +${r.hidden_count} more beyond the visible limit`));
  if (r.urgent.length) {
    out(c.red(c.bold("Urgent (outside the limit)")));
    for (const i of r.urgent) out(itemLine(i, c.red("   ! ")));
  }
}

const HIDDEN_HISTORY_KINDS = new Set(["system", "edit"]);

async function printTask(
  client: Client,
  v: { task: Task; status: TaskStatus; activity: ActivityEntry[] },
  all: boolean,
): Promise<void> {
  const names = await householdNames(client);
  const t = v.task;
  const s = v.status;
  const row = (k: string, val: string) => out(`${c.dim(k.padEnd(10))}${val}`);
  out(
    `${c.bold(t.title)}  ${stateBadge(t.state)}${t.visibility === "private" ? " [private]" : ""}`,
  );
  row("id", `${t.id}  (rev ${t.revision})`);
  const flags = [
    s.urgent ? c.red(s.urgent) : s.label,
    s.held && s.held !== t.state ? s.held : "",
    s.snoozed_until ? `snoozed until ${fmtInstant(s.snoozed_until, false)}` : "",
    s.pinned ? "pinned" : "",
  ].filter(Boolean);
  if (flags.length) row("status", flags.join(" · "));
  if (t.close_reason) row("reason", t.close_reason);
  row("next", `${actorText(t.next_actor, names)}${t.next_action ? ` — ${t.next_action}` : ""}`);
  if (t.owner && !(t.next_actor.kind === "user" && t.next_actor.user === t.owner)) {
    row("owner", names.get(t.owner) ?? t.owner);
  }
  if (t.waiting) {
    const w = t.waiting;
    const what = w.kind === "task" ? `task ${w.task_id}` : w.for || w.kind;
    const fu = w.follow_up
      ? `; ${w.kind === "until" ? "until" : "follow up"} ${fmtMoment(w.follow_up)}`
      : "";
    row("waiting", `${what} (since ${fmtInstant(w.since, false)}${fu})`);
  }
  if (t.recurrence) {
    const mode = t.recurrence.mode === "after_completion" ? "every" : "quiet for";
    row(
      "routine",
      `${mode} ${t.recurrence.every_days} days${s.routine ? ` · ${s.routine.label}` : ""}`,
    );
  }
  if (t.claim) {
    row(
      "claim",
      `agent:${t.claim.agent} until ${fmtInstant(t.claim.expires_at, false)}${t.claim.side_effects ? " (side effects)" : ""}`,
    );
  }
  if (t.requires.length) row("requires", t.requires.join(", "));
  if (t.prefers.length) row("prefers", t.prefers.join(", "));
  if (t.done_means) row("done =", t.done_means);
  const dates: [string, Moment | null, string][] = [
    ["available", t.available_from, t.available_rule ? ruleText(t.available_rule) : ""],
    ["target", t.target, t.target_rule ? ruleText(t.target_rule) : ""],
    ["deadline", t.deadline, ""],
    ["expires", t.expires, ""],
  ];
  for (const [k, m, rule] of dates)
    if (m) row(k, `${fmtMoment(m)}${rule ? c.dim(`  ${rule}`) : ""}`);
  if (t.brief) {
    out(c.dim("brief"));
    for (const line of t.brief.split("\n")) out(`  ${line}`);
  }
  if (t.attachments.length) {
    out(c.dim("attachments"));
    for (const a of t.attachments) out(`  ${a.title}  ${c.dim(a.url)}  ${c.dim(`(${a.id})`)}`);
  }
  const history = all ? v.activity : v.activity.filter((a) => !HIDDEN_HISTORY_KINDS.has(a.kind));
  if (history.length) {
    out(c.dim(`history${all ? "" : " (--all for edits and system entries)"}`));
    for (const a of history) {
      const agent = a.author.agent ? c.yellow(" [agent]") : "";
      const when = fmtInstant(a.happened_at, false);
      const late =
        a.recorded_at.slice(0, 16) !== a.happened_at.slice(0, 16) ? c.dim(" (recorded later)") : "";
      out(`  ${c.dim(when)}  ${a.kind.padEnd(12)} ${authorText(a.author, names)}${agent}${late}`);
      if (a.body) for (const line of a.body.split("\n")) out(`      ${line}`);
    }
  }
}

function ruleText(r: { anchor: string; offset_days: number }): string {
  const n = r.offset_days;
  return `(${r.anchor} ${n < 0 ? "−" : "+"} ${Math.abs(n)}d)`;
}

const JSON_OPT = { json: { type: "boolean" }, help: { type: "boolean", short: "h" } } as const;

async function taskMutation(
  ctx: Ctx,
  verb: string,
  path: (id: string) => string,
  body: Record<string, unknown>,
  method = "POST",
): Promise<void> {
  const client = ctx.client();
  const id = await resolveTask(client, need(ctx.args, 0, "task id"));
  const v = await client.mutate<{ task: Task; status: TaskStatus }>(
    method,
    path(id),
    dropUndefined(body),
  );
  confirm(ctx, verb, v);
}

/** Snooze/pin/release take no idempotency key; they set state, so a retry is harmless. */
async function plainTaskPost(ctx: Ctx, verb: string, sub: string, body: unknown): Promise<void> {
  const client = ctx.client();
  const id = await resolveTask(client, need(ctx.args, 0, "task id"));
  const v = await client.request<{ task: Task; status: TaskStatus }>(
    "POST",
    `/api/tasks/${id}/${sub}`,
    body,
    true,
  );
  confirm(ctx, verb, v);
}

const commands: Record<string, Command> = {
  now: {
    usage: "tuit [now] [--more]",
    summary: "What deserves attention now: urgent items, today's shortlist, what's new",
    options: { more: { type: "boolean" } },
    async run(ctx) {
      const client = ctx.client();
      const v = ctx.values.more
        ? await client.request<NowView>("POST", "/api/now/more", {}, true)
        : await client.get<NowView>("/api/now");
      ctx.json ? printJson(v) : printNow(v);
    },
  },
  enough: {
    usage: "tuit enough [--off]",
    summary: "Hide the shortlist until tomorrow morning (urgent items still show)",
    options: { off: { type: "boolean" } },
    async run(ctx) {
      const v = await ctx
        .client()
        .request<NowView>("POST", "/api/now/enough", { on: !ctx.values.off }, true);
      ctx.json ? printJson(v) : printNow(v);
    },
  },
  add: {
    usage:
      "tuit add <title...> [--deadline X] [--target X] [--expires X] [--available X] [--private]\n" +
      "         [--to ACTOR] [--brief T] [--action T] [--every N | --since-done N] [--last-done X]",
    summary: "Capture a task (title is all you need)",
    options: {
      deadline: { type: "string" },
      target: { type: "string" },
      expires: { type: "string" },
      available: { type: "string" },
      private: { type: "boolean" },
      to: { type: "string" },
      brief: { type: "string" },
      action: { type: "string" },
      every: { type: "string" },
      "since-done": { type: "string" },
      "last-done": { type: "string" },
    },
    async run(ctx) {
      const v = ctx.values;
      const title = ctx.args.join(" ").trim();
      if (!title) throw new CliError("Missing title", EXIT.usage);
      const every = intOpt(v, "every");
      const sinceDone = intOpt(v, "since-done");
      if (every !== undefined && sinceDone !== undefined) {
        throw new CliError("Use either --every or --since-done, not both", EXIT.usage);
      }
      const recurrence =
        every !== undefined
          ? { mode: "after_completion", every_days: every }
          : sinceDone !== undefined
            ? { mode: "since_done", every_days: sinceDone }
            : undefined;
      const created = await ctx.client().mutate<{ task: Task; status: TaskStatus }>(
        "POST",
        "/api/tasks",
        dropUndefined({
          title,
          deadline: str(v, "deadline"),
          target: str(v, "target"),
          expires: str(v, "expires"),
          available_from: str(v, "available"),
          visibility: v.private ? "private" : undefined,
          next_actor: str(v, "to"),
          brief: str(v, "brief"),
          next_action: str(v, "action"),
          recurrence,
          last_done: str(v, "last-done"),
        }),
      );
      confirm(ctx, "Added", created);
    },
  },
  show: {
    usage: "tuit show <id> [--all]",
    summary: "Brief, next step, dates and history (--all adds edits and system entries)",
    options: { all: { type: "boolean" } },
    async run(ctx) {
      const client = ctx.client();
      const id = await resolveTask(client, need(ctx.args, 0, "task id"));
      const v = await client.get<{ task: Task; status: TaskStatus; activity: ActivityEntry[] }>(
        `/api/tasks/${id}`,
      );
      ctx.json ? printJson(v) : await printTask(client, v, !!ctx.values.all);
    },
  },
  done: {
    usage: "tuit done <id> [--at WHEN] [--note T]",
    summary: "Mark done (--at records an earlier completion, e.g. --at yesterday)",
    options: { at: { type: "string" }, note: { type: "string" } },
    run: (ctx) =>
      taskMutation(ctx, "Done:", (id) => `/api/tasks/${id}/complete`, {
        at: str(ctx.values, "at"),
        note: str(ctx.values, "note"),
      }),
  },
  skip: {
    usage: "tuit skip <id>",
    summary: "Pass on a routine this time (doesn't reset 'last done')",
    run: (ctx) => taskMutation(ctx, "Skipped:", (id) => `/api/tasks/${id}/skip`, {}),
  },
  note: {
    usage:
      "tuit note <id> <text...> [--kind note|research|decision|attempt] [--next ACTOR] [--action T] [--brief T]",
    summary: "Record progress and (optionally) move the task on, atomically",
    options: {
      kind: { type: "string" },
      next: { type: "string" },
      action: { type: "string" },
      brief: { type: "string" },
    },
    run(ctx) {
      const text = ctx.args.slice(1).join(" ").trim();
      if (!text) throw new CliError("Missing note text", EXIT.usage);
      return taskMutation(ctx, "Noted:", (id) => `/api/tasks/${id}/checkpoint`, {
        note: text,
        kind: str(ctx.values, "kind"),
        next_actor: str(ctx.values, "next"),
        next_action: str(ctx.values, "action"),
        brief: str(ctx.values, "brief"),
      });
    },
  },
  handoff: {
    usage: "tuit handoff <id> <actor> [--note T] [--action T] [--brief T]",
    summary: "Hand the next step to someone: me, anyone, a person, or agent:<name>",
    options: { note: { type: "string" }, action: { type: "string" }, brief: { type: "string" } },
    run(ctx) {
      const to = need(ctx.args, 1, "actor (me, anyone, a person, or agent:<name>)");
      return taskMutation(ctx, `Handed to ${to}:`, (id) => `/api/tasks/${id}/handoff`, {
        to,
        note: str(ctx.values, "note"),
        next_action: str(ctx.values, "action"),
        brief: str(ctx.values, "brief"),
      });
    },
  },
  wait: {
    usage:
      "tuit wait <id> <what...> [--follow-up WHEN]   waiting for a reply\n" +
      "tuit wait <id> --until WHEN                  nothing to do until then\n" +
      "tuit wait <id> --on <task-id>                blocked by another task\n" +
      "         [--note T] [--next ACTOR]",
    summary: "Put a task in waiting (reply, until a moment, or on another task)",
    options: {
      "follow-up": { type: "string" },
      until: { type: "string" },
      on: { type: "string" },
      note: { type: "string" },
      next: { type: "string" },
    },
    async run(ctx) {
      const v = ctx.values;
      const client = ctx.client();
      const what = ctx.args.slice(1).join(" ").trim();
      let waiting: Record<string, unknown>;
      let note: string;
      const until = str(v, "until");
      const on = str(v, "on");
      if (until && on) throw new CliError("Use either --until or --on, not both", EXIT.usage);
      if (until) {
        waiting = { kind: "until", follow_up: until, for: what || undefined };
        note = `Waiting until ${until}${what ? `: ${what}` : ""}`;
      } else if (on) {
        const dep = await resolveTask(client, on);
        waiting = { kind: "task", task_id: dep, for: what || undefined };
        note = `Waiting on task ${dep}${what ? `: ${what}` : ""}`;
      } else {
        if (!what)
          throw new CliError("Say what it's waiting for (or use --until / --on)", EXIT.usage);
        waiting = { kind: "reply", for: what, follow_up: str(v, "follow-up") };
        note = `Waiting for ${what}`;
      }
      const id = await resolveTask(client, need(ctx.args, 0, "task id"));
      const r = await client.mutate<{ task: Task; status: TaskStatus }>(
        "POST",
        `/api/tasks/${id}/checkpoint`,
        dropUndefined({
          note: str(v, "note") ?? note,
          state: "waiting",
          waiting: dropUndefined(waiting),
          next_actor: str(v, "next"),
        }),
      );
      confirm(ctx, "Waiting:", r);
    },
  },
  attach: {
    usage: "tuit attach <id> <url> [--title T]",
    summary: "Attach a link to a file (Tuit keeps the link, not the file)",
    options: { title: { type: "string" } },
    run(ctx) {
      const url = need(ctx.args, 1, "url");
      return taskMutation(ctx, "Attached:", (id) => `/api/tasks/${id}/attachments`, {
        url,
        title: str(ctx.values, "title"),
      });
    },
  },
  detach: {
    usage: "tuit detach <id> <attachment-id>",
    summary: "Remove an attachment link (the file itself is untouched)",
    run(ctx) {
      const attachment = need(ctx.args, 1, "attachment id");
      return taskMutation(
        ctx,
        "Removed attachment:",
        (id) => `/api/tasks/${id}/attachments/${encodeURIComponent(attachment)}`,
        {},
        "DELETE",
      );
    },
  },
  snooze: {
    usage: "tuit snooze <id> <when>",
    summary: "Hide from your lists until then (never hides urgent items; dates unchanged)",
    run(ctx) {
      const until = ctx.args.slice(1).join(" ").trim();
      if (!until) throw new CliError("Missing when (e.g. tomorrow, sat, +3d)", EXIT.usage);
      return plainTaskPost(ctx, "Snoozed:", "snooze", { until });
    },
  },
  unsnooze: {
    usage: "tuit unsnooze <id>",
    summary: "Bring a snoozed task back",
    run: (ctx) => plainTaskPost(ctx, "Unsnoozed:", "snooze", { until: null }),
  },
  pin: {
    usage: "tuit pin <id>",
    summary: "Pin to the top of your lists",
    run: (ctx) => plainTaskPost(ctx, "Pinned:", "pin", { pinned: true }),
  },
  unpin: {
    usage: "tuit unpin <id>",
    summary: "Unpin",
    run: (ctx) => plainTaskPost(ctx, "Unpinned:", "pin", { pinned: false }),
  },
  drop: {
    usage: "tuit drop <id> [--reason T]",
    summary: "No longer relevant: expire it (not done; notes kept, still searchable)",
    options: { reason: { type: "string" } },
    run: (ctx) =>
      taskMutation(ctx, "Dropped:", (id) => `/api/tasks/${id}/close`, {
        state: "expired",
        reason: str(ctx.values, "reason"),
      }),
  },
  shelve: {
    usage: "tuit shelve <id> [--reason T]",
    summary: "Gone cold: take it out of rotation (still searchable)",
    options: { reason: { type: "string" } },
    run: (ctx) =>
      taskMutation(ctx, "Shelved:", (id) => `/api/tasks/${id}/close`, {
        state: "shelved",
        reason: str(ctx.values, "reason"),
      }),
  },
  reopen: {
    usage: "tuit reopen <id>",
    summary: "Reopen a done, expired, shelved or waiting task",
    run: (ctx) => taskMutation(ctx, "Reopened:", (id) => `/api/tasks/${id}/reopen`, {}),
  },
  edit: {
    usage:
      "tuit edit <id> [--title T] [--brief T] [--action T] [--done-means T] [--to ACTOR]\n" +
      "         [--deadline X] [--target X] [--expires X] [--available X]   (X = none clears)\n" +
      "         [--private | --household] [--requires a,b] [--prefers a,b] [--rev N]",
    summary: "Change fields (pass --rev to refuse if someone else changed it first)",
    options: {
      title: { type: "string" },
      brief: { type: "string" },
      action: { type: "string" },
      "done-means": { type: "string" },
      to: { type: "string" },
      deadline: { type: "string" },
      target: { type: "string" },
      expires: { type: "string" },
      available: { type: "string" },
      private: { type: "boolean" },
      household: { type: "boolean" },
      requires: { type: "string" },
      prefers: { type: "string" },
      rev: { type: "string" },
    },
    run(ctx) {
      const v = ctx.values;
      if (v.private && v.household) {
        throw new CliError("Use either --private or --household", EXIT.usage);
      }
      const body = dropUndefined({
        title: str(v, "title"),
        brief: str(v, "brief"),
        next_action: str(v, "action"),
        done_means: str(v, "done-means"),
        next_actor: str(v, "to"),
        deadline: momentOpt(str(v, "deadline")),
        target: momentOpt(str(v, "target")),
        expires: momentOpt(str(v, "expires")),
        available_from: momentOpt(str(v, "available")),
        visibility: v.private ? "private" : v.household ? "household" : undefined,
        requires: listOpt(str(v, "requires")),
        prefers: listOpt(str(v, "prefers")),
        expected_revision: intOpt(v, "rev"),
      });
      if (Object.keys(body).filter((k) => k !== "expected_revision").length === 0) {
        throw new CliError("Nothing to change. See tuit edit --help", EXIT.usage);
      }
      return taskMutation(ctx, "Updated:", (id) => `/api/tasks/${id}`, body, "PATCH");
    },
  },
  search: {
    usage: "tuit search <text...>",
    summary: "Find tasks by text, including done, expired and shelved ones",
    async run(ctx) {
      const q = ctx.args.join(" ").trim();
      if (!q) throw new CliError("Missing search text", EXIT.usage);
      const r = await ctx.client().get<{ tasks: Task[] }>(`/api/tasks?q=${encodeURIComponent(q)}`);
      if (ctx.json) return printJson(r);
      if (r.tasks.length === 0) return out(c.dim("No matches."));
      for (const t of r.tasks) {
        const reason = t.close_reason ? c.dim(` — ${t.close_reason}`) : "";
        out(`${c.dim(t.id)}  ${stateBadge(t.state).padEnd(10)} ${t.title}${reason}`);
      }
    },
  },
  queues: {
    usage: "tuit queues",
    summary: "List saved queues",
    async run(ctx) {
      const r = await ctx.client().get<{ queues: Queue[] }>("/api/queues");
      if (ctx.json) return printJson(r);
      if (r.queues.length === 0) return out(c.dim("No queues yet. tuit queue create --help"));
      for (const q of r.queues) {
        const flags = [q.enabled ? "" : "disabled", q.visibility === "private" ? "private" : ""]
          .filter(Boolean)
          .map((f) => `[${f}]`)
          .join(" ");
        out(
          `${c.dim(q.id)}  ${q.name}${flags ? ` ${flags}` : ""}${c.dim(` · limit ${q.config.visible_limit} · rev ${q.revision}`)}`,
        );
      }
    },
  },
  queue: {
    usage:
      "tuit queue <id|name>                          run it\n" +
      "tuit queue create --name N --config JSON|@file [--private]\n" +
      "tuit queue update <id> [--name N] [--config JSON|@file] [--enable|--disable] [--rev N]\n" +
      "tuit queue preview --config JSON|@file",
    summary: "Run, create, update or preview a queue",
    options: {
      name: { type: "string" },
      config: { type: "string" },
      private: { type: "boolean" },
      enable: { type: "boolean" },
      disable: { type: "boolean" },
      rev: { type: "string" },
    },
    async run(ctx) {
      const client = ctx.client();
      const v = ctx.values;
      const sub = need(ctx.args, 0, "queue id, name, or create/update/preview");
      if (sub === "create") {
        const name = str(v, "name");
        if (!name) throw new CliError("Missing --name", EXIT.usage);
        const cfg = str(v, "config");
        const q = await client.request<Queue>(
          "POST",
          "/api/queues",
          dropUndefined({
            name,
            config: cfg ? readConfigArg(cfg) : undefined,
            visibility: v.private ? "private" : undefined,
          }),
        );
        if (ctx.json) return printJson(q);
        out(`Created queue ${c.dim(q.id)}  ${q.name}`);
        return printJson(q.config);
      }
      if (sub === "update") {
        const { id } = await resolveQueue(client, need(ctx.args, 1, "queue id"));
        if (v.enable && v.disable)
          throw new CliError("Use either --enable or --disable", EXIT.usage);
        const cfg = str(v, "config");
        const q = await client.request<Queue>(
          "PATCH",
          `/api/queues/${id}`,
          dropUndefined({
            name: str(v, "name"),
            config: cfg ? readConfigArg(cfg) : undefined,
            enabled: v.enable ? true : v.disable ? false : undefined,
            expected_revision: intOpt(v, "rev"),
          }),
        );
        if (ctx.json) return printJson(q);
        out(
          `Updated queue ${c.dim(q.id)}  ${q.name}${q.enabled ? "" : " [disabled]"} (rev ${q.revision})`,
        );
        return;
      }
      if (sub === "preview") {
        const cfg = str(v, "config");
        if (!cfg) throw new CliError("Missing --config", EXIT.usage);
        const r = await client.request<QueueResult>(
          "POST",
          "/api/queues/preview",
          { config: readConfigArg(cfg) },
          true,
        );
        if (ctx.json) return printJson(r);
        out(c.bold("Preview (not saved)"));
        return printQueueResult(r);
      }
      const { id } = await resolveQueue(client, sub);
      const r = await client.get<{ queue: Queue; result: QueueResult }>(`/api/queues/${id}`);
      if (ctx.json) return printJson(r);
      out(
        `${c.bold(r.queue.name)}${r.queue.enabled ? "" : " [disabled]"}  ${c.dim(`${r.queue.id} · limit ${r.queue.config.visible_limit}`)}`,
      );
      printQueueResult(r.result);
    },
  },
  why: {
    usage: "tuit why <task-id> [--queue ID|name]",
    summary: "Explain why a task is or isn't in Now (or a queue)",
    options: { queue: { type: "string" } },
    async run(ctx) {
      const client = ctx.client();
      const id = await resolveTask(client, need(ctx.args, 0, "task id"));
      const qref = str(ctx.values, "queue");
      const queue = qref ? await resolveQueue(client, qref) : undefined;
      const qid = queue?.id;
      const e = await client.get<Explanation>(
        `/api/tasks/${id}/explain${qid ? `?queue=${encodeURIComponent(qid)}` : ""}`,
      );
      if (ctx.json) return printJson(e);
      out(`${c.bold(qid ? `Queue "${queue?.name}"` : "Now")}: ${e.summary}`);
      for (const ch of e.checks) {
        out(`  ${ch.ok ? c.green("✓") : c.red("✗")} ${ch.check.padEnd(15)} ${ch.detail}`);
      }
      out(c.dim(`  order: ${e.order.join(" > ")}`));
    },
  },
  claim: {
    usage: "tuit claim [--lease MIN] [--side-effects] [--task ID]",
    summary: "Atomically take the next task handed to this agent, with a lease",
    options: {
      lease: { type: "string" },
      "side-effects": { type: "boolean" },
      task: { type: "string" },
    },
    async run(ctx) {
      const client = ctx.client();
      const t = str(ctx.values, "task");
      // Not retried: the server takes no idempotency key for claims, so a blind retry could
      // take a second task.
      const r = await client.request<{ task: Task | null; status?: TaskStatus }>(
        "POST",
        "/api/claim",
        dropUndefined({
          lease_minutes: intOpt(ctx.values, "lease"),
          side_effects: ctx.values["side-effects"] ? true : undefined,
          task_id: t ? await resolveTask(client, t) : undefined,
        }),
      );
      if (ctx.json) return printJson(r);
      if (!r.task || !r.status) return out(c.dim("Nothing to claim."));
      confirm(ctx, "Claimed:", { task: r.task, status: r.status });
      if (r.task.claim) out(c.dim(`  lease until ${fmtInstant(r.task.claim.expires_at, false)}`));
      if (r.task.next_action) out(`  next: ${r.task.next_action}`);
      if (r.task.brief) out(`  brief: ${r.task.brief.replaceAll("\n", "\n         ")}`);
    },
  },
  release: {
    usage: "tuit release <id>",
    summary: "Release a claim",
    run: (ctx) => plainTaskPost(ctx, "Released:", "release", {}),
  },
  changes: {
    usage: "tuit changes [--after CURSOR|latest] [--limit N]",
    summary: "The change feed: events since a cursor, and the next cursor",
    options: { after: { type: "string" }, limit: { type: "string" } },
    async run(ctx) {
      const params = new URLSearchParams(
        dropUndefined({
          after: str(ctx.values, "after"),
          limit: str(ctx.values, "limit"),
        }) as Record<string, string>,
      );
      const qs = params.size ? `?${params}` : "";
      const r = await ctx.client().get<FeedPage>(`/api/changes${qs}`);
      if (ctx.json) return printJson(r);
      for (const e of r.events) {
        const subject = e.task
          ? `${e.task.id}  ${e.task.title}`
          : e.queue
            ? `queue ${e.queue.id}  ${e.queue.name}`
            : "";
        const by =
          e.actor.user || e.actor.agent ? c.dim(` (${authorText(e.actor, new Map())})`) : "";
        out(
          `${c.dim(`#${e.seq}`)}  ${c.dim(fmtInstant(e.at, false))}  ${e.type.padEnd(20)} ${subject}${by}`,
        );
      }
      if (r.events.length === 0) out(c.dim("No new events."));
      out(`cursor: ${r.cursor}`);
    },
  },
  export: {
    usage: "tuit export",
    summary: "Everything you can see (tasks, history, queues) as JSON",
    async run(ctx) {
      printJson(await ctx.client().get<unknown>("/api/export"));
    },
  },
  whoami: {
    usage: "tuit whoami",
    summary: "Who this credential acts for",
    async run(ctx) {
      const me = await ctx.client().get<{
        user: { id: string; name: string } | null;
        agent: string | null;
        can_write: boolean;
      }>("/api/me");
      if (ctx.json) return printJson(me);
      const who = me.user ? `${me.user.name} (${me.user.id})` : "household display";
      out(`${who}${me.agent ? ` via agent:${me.agent}` : ""}${me.can_write ? "" : " [read-only]"}`);
    },
  },
  login: {
    usage: "tuit login --url URL --token TOKEN",
    summary: "Save the server and token to ~/.config/tuit/config.json",
    options: { url: { type: "string" }, token: { type: "string" } },
    async run(ctx) {
      const url = str(ctx.values, "url");
      const token = str(ctx.values, "token");
      if (!url || !token) throw new CliError("Need both --url and --token", EXIT.usage);
      const client = new Client({ url: url.replace(/\/+$/, ""), token });
      const me = await client.get<{ user: { name: string } | null; agent: string | null }>(
        "/api/me",
      );
      const path = configPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ url: client.cfg.url, token }, null, 2)}\n`, {
        mode: 0o600,
      });
      chmodSync(path, 0o600);
      if (ctx.json) return printJson({ config: path, ...me });
      out(
        `Signed in as ${me.user?.name ?? "household display"}${me.agent ? ` via agent:${me.agent}` : ""}. Saved ${path}`,
      );
    },
  },
};

function usage(): string {
  const width = Math.max(...Object.keys(commands).map((k) => k.length));
  const lines = Object.entries(commands).map(
    ([name, cmd]) => `  ${name.padEnd(width)}  ${cmd.summary}`,
  );
  return [
    "Usage: tuit <command> [args] [--json]",
    "",
    ...lines,
    "",
    "Ids may be shortened to any unique prefix. Times accept rough text: sat, tomorrow 9am,",
    "2026-10-03, +3d, yesterday. Actors: me, anyone, a person (sam), agent:<name>.",
    "Config: TUIT_URL and TUIT_TOKEN, else ~/.config/tuit/config.json (tuit login).",
    "Exit codes: 0 ok, 1 error, 2 usage, 3 not found, 4 conflict (re-read and retry).",
    "More: tuit help <command>",
  ].join("\n");
}

export async function main(argv: string[]): Promise<number> {
  let [name, ...rest] = argv;
  if (name === undefined || name.startsWith("-")) {
    rest = name === undefined ? [] : argv;
    name = "now";
  }
  if (name === "help" || name === "--help") {
    const cmd = rest[0] ? commands[rest[0]] : undefined;
    out(cmd ? `${cmd.usage}\n\n${cmd.summary}` : usage());
    return 0;
  }
  const cmd = commands[name];
  if (!cmd) {
    process.stderr.write(`Unknown command "${name}".\n\n${usage()}\n`);
    return EXIT.usage;
  }
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...JSON_OPT, ...cmd.options },
      allowPositionals: true,
      strict: true,
    }) as { values: Values; positionals: string[] };
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\nUsage: ${cmd.usage}\n`);
    return EXIT.usage;
  }
  if (parsed.values.help) {
    out(`${cmd.usage}\n\n${cmd.summary}`);
    return 0;
  }
  let client: Client | undefined;
  const ctx: Ctx = {
    values: parsed.values,
    args: parsed.positionals,
    json: !!parsed.values.json,
    client: () => {
      client ??= new Client(loadConfig());
      return client;
    },
  };
  try {
    await cmd.run(ctx);
    return 0;
  } catch (e) {
    if (e instanceof CliError) {
      if (ctx.json) process.stderr.write(`${JSON.stringify({ error: e.message, exit: e.code })}\n`);
      else process.stderr.write(`${e.message}\n`);
      if (e.code === EXIT.usage && !e.message.startsWith("Not configured")) {
        process.stderr.write(`Usage: ${cmd.usage}\n`);
      }
      return e.code;
    }
    throw e;
  }
}
