import { html } from "hono/html";
import { DateTime } from "luxon";
import type { UserInfo } from "../domain/tasks.ts";
import { describeAgo, describeMoment, isDate, type Moment, ZONE } from "../domain/time.ts";
import type { ActivityEntry, Actor, Principal, Task } from "../domain/types.ts";
import type { Html } from "./layout.ts";

export function userName(id: string | null, users: UserInfo[], me: Principal): string {
  if (!id) return "system";
  if (id === me.userId) return "you";
  return users.find((u) => u.id === id)?.name ?? id;
}

export function actorText(a: Actor, users: UserInfo[], me: Principal): string {
  if (a.kind === "anyone") return "anyone";
  if (a.kind === "agent") return `agent:${a.agent}`;
  return userName(a.user, users, me);
}

const cap = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s);

/**
 * A calendar date and an exact instant read differently: "Sat 3 Oct (all day)" versus
 * "Sat 3 Oct, 9:30am". The relative phrase comes first when it adds something.
 */
export function momentHtml(m: Moment, now: Date): Html {
  const rel = describeMoment(m, now);
  if (isDate(m)) {
    const d = DateTime.fromISO(m.date, { zone: ZONE });
    const abs = d.toFormat("ccc d LLL yyyy");
    return html`<time class="moment date" datetime="${m.date}">${cap(rel)}${rel === d.toFormat("ccc d LLL") ? "" : html` <span class="muted">(${abs})</span>`} <span class="moment-kind">all day</span></time>`;
  }
  const d = DateTime.fromISO(m.at, { zone: ZONE });
  const abs = d.toFormat("ccc d LLL yyyy, h:mma").replace(/AM|PM/, (x) => x.toLowerCase());
  return html`<time class="moment instant" datetime="${m.at}">${cap(rel)} <span class="muted">(${abs})</span></time>`;
}

/** How a moment is prefilled into a rough-text input so it round-trips through parseMoment. */
export function momentEditText(m: Moment | null): string {
  if (!m) return "";
  if (isDate(m)) return m.date;
  return DateTime.fromISO(m.at, { zone: ZONE }).toFormat("yyyy-LL-dd HH:mm");
}

export function whenText(iso: string, now: Date): string {
  const d = DateTime.fromISO(iso, { zone: ZONE });
  const today = DateTime.fromJSDate(now, { zone: ZONE }).startOf("day");
  const days = Math.round(d.startOf("day").diff(today, "days").days);
  const time = d.toFormat("h:mma").toLowerCase();
  if (days === 0) return `Today ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  return `${d.toFormat(d.year === today.year ? "ccc d LLL" : "d LLL yyyy")} ${time}`;
}

export function agoText(iso: string, now: Date): string {
  return describeAgo(new Date(iso), now);
}

export function stateBadge(t: Task): Html {
  if (t.state === "open") return html``;
  return html`<span class="badge ${t.state}">${t.state}</span>`;
}

export function privateBadge(t: Task): Html {
  return t.visibility === "private" ? html`<span class="badge private">private</span>` : html``;
}

export function authorHtml(e: ActivityEntry, users: UserInfo[], me: Principal): Html {
  if (e.author.agent) {
    return html`<span class="badge agent">agent:${e.author.agent}</span>
      <span class="muted">for ${userName(e.author.user, users, me)}</span>`;
  }
  return html`<span>${cap(userName(e.author.user, users, me))}</span>`;
}

/** Everyday history hides field edits and bookkeeping; the inspect view shows them. */
export const QUIET_KINDS = new Set(["edit", "system"]);

const KIND_LABEL: Record<string, string> = {
  research: "Research",
  decision: "Decision",
  attempt: "Attempt",
};

export function activityText(
  e: ActivityEntry,
  t: Task,
  users: UserInfo[],
  me: Principal,
): { head: string; body: string } {
  const data = e.data as {
    handed_to?: Actor;
    state?: { from: string; to: string };
    waiting?: { for?: string };
    reported_as?: Moment;
  };
  switch (e.kind) {
    case "created":
      return { head: "Captured", body: e.body };
    case "completion":
      return {
        head: t.recurrence ? "Did it" : "Done",
        body: e.body === "Recorded when created" ? "" : e.body,
      };
    case "skip":
      return { head: "Skipped this time", body: e.body };
    case "state_change":
      return { head: e.body || `Now ${data.state?.to ?? ""}`, body: "" };
    case "edit":
      return { head: e.body, body: "" };
    case "system":
      return { head: "System", body: e.body };
    default: {
      const bits: string[] = [];
      if (data.handed_to) bits.push(`Handed to ${actorText(data.handed_to, users, me)}`);
      if (data.state?.to === "waiting") {
        bits.push(`Waiting${data.waiting?.for ? ` for ${data.waiting.for}` : ""}`);
      } else if (data.state?.to === "open") bits.push("Back in play");
      const label = KIND_LABEL[e.kind] ?? "Note";
      return { head: bits.length ? bits.join(" · ") : label, body: e.body };
    }
  }
}
