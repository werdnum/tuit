import { z } from "zod";
import type { Clock } from "../clock.ts";
import type { Config } from "../config.ts";
import type { Database } from "../db/db.ts";
import { ForbiddenError, NotFoundError, ValidationError } from "../domain/errors.ts";
import { type FeedEvent, listChanges } from "../domain/feed.ts";
import { newId, type UserInfo, visibleSql } from "../domain/tasks.ts";
import { describeMoment } from "../domain/time.ts";
import { type Actor, type Principal, type Task, taskFromRow } from "../domain/types.ts";
import {
  ApnsChannel,
  allowedPushEndpoint,
  type Channel,
  type Device,
  type Message,
  vapidKeys,
  WebPushChannel,
} from "./channels.ts";
import {
  CATEGORY_LABELS,
  type Category,
  type Change,
  DEFAULT_QUIET,
  defaultRules,
  inQuietHours,
  match,
  type Quiet,
  type Rule,
  SettingsInput,
  withIds,
} from "./rules.ts";

export interface NotifySettings {
  quiet: Quiet | null;
  rules: Rule[];
}

export interface LogEntry {
  id: number;
  task: { id: string; title: string } | null;
  category: Category;
  rule_id: string;
  status: "sent" | "held" | "retry" | "undelivered";
  created_at: string;
  sent_at: string | null;
}

export const DeviceInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("web"),
      endpoint: z.string().url().max(2000),
      keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }).strict(),
      label: z.string().max(100).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("apns"),
      token: z
        .string()
        .regex(/^[0-9a-fA-F]{32,200}$/)
        .transform((s) => s.toLowerCase()),
      environment: z.enum(["sandbox", "production"]),
      label: z.string().max(100).optional(),
    })
    .strict(),
]);

const MAX_DEVICES = 20;
const PAGE = 200;
const LOG_DAYS = 30;
/** How many titles a quiet-hours summary names before "and N more". */
const SUMMARY_TITLES = 4;
/** How long a notification no device would take (a push service outage) keeps being retried. */
const RETRY_MS = 24 * 3600_000;

const human = (userId: string): Principal => ({
  userId,
  agent: null,
  canWrite: false,
  key: `user:${userId}`,
});

/**
 * Push notifications. Each person's notifications are decided from the change feed read *as
 * them*, so they can only ever hear about what they can see, and a per-person cursor in the
 * database means a restart neither repeats nor drops anything. Decisions are logged (ids, not
 * content) before anything is sent; the log's (person, event) key is what stops a change being
 * reported twice.
 */
export class Notifier {
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly config: Config;
  private readonly users: () => Promise<UserInfo[]>;
  private web: WebPushChannel | null = null;
  readonly apns: ApnsChannel | null;
  private publicKey: string | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private lastPrune = 0;

  constructor(db: Database, clock: Clock, config: Config, users: () => Promise<UserInfo[]>) {
    this.db = db;
    this.clock = clock;
    this.config = config;
    this.users = users;
    this.apns = config.apns ? new ApnsChannel(config.apns) : null;
  }

  /** The VAPID public key browsers subscribe with. */
  async webPushKey(): Promise<string> {
    await this.channels();
    return this.publicKey as string;
  }

  private async channels(): Promise<{ web: Channel; apns: Channel | null }> {
    if (!this.web) {
      const keys = await vapidKeys(this.db);
      const contact = this.config.users[0]?.email;
      this.web = new WebPushChannel(
        keys,
        contact ? `mailto:${contact}` : this.config.publicUrl.origin,
      );
      this.publicKey = keys.publicKey;
    }
    return { web: this.web, apns: this.apns };
  }

  // ---------------------------------------------------------------- settings

  private static person(p: Principal, write = false): string {
    // Settings and devices are the person's own: not an agent acting for them, not a display.
    if (!p.userId || p.agent !== null) {
      throw new ForbiddenError("Only you can see or change your own notifications");
    }
    if (write && !p.canWrite) throw new ForbiddenError("This token is read-only");
    return p.userId;
  }

  /** This person's settings, created with the defaults (starting from now) on first use. */
  async settings(p: Principal): Promise<NotifySettings> {
    const userId = Notifier.person(p);
    const existing = await this.db.query(
      `SELECT quiet_from, quiet_to, rules FROM notify_settings WHERE user_id = $1`,
      [userId],
    );
    if (existing.rows[0]) return settingsFromRow(existing.rows[0]);
    const cursor = Number((await listChanges(this.db, human(userId), "latest")).cursor);
    const fresh: NotifySettings = { quiet: DEFAULT_QUIET, rules: defaultRules() };
    await this.db.query(
      `INSERT INTO notify_settings (user_id, cursor, quiet_from, quiet_to, rules, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (user_id) DO NOTHING`,
      [userId, cursor, fresh.quiet?.from, fresh.quiet?.to, JSON.stringify(fresh.rules), this.now()],
    );
    return this.settings(p);
  }

  async saveSettings(p: Principal, raw: unknown): Promise<NotifySettings> {
    const userId = Notifier.person(p, true);
    const input = SettingsInput.parse(raw);
    const current = await this.settings(p);
    const next: NotifySettings = {
      quiet: input.quiet === undefined ? current.quiet : input.quiet,
      rules: input.rules === undefined ? current.rules : withIds(input.rules),
    };
    const ids = new Set(next.rules.map((r) => r.id));
    if (ids.size !== next.rules.length) throw new ValidationError("Two rules have the same id");
    await this.db.query(
      `UPDATE notify_settings SET quiet_from = $2, quiet_to = $3, rules = $4, updated_at = $5
       WHERE user_id = $1`,
      [
        userId,
        next.quiet?.from ?? null,
        next.quiet?.to ?? null,
        JSON.stringify(next.rules),
        this.now(),
      ],
    );
    // Ending quiet hours early releases what they were holding.
    this.kick();
    return next;
  }

  async devices(p: Principal): Promise<Device[]> {
    const userId = Notifier.person(p);
    const r = await this.db.query(
      `SELECT * FROM notify_devices WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return r.rows.map(deviceFromRow);
  }

  /**
   * Register (or re-register) a device. A device address belongs to whoever registered it
   * last, so a phone that changes hands stops receiving its old owner's notifications.
   */
  async addDevice(p: Principal, raw: unknown): Promise<Device> {
    const userId = Notifier.person(p, true);
    const input = DeviceInput.parse(raw);
    if (input.kind === "web" && !allowedPushEndpoint(input.endpoint, this.config.testClock)) {
      throw new ValidationError("That isn't a push service this server sends to");
    }
    if (input.kind === "apns" && !this.apns) {
      throw new ValidationError("iPhone notifications aren't set up on this server");
    }
    await this.settings(p);
    const address = input.kind === "web" ? input.endpoint : input.token;
    const count = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notify_devices WHERE user_id = $1 AND address <> $2`,
      [userId, address],
    );
    if ((count.rows[0]?.n ?? 0) >= MAX_DEVICES) {
      throw new ValidationError(`You can have up to ${MAX_DEVICES} devices; remove one first`);
    }
    const r = await this.db.query(
      `INSERT INTO notify_devices (id, user_id, kind, address, keys, environment, label, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (kind, address) DO UPDATE SET user_id = EXCLUDED.user_id, keys = EXCLUDED.keys,
         environment = EXCLUDED.environment, label = EXCLUDED.label, last_error = NULL
       RETURNING *`,
      [
        newId(),
        userId,
        input.kind,
        address,
        input.kind === "web" ? JSON.stringify(input.keys) : null,
        input.kind === "apns" ? input.environment : null,
        input.label?.trim() || (input.kind === "apns" ? "iPhone app" : "Browser"),
        this.now(),
      ],
    );
    return deviceFromRow(r.rows[0]);
  }

  /** Remove a device by id, or by its address (what the device itself knows). */
  async removeDevice(p: Principal, idOrAddress: string): Promise<void> {
    const userId = Notifier.person(p, true);
    const r = await this.db.query(
      `DELETE FROM notify_devices WHERE user_id = $1 AND (id = $2 OR address = lower($2) OR address = $2)`,
      [userId, idOrAddress],
    );
    if (r.rowCount === 0) throw new NotFoundError("No such device");
  }

  async recent(p: Principal, limit = 20): Promise<LogEntry[]> {
    const userId = Notifier.person(p);
    const r = await this.db.query(
      `SELECT l.*, t.title, (t.id IS NOT NULL) AS visible FROM notify_log l
       LEFT JOIN tasks t ON t.id = l.task_id AND ${visibleSql("t", 1)}
       WHERE l.user_id = $1 ORDER BY l.seq DESC LIMIT $2`,
      [userId, limit],
    );
    return r.rows.map((row) => ({
      id: row.id,
      task: row.visible ? { id: row.task_id, title: row.title } : null,
      category: row.category,
      rule_id: row.rule_id,
      status: row.status,
      created_at: row.created_at.toISOString(),
      sent_at: row.sent_at ? row.sent_at.toISOString() : null,
    }));
  }

  /** Send a test notification to every device; reports how many it reached. */
  async test(p: Principal): Promise<{ sent: number; failed: number }> {
    const userId = Notifier.person(p, true);
    const devices = await this.devices(p);
    if (devices.length === 0)
      throw new ValidationError("No devices yet: turn notifications on first");
    const ok = await this.deliver(userId, devices, {
      title: "Tuit",
      body: "Notifications are working on this device.",
      url: new URL("/settings/notifications", this.config.publicUrl).toString(),
      taskId: null,
      tag: "test",
    });
    return { sent: ok, failed: devices.length - ok };
  }

  // ---------------------------------------------------------------- dispatch

  /** Decide and send whatever is due. Calls while a run is in progress coalesce into one more. */
  kick(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.dispatchAll();
        } while (this.again);
      } catch (err) {
        console.error("notifications: dispatch failed", err);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  close(): void {
    this.apns?.close();
  }

  private now(): Date {
    return this.clock.now();
  }

  private async dispatchAll(): Promise<void> {
    const r = await this.db.query<{ user_id: string }>(`SELECT user_id FROM notify_settings`);
    for (const { user_id } of r.rows) await this.dispatchUser(user_id);
    if (Date.now() - this.lastPrune > 3600_000) {
      this.lastPrune = Date.now();
      await this.db.query(
        `DELETE FROM notify_log WHERE status NOT IN ('held', 'retry') AND created_at < $1`,
        [new Date(this.now().getTime() - LOG_DAYS * 86_400_000)],
      );
    }
  }

  private async dispatchUser(userId: string): Promise<void> {
    const p = human(userId);
    const row = (await this.db.query(`SELECT * FROM notify_settings WHERE user_id = $1`, [userId]))
      .rows[0];
    if (!row) return;
    const settings = settingsFromRow(row);
    let cursor = String(row.cursor);
    const devices = await this.devices(p);
    const users = await this.users();
    for (;;) {
      const page = await listChanges(this.db, p, cursor, PAGE);
      if (page.events.length === 0) break;
      const full = page.events.length === PAGE;
      const events = full ? withoutTrailingWrite(page.events) : page.events;
      // Without a device there's no one to tell; the cursor still moves, so turning
      // notifications on later doesn't replay the past.
      if (devices.length > 0) {
        const tasks = await this.visibleTasks(userId, events);
        for (const change of changesOf(events, tasks)) {
          await this.decide(userId, settings, devices, users, change);
        }
      }
      // A full page may end partway through one write's events: those wait for the next page,
      // so the write is still reported once.
      cursor = events === page.events ? page.cursor : String(events.at(-1)?.seq);
      await this.db.query(`UPDATE notify_settings SET cursor = $2 WHERE user_id = $1`, [
        userId,
        Number(cursor),
      ]);
      if (!full) break;
    }
    if (!inQuietHours(settings.quiet, this.now())) await this.release(userId, devices);
  }

  private async visibleTasks(userId: string, events: FeedEvent[]): Promise<Map<string, Task>> {
    const ids = [...new Set(events.map((e) => e.task?.id).filter((x): x is string => !!x))];
    const r = await this.db.query(
      `SELECT * FROM tasks t WHERE id = ANY($2::text[]) AND ${visibleSql("t", 1)}`,
      [userId, ids],
    );
    return new Map(r.rows.map((row) => [row.id as string, taskFromRow(row)]));
  }

  private async decide(
    userId: string,
    settings: NotifySettings,
    devices: Device[],
    users: UserInfo[],
    change: Change,
  ): Promise<void> {
    const m = match(change, userId, settings.rules);
    if (!m) return;
    const hold = !m.rule.quiet_ok && inQuietHours(settings.quiet, this.now());
    const logged = await this.db.query<{ id: number }>(
      `INSERT INTO notify_log (user_id, seq, task_id, category, rule_id, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (user_id, seq) DO NOTHING RETURNING id`,
      [
        userId,
        change.seq,
        change.task.id,
        m.category,
        m.rule.id,
        // Until delivery settles it, a row counts as a retry: a crash or a throw mid-send then
        // leaves it for release() instead of losing it behind the cursor.
        hold ? "held" : "retry",
        this.now(),
      ],
    );
    const id = logged.rows[0]?.id;
    if (id === undefined || hold) return;
    const msg = await this.render(userId, change, m.category, users);
    const ok = await this.deliver(userId, devices, msg);
    // Nothing took it but a device remains: a push service is failing, so try again later.
    const status = ok > 0 ? "sent" : devices.length > 0 ? "retry" : "undelivered";
    await this.db.query(
      `UPDATE notify_log SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN $3::timestamptz END
       WHERE id = $1`,
      [id, status, this.now()],
    );
  }

  /**
   * One notification for what quiet hours held or a push outage delayed, re-checked for
   * visibility. Runs outside quiet hours.
   */
  private async release(userId: string, devices: Device[]): Promise<void> {
    const r = await this.db.query(
      `SELECT l.id, l.category, l.status, l.created_at, t.id AS task_id, t.title,
         EXISTS (SELECT 1 FROM notify_log s WHERE s.user_id = l.user_id AND s.task_id = l.task_id
           AND s.seq > l.seq AND s.status = 'sent') AS superseded
       FROM notify_log l
       LEFT JOIN tasks t ON t.id = l.task_id AND ${visibleSql("t", 1)}
       WHERE l.user_id = $1 AND l.status IN ('held', 'retry') ORDER BY l.seq`,
      [userId],
    );
    if (r.rows.length === 0) return;
    // A task that broke through quiet hours later has already been seen.
    const visible = r.rows.filter((row) => row.task_id && !row.superseded);
    // One line per task, however many times it came up.
    const byTask = new Map<string, { title: string; category: Category }>();
    for (const row of visible)
      byTask.set(row.task_id, { title: row.title, category: row.category });
    const quiet = r.rows.every((row) => row.status === "held");
    let ok = 0;
    if (byTask.size > 0 && devices.length > 0) {
      const [first] = byTask.entries();
      const single = byTask.size === 1 && first;
      const titles = [...byTask.values()].map((v) => v.title);
      const more = titles.length - SUMMARY_TITLES;
      const msg: Message = single
        ? {
            title: first[1].title,
            body: `${quiet ? "While notifications were quiet" : "Earlier"}: ${CATEGORY_LABELS[first[1].category]}`,
            url: this.taskUrl(first[0]),
            taskId: first[0],
            tag: first[0],
          }
        : {
            title: quiet
              ? `${byTask.size} updates while notifications were quiet`
              : `${byTask.size} updates you haven't seen`,
            body:
              titles.slice(0, SUMMARY_TITLES).join(" · ") + (more > 0 ? ` · and ${more} more` : ""),
            url: new URL("/", this.config.publicUrl).toString(),
            taskId: null,
            tag: "quiet-summary",
          };
      ok = await this.deliver(userId, devices, msg);
    }
    // Still failing with devices to send to: keep retrying, but not forever.
    const giveUpBefore = this.now().getTime() - RETRY_MS;
    const settled = r.rows.filter(
      (row) =>
        byTask.size === 0 ||
        ok > 0 ||
        devices.length === 0 ||
        row.created_at.getTime() < giveUpBefore,
    );
    await this.db.query(
      `UPDATE notify_log SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN $3::timestamptz END
       WHERE id = ANY($1::bigint[])`,
      [settled.map((row) => row.id), ok > 0 ? "sent" : "undelivered", this.now()],
    );
    const superseded = r.rows.filter((row) => row.task_id && row.superseded).map((row) => row.id);
    if (superseded.length > 0) {
      await this.db.query(
        `UPDATE notify_log SET status = 'sent', sent_at = NULL WHERE id = ANY($1::bigint[])`,
        [superseded],
      );
    }
    // Rows for tasks that are no longer visible were never shown.
    const hidden = r.rows.filter((row) => !row.task_id).map((row) => row.id);
    if (hidden.length > 0) {
      await this.db.query(
        `UPDATE notify_log SET status = 'undelivered', sent_at = NULL WHERE id = ANY($1::bigint[])`,
        [hidden],
      );
    }
  }

  private taskUrl(id: string): string {
    return new URL(`/tasks/${id}`, this.config.publicUrl).toString();
  }

  private async render(
    userId: string,
    change: Change,
    category: Category,
    users: UserInfo[],
  ): Promise<Message> {
    const t = change.task;
    const name = (id: string | null) =>
      id === userId ? "you" : (users.find((u) => u.id === id)?.name ?? id ?? "someone");
    const who = change.actor.agent
      ? `agent:${change.actor.agent}`
      : change.actor.user
        ? name(change.actor.user)
        : "Tuit";
    const data = (type: string) => change.types.find((x) => x.type === type)?.data;
    // The task may have moved on since; say who this change handed it to.
    const to = (data("handed_off")?.to as Actor | undefined) ?? t.next_actor;
    const turn =
      to.kind === "user" ? name(to.user) : to.kind === "agent" ? `agent:${to.agent}` : "anyone";
    const next = t.next_action ? `Next: ${t.next_action}` : "";
    const join = (...parts: string[]) => parts.filter(Boolean).join(" · ");
    let body: string;
    switch (category) {
      case "handoff":
        body = join(`${who} handed this to ${turn}`, next);
        break;
      case "ready":
        if (data("follow_up_due")) body = join(`Time to chase: ${t.waiting?.for || "a reply"}`);
        else if (data("routine_due") || data("routine_stale")) {
          const d = data("routine_due") ?? data("routine_stale");
          body = join(String(d?.label ?? "Due again"), next);
        } else body = join("Ready now", next);
        break;
      case "deadline":
        body = join(
          t.deadline ? `Deadline ${describeMoment(t.deadline, this.now())}` : "Deadline",
          next,
        );
        break;
      case "claim": {
        const d = data("claim_lapsed") ?? {};
        body = d.needs_review
          ? `agent:${d.agent}'s claim lapsed. It may have done things already: check before retrying.`
          : `agent:${d.agent}'s claim lapsed; it's back in the pool.`;
        break;
      }
      case "closed":
        body =
          t.state === "done"
            ? `${who} marked it done`
            : t.state === "expired"
              ? join("No longer relevant", t.close_reason)
              : t.state === "shelved"
                ? join(`${who} shelved it`, t.close_reason)
                : `${who} finished it`;
        break;
      case "progress": {
        const note = await this.db.query<{ body: string }>(
          `SELECT body FROM activity WHERE task_id = $1 AND recorded_at = $2
             AND kind NOT IN ('system', 'edit') ORDER BY id DESC LIMIT 1`,
          [t.id, change.at],
        );
        const text = (note.rows[0]?.body ?? "").replace(/\s+/g, " ").trim();
        body = text ? `${who} wrote: ${clip(text, 180)}` : `${who} recorded progress`;
        break;
      }
      case "created":
        body = join(`${who} added this${t.area ? ` to #${t.area}` : ""}`, next);
        break;
    }
    return { title: clip(t.title, 120), body, url: this.taskUrl(t.id), taskId: t.id, tag: t.id };
  }

  /** Send to every device; returns how many took it. Devices that are gone are forgotten. */
  private async deliver(userId: string, devices: Device[], msg: Message): Promise<number> {
    const { web, apns } = await this.channels();
    const results = await Promise.all(
      devices.map(async (d) => {
        const channel = d.kind === "web" ? web : apns;
        if (!channel) return { d, out: { ok: false as const, gone: false, error: "not set up" } };
        try {
          return { d, out: await channel.send(d, msg) };
        } catch (err) {
          return { d, out: { ok: false as const, gone: false, error: String(err) } };
        }
      }),
    );
    let ok = 0;
    for (const { d, out } of results) {
      if (out.ok) {
        ok++;
        await this.db.query(
          `UPDATE notify_devices SET last_sent_at = $2, last_error = NULL,
             environment = COALESCE($3, environment) WHERE id = $1`,
          [d.id, this.now(), out.environment ?? null],
        );
      } else if (out.gone) {
        await this.db.query(`DELETE FROM notify_devices WHERE id = $1 AND user_id = $2`, [
          d.id,
          userId,
        ]);
        devices.splice(devices.indexOf(d), 1);
      } else {
        console.error(`notifications: ${d.kind} device ${d.id}: ${out.error}`);
        await this.db.query(`UPDATE notify_devices SET last_error = $2 WHERE id = $1`, [
          d.id,
          out.error,
        ]);
      }
    }
    return ok;
  }
}

/**
 * Feed events grouped into changes: the events one write produced (a checkpoint that hands
 * off and changes state is one change, reported once). Events for tasks this person can't
 * see, and queue events, are dropped.
 */
export function changesOf(events: FeedEvent[], tasks: Map<string, Task>): Change[] {
  const out: Change[] = [];
  let last: (Change & { key: string }) | null = null;
  for (const e of events) {
    const task = e.task ? tasks.get(e.task.id) : undefined;
    if (!task) {
      last = null;
      continue;
    }
    const key = `${task.id}|${e.at}|${e.actor.user}|${e.actor.agent}`;
    if (last && last.key === key) {
      last.types.push({ type: e.type, data: e.data });
      continue;
    }
    last = {
      key,
      seq: e.seq,
      at: e.at,
      types: [{ type: e.type, data: e.data }],
      actor: e.actor,
      task,
    };
    out.push(last);
  }
  return out;
}

/** A page without the events of its last write, unless that write is the whole page. */
export function withoutTrailingWrite(events: FeedEvent[]): FeedEvent[] {
  const last = events.at(-1);
  if (!last) return events;
  const key = (e: FeedEvent) => `${e.task?.id}|${e.at}|${e.actor.user}|${e.actor.agent}`;
  let i = events.length;
  while (i > 0 && key(events[i - 1] as FeedEvent) === key(last)) i--;
  return i === 0 ? events : events.slice(0, i);
}

// biome-ignore lint/suspicious/noExplicitAny: raw pg row
function settingsFromRow(row: any): NotifySettings {
  const hhmm = (v: string | null) => (v ? v.slice(0, 5) : null);
  const from = hhmm(row.quiet_from);
  const to = hhmm(row.quiet_to);
  return { quiet: from && to ? { from, to } : null, rules: row.rules as Rule[] };
}

// biome-ignore lint/suspicious/noExplicitAny: raw pg row
function deviceFromRow(row: any): Device {
  return {
    id: row.id,
    user_id: row.user_id,
    kind: row.kind,
    address: row.address,
    keys: row.keys,
    environment: row.environment,
    label: row.label,
    created_at: row.created_at.toISOString(),
    last_sent_at: row.last_sent_at ? row.last_sent_at.toISOString() : null,
    last_error: row.last_error,
  };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
