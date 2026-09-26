import type pg from "pg";
import type { Database } from "../db/db.ts";
import { addActivity, addEvent, writeTask } from "./tasks.ts";
import { describeMoment, momentEnd, momentStart } from "./time.ts";
import { type Task, taskFromRow } from "./types.ts";
import { assess, URGENT_DEADLINE_HOURS } from "./views.ts";

/** Insert a once-only marker; true if this is the first time. */
async function firstTime(
  c: pg.PoolClient,
  taskId: string,
  mark: string,
  key: string,
): Promise<boolean> {
  const r = await c.query(
    "INSERT INTO sweep_marks (task_id, mark, mark_key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [taskId, mark, key],
  );
  return r.rowCount === 1;
}

async function reopen(c: pg.PoolClient, t: Task, now: Date, note: string): Promise<void> {
  t.state = "open";
  t.waiting = null;
  t.revision += 1;
  t.updated_at = now.toISOString();
  await writeTask(c, t);
  await addActivity(c, null, t.id, "system", note, now, {
    data: { state: { from: "waiting", to: "open" } },
  });
  await addEvent(c, null, "became_available", { taskId: t.id }, now, { reason: note });
}

/**
 * The single owner of time-driven behaviour. Runs before every request and on a timer, so
 * results depend only on the clock, never on whether a background tick happened to run.
 */
export async function sweep(db: Database, now: Date): Promise<void> {
  await db.tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(4242002)");
    const rows = await c.query(
      "SELECT * FROM tasks WHERE state IN ('open', 'waiting') ORDER BY id FOR UPDATE",
    );
    const tasks = rows.rows.map(taskFromRow);
    const states = new Map<string, string>();
    const depIds = tasks.flatMap((t) => (t.waiting?.task_id ? [t.waiting.task_id] : []));
    if (depIds.length) {
      const deps = await c.query<{ id: string; state: string; title: string }>(
        "SELECT id, state, title FROM tasks WHERE id = ANY($1)",
        [depIds],
      );
      for (const d of deps.rows) states.set(d.id, d.state);
    }

    for (const t of tasks) {
      if (t.expires && momentEnd(t.expires) <= now) {
        const from = t.state;
        t.state = "expired";
        t.close_reason = `Expired ${describeMoment(t.expires, now)}`;
        t.closed_at = momentEnd(t.expires).toISOString();
        t.waiting = null;
        t.claim = null;
        t.revision += 1;
        t.updated_at = now.toISOString();
        await writeTask(c, t);
        await addActivity(
          c,
          null,
          t.id,
          "state_change",
          "Expired: its time passed without it being done",
          now,
          {
            data: { state: { from, to: "expired" } },
          },
        );
        await addEvent(c, null, "expired", { taskId: t.id }, now, { from });
        continue;
      }

      if (t.state === "waiting" && t.waiting?.kind === "until" && t.waiting.follow_up) {
        if (momentStart(t.waiting.follow_up) <= now) {
          await reopen(c, t, now, `The wait ended (${describeMoment(t.waiting.follow_up, now)})`);
        }
      } else if (t.state === "waiting" && t.waiting?.kind === "task" && t.waiting.task_id) {
        const depState = states.get(t.waiting.task_id);
        if (depState === "done") {
          await reopen(c, t, now, "The task this was waiting on is done");
        } else if (depState === "expired" || depState === "shelved") {
          await reopen(
            c,
            t,
            now,
            `The task this was waiting on was ${depState}, not done — check whether this still makes sense`,
          );
        }
      }

      const a = assess(t, now, undefined);
      if (
        t.state === "open" &&
        t.available_from &&
        a.available &&
        momentStart(t.available_from) <= now
      ) {
        if (await firstTime(c, t.id, "available", JSON.stringify(t.available_from))) {
          await addEvent(c, null, "became_available", { taskId: t.id }, now, {
            reason: "available_from reached",
          });
        }
      }
      if (a.routine && a.available && t.recurrence) {
        const key = a.routine.due_at.toISOString();
        if (await firstTime(c, t.id, "routine_due", key)) {
          await addEvent(
            c,
            null,
            t.recurrence.mode === "since_done" ? "routine_stale" : "routine_due",
            { taskId: t.id },
            now,
            {
              label: a.routine.label,
            },
          );
        }
      }
      if (
        t.deadline &&
        (momentEnd(t.deadline).getTime() - now.getTime()) / 3_600_000 <= URGENT_DEADLINE_HOURS
      ) {
        if (await firstTime(c, t.id, "deadline", JSON.stringify(t.deadline))) {
          await addEvent(c, null, "deadline_approaching", { taskId: t.id }, now, {
            deadline: t.deadline,
          });
        }
      }
      if (a.follow_up_due && t.waiting?.follow_up) {
        if (await firstTime(c, t.id, "follow_up", JSON.stringify(t.waiting.follow_up))) {
          await addEvent(c, null, "follow_up_due", { taskId: t.id }, now);
        }
      }
      if (t.claim && new Date(t.claim.expires_at) <= now) {
        if (await firstTime(c, t.id, "claim_lapsed", t.claim.id)) {
          const claim = t.claim;
          if (!claim.side_effects) {
            t.claim = null;
            t.revision += 1;
            t.updated_at = now.toISOString();
            await writeTask(c, t);
          }
          await addActivity(
            c,
            null,
            t.id,
            "system",
            claim.side_effects
              ? `agent:${claim.agent}'s claim lapsed. It may have taken external actions — check before retrying.`
              : `agent:${claim.agent}'s claim lapsed; returned to the pool`,
            now,
            { data: { claim } },
          );
          await addEvent(c, null, "claim_lapsed", { taskId: t.id }, now, {
            agent: claim.agent,
            needs_review: claim.side_effects,
          });
        }
      }
    }
  });
}
