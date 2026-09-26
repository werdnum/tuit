import { DateTime } from "luxon";
import { ValidationError } from "./errors.ts";

export const ZONE = process.env.TUIT_TIMEZONE ?? "Australia/Sydney";

/** A calendar date in the household zone, or an exact instant. Never interchangeable. */
export type Moment = { date: string } | { at: string };

export function isDate(m: Moment): m is { date: string } {
  return "date" in m;
}

export function local(d: Date): DateTime {
  return DateTime.fromJSDate(d, { zone: ZONE });
}

export function localDate(d: Date): string {
  return local(d).toISODate() as string;
}

/** When a moment begins: local midnight for a date. Used for "available from", "follow up". */
export function momentStart(m: Moment): Date {
  if (isDate(m)) return DateTime.fromISO(m.date, { zone: ZONE }).startOf("day").toJSDate();
  return new Date(m.at);
}

/** When a moment is over: the end of the local day for a date. Used for deadline and expiry. */
export function momentEnd(m: Moment): Date {
  if (isDate(m)) {
    return DateTime.fromISO(m.date, { zone: ZONE }).plus({ days: 1 }).startOf("day").toJSDate();
  }
  return new Date(m.at);
}

export function addDays(m: Moment, days: number): Moment {
  if (isDate(m)) {
    return { date: DateTime.fromISO(m.date, { zone: ZONE }).plus({ days }).toISODate() as string };
  }
  return { at: DateTime.fromISO(m.at, { zone: ZONE }).plus({ days }).toUTC().toISO() as string };
}

export function momentFromColumns(date: string | null, at: Date | null): Moment | null {
  if (date) return { date };
  if (at) return { at: at.toISOString() };
  return null;
}

export function momentToColumns(m: Moment | null): [string | null, string | null] {
  if (!m) return [null, null];
  return isDate(m) ? [m.date, null] : [null, m.at];
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function parseTimeOfDay(s: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s.trim().toLowerCase());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const ampm = m[3];
  if (!ampm && !m[2]) return null;
  if (ampm && (hour < 1 || hour > 12)) return null;
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function parseDayWord(s: string, today: DateTime): DateTime | null {
  const w = s.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) {
    const d = DateTime.fromISO(w, { zone: ZONE });
    return d.isValid ? d : null;
  }
  if (w === "today") return today;
  if (w === "tomorrow" || w === "tmrw") return today.plus({ days: 1 });
  if (w === "yesterday") return today.minus({ days: 1 });
  const rel = /^(?:in\s+)?\+?(\d+)\s*(d|day|days|w|wk|week|weeks)$/.exec(w);
  if (rel) {
    const n = Number(rel[1]);
    return rel[2]?.startsWith("w") ? today.plus({ weeks: n }) : today.plus({ days: n });
  }
  const ago = /^(\d+)\s*(d|day|days|w|week|weeks)\s+ago$/.exec(w);
  if (ago) {
    const n = Number(ago[1]);
    return ago[2]?.startsWith("w") ? today.minus({ weeks: n }) : today.minus({ days: n });
  }
  const wd = /^(last\s+|next\s+)?([a-z]+)$/.exec(w);
  const word = wd?.[2];
  if (wd && word) {
    const idx = WEEKDAYS.findIndex((d) => d.startsWith(word) && word.length >= 3);
    if (idx >= 0) {
      const target = idx + 1;
      if (wd[1]?.startsWith("last")) {
        let delta = today.weekday - target;
        if (delta <= 0) delta += 7;
        return today.minus({ days: delta });
      }
      let delta = target - today.weekday;
      if (delta < 0 || (delta === 0 && wd[1])) delta += 7;
      return today.plus({ days: delta });
    }
  }
  return null;
}

/**
 * Parse rough human input into a Moment. A bare day ("saturday", "2026-10-03", "+3d") is a
 * calendar date; adding a time ("sat 9am", "2026-10-03 09:30") makes it an instant in the
 * household zone. ISO timestamps with an offset are instants as given.
 */
export function parseMoment(input: string, now: Date): Moment {
  const s = input.trim();
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = DateTime.fromISO(s);
    if (!d.isValid) throw new ValidationError(`Can't understand time "${input}"`);
    return { at: d.toUTC().toISO() as string };
  }
  const today = local(now).startOf("day");
  const isoLocal = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2})$/.exec(s);
  if (isoLocal) {
    const d = DateTime.fromISO(`${isoLocal[1]}T${(isoLocal[2] as string).padStart(5, "0")}`, {
      zone: ZONE,
    });
    if (d.isValid) return { at: d.toUTC().toISO() as string };
  }
  const day = parseDayWord(s, today);
  if (day) return { date: day.toISODate() as string };
  // "<day> <time>" or "<time>" alone (meaning today)
  const parts = s.split(/\s+(?:at\s+)?/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const dayPart = parts.slice(0, i).join(" ");
    const timePart = parts.slice(i).join(" ");
    const tod = parseTimeOfDay(timePart);
    if (!tod) continue;
    const base = dayPart ? parseDayWord(dayPart, today) : today;
    if (!base) continue;
    return { at: base.set(tod).toUTC().toISO() as string };
  }
  throw new ValidationError(`Can't understand time "${input}"`);
}

/** Accept either a structured Moment or a rough string. */
export function toMoment(v: Moment | string | null | undefined, now: Date): Moment | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") return parseMoment(v, now);
  if (isDate(v)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) throw new ValidationError(`Bad date "${v.date}"`);
    return v;
  }
  const d = new Date(v.at);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`Bad instant "${v.at}"`);
  return { at: d.toISOString() };
}

export function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 86_400_000;
}

/** Human description relative to now, in the household zone. */
export function describeMoment(m: Moment, now: Date): string {
  const today = local(now).startOf("day");
  if (isDate(m)) {
    const d = DateTime.fromISO(m.date, { zone: ZONE });
    const diff = Math.round(d.diff(today, "days").days);
    if (diff === 0) return "today";
    if (diff === 1) return "tomorrow";
    if (diff === -1) return "yesterday";
    if (diff > 1 && diff < 7) return d.toFormat("cccc");
    return d.toFormat(d.year === today.year ? "ccc d LLL" : "d LLL yyyy");
  }
  const d = DateTime.fromISO(m.at, { zone: ZONE });
  const dayDiff = Math.round(d.startOf("day").diff(today, "days").days);
  const time = d.toFormat(d.minute === 0 ? "ha" : "h:mma").toLowerCase();
  if (dayDiff === 0) return `today ${time}`;
  if (dayDiff === 1) return `tomorrow ${time}`;
  if (dayDiff === -1) return `yesterday ${time}`;
  if (dayDiff > 1 && dayDiff < 7) return `${d.toFormat("cccc")} ${time}`;
  return `${d.toFormat(d.year === today.year ? "ccc d LLL" : "d LLL yyyy")} ${time}`;
}

/** "3h ago", "yesterday", "18 days ago" — counted in calendar days in the household zone. */
export function describeAgo(then: Date, now: Date): string {
  const days = Math.round(local(now).startOf("day").diff(local(then).startOf("day"), "days").days);
  if (days <= 0) {
    const hours = Math.floor((now.getTime() - then.getTime()) / 3_600_000);
    if (hours <= 0) return "just now";
    return `${hours}h ago`;
  }
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function describeUntil(then: Date, now: Date): string {
  const ms = then.getTime() - now.getTime();
  if (ms <= 0) return describeAgo(then, now);
  const hours = ms / 3_600_000;
  if (hours < 1) return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48) return `in ${Math.round(hours)}h`;
  return `in ${Math.round(hours / 24)} days`;
}
