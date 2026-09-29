import { html, raw } from "hono/html";
import type { DateTime } from "luxon";
import type { TokenInfo } from "../api/auth.ts";
import type { Config } from "../config.ts";
import type { NowView, Queue } from "../domain/board.ts";
import type { UserInfo } from "../domain/tasks.ts";
import { local, type Moment } from "../domain/time.ts";
import type { ActivityEntry, Principal, Task } from "../domain/types.ts";
import type { Explanation, QueueItem, QueueResult, TaskStatus } from "../domain/views.ts";
import {
  activityText,
  actorText,
  agoText,
  authorHtml,
  momentEditText,
  momentHtml,
  privateBadge,
  QUIET_KINDS,
  stateBadge,
  whenText,
} from "./format.ts";
import { backLink, type Flash, type Html, type LiveMark, page, settingsLink } from "./layout.ts";
import { markdownHtml } from "./markdown.ts";

export interface Ctx {
  me: Principal;
  users: UserInfo[];
  now: Date;
  flash: Flash | null;
  /** Where this page was rendered, for live updates: the feed cursor and the server time. */
  live: LiveMark;
}

const back = (to: string) => html`<input type="hidden" name="back" value="${to}">`;

function doneForm(t: Task, backTo: string): Html {
  return html`<form class="tickform" method="post" action="/tasks/${t.id}/done">${back(backTo)}<button class="tick" aria-label="Done: ${t.title}" title="Done"></button></form>`;
}

function itemRow(
  item: { task: Task; why: string; urgent?: boolean },
  opts: { done?: boolean; tick?: boolean; backTo: string; badge?: boolean },
): Html {
  const t = item.task;
  const cls = [opts.done ? "done" : "", item.urgent ? "urgent" : ""].join(" ").trim();
  const tick = opts.tick !== false;
  const tickHtml = opts.done
    ? html`<span class="tick" role="img" aria-label="Done"></span>`
    : tick
      ? doneForm(t, opts.backTo)
      : "";
  return html`<li class="${cls}" data-task="${t.id}">
    ${tickHtml}
    <a class="row-main ${tick ? "" : "solo"}" href="/tasks/${t.id}">
      <span class="row-title">${t.title} ${opts.badge ? stateBadge(t) : ""} ${privateBadge(t)}</span>
      ${item.why ? html`<span class="row-why">${item.why}</span>` : ""}
    </a>
    <span class="chev" aria-hidden="true">›</span>
  </li>`;
}

/** "next: Alex" says nothing to Alex about his own list. */
function quiet(ctx: Ctx, items: QueueItem[]): QueueItem[] {
  const mine = ctx.users.find((u) => u.id === ctx.me.userId)?.name;
  return items.map((i) => (mine && i.why === `next: ${mine}` ? { ...i, why: "" } : i));
}

function list(rows: Html[], label: string): Html {
  return html`<ul class="list" aria-label="${label}">${rows}</ul>`;
}

function urgentStrip(items: QueueItem[], backTo: string, label = "Time-critical"): Html {
  if (items.length === 0) return html``;
  return html`<section class="strip" aria-label="Urgent">
    <h2>${label}</h2>
    ${list(
      items.map((i) => itemRow(i, { backTo })),
      "Urgent",
    )}
  </section>`;
}

function topTitle(title: string, sub?: string): Html {
  return html`<div><div class="title">${title}</div>${sub ? html`<div class="date">${sub}</div>` : ""}</div>${settingsLink()}`;
}

// ---------------------------------------------------------------- Now

function awayBanner(away: NonNullable<NowView["away"]>, ctx: Ctx): Html {
  const bits: Html[] = [];
  if (away.expired) {
    bits.push(html`<a href="/queues/closed">${away.expired} expired</a>`);
  }
  if (away.handed_to_you) bits.push(html`${away.handed_to_you} handed to you`);
  if (away.became_due) {
    bits.push(html`${away.became_due} ${away.became_due === 1 ? "routine" : "routines"} came due`);
  }
  const days = Math.max(
    1,
    Math.round((ctx.now.getTime() - new Date(away.since).getTime()) / 86_400_000),
  );
  return html`<div class="banner" role="status" data-away>
    <strong>Welcome back.</strong>
    ${
      bits.length
        ? html`While you were away (${days} days): ${bits.map((b, i) => html`${i ? ", " : ""}${b}`)}.`
        : html`Nothing slipped while you were away.`
    }
    Here's what matters now.
  </div>`;
}

export function nowPage(ctx: Ctx, v: NowView): Html {
  const isUrgentOpen = (x: { item: QueueItem; done: boolean }) => x.item.urgent && !x.done;
  const urgentIds = new Set(v.urgent.map((i) => i.task.id));
  const urgent = [...v.urgent];
  for (const i of [...v.plan.filter(isUrgentOpen).map((x) => x.item), ...v.new_items]) {
    if (i.urgent && !urgentIds.has(i.task.id)) {
      urgentIds.add(i.task.id);
      urgent.push(i);
    }
  }
  const plan = v.plan
    .filter((x) => !isUrgentOpen(x))
    .map((x) => ({ ...x, item: quiet(ctx, [x.item])[0] as QueueItem }));
  const fresh = quiet(
    ctx,
    v.new_items.filter((i) => !i.urgent),
  );
  const enough = v.enough_until !== null;
  const resting = (v as { resting_count?: number }).resting_count ?? 0;
  const allDone = plan.length > 0 && plan.every((x) => x.done);
  const nothing = plan.length === 0 && fresh.length === 0 && urgent.length === 0;

  const capture = html`<form class="capture" method="post" action="/capture" data-capture>
    ${back("/")}
    <input type="text" name="title" aria-label="Capture a task" placeholder="Add something…" autocomplete="off" autocapitalize="sentences" enterkeyhint="done" required maxlength="500">
    <button class="primary" aria-label="Add">Add</button>
  </form>`;

  const shortlist = enough
    ? html`<section class="calm card" data-enough>
        <div class="big">Enough for now.</div>
        <p class="muted">${resting ? `${resting} ${resting === 1 ? "thing is" : "things are"} resting. ` : ""}The rest will keep. Only time-critical things show until tomorrow morning.</p>
        <form method="post" action="/now/enough">${back("/")}<input type="hidden" name="on" value="0"><button class="quiet">Show anyway</button></form>
      </section>`
    : html`
      ${
        plan.length
          ? html`<h2>Today</h2>${list(
              plan.map((x) => itemRow(x.item, { done: x.done, backTo: "/" })),
              "Today",
            )}`
          : ""
      }
      ${allDone ? html`<p class="center muted" data-all-done>That's the list. Nicely done.</p>` : ""}
      ${
        fresh.length
          ? html`<h2>${plan.length ? "New since this morning" : "Today"}</h2>${list(
              fresh.map((i) => itemRow(i, { backTo: "/" })),
              plan.length ? "New since this morning" : "Today",
            )}`
          : ""
      }
      ${
        nothing
          ? html`<div class="empty" data-empty>
              <div class="big">Nothing needs you right now.</div>
              <div>Anything you add above will wait here until it matters.</div>
            </div>`
          : ""
      }
      <div class="actions">
        ${
          v.more_count > 0
            ? html`<form method="post" action="/now/more">${back("/")}<button class="wide">Show more (${v.more_count})</button></form>`
            : ""
        }
        ${
          plan.length || fresh.length
            ? html`<form method="post" action="/now/enough">${back("/")}<input type="hidden" name="on" value="1"><button class="wide quiet">Enough for now</button></form>`
            : ""
        }
      </div>`;

  const today = local(ctx.now).toFormat("cccc d LLLL");
  return page({
    title: "Now",
    tab: "now",
    flash: ctx.flash,
    live: ctx.live,
    top: topTitle("Now", today),
    body: html`
      ${capture}
      ${v.away ? awayBanner(v.away, ctx) : ""}
      ${urgentStrip(urgent, "/")}
      ${shortlist}
      ${
        v.waiting_count
          ? html`<p class="center"><a class="btn quiet" href="/queues/waiting">${v.waiting_count} waiting on something →</a></p>`
          : ""
      }
    `,
  });
}

// ---------------------------------------------------------------- Task detail

function snoozePresets(now: Date): { label: string; at: string }[] {
  const l = local(now);
  const at = (d: DateTime) => d.set({ second: 0, millisecond: 0 }).toUTC().toISO() as string;
  const out: { label: string; at: string }[] = [];
  if (l.hour < 17) out.push({ label: "This evening", at: at(l.set({ hour: 18, minute: 0 })) });
  out.push({ label: "Tomorrow", at: at(l.plus({ days: 1 }).set({ hour: 8, minute: 0 })) });
  const toSat = (6 - l.weekday + 7) % 7 || 7;
  out.push({ label: "Weekend", at: at(l.plus({ days: toSat }).set({ hour: 9, minute: 0 })) });
  const toMon = (8 - l.weekday) % 7 || 7;
  out.push({ label: "Next week", at: at(l.plus({ days: toMon }).set({ hour: 8, minute: 0 })) });
  return out;
}

export interface Conflict {
  mine: string;
}

export function detailPage(
  ctx: Ctx,
  d: {
    task: Task;
    status: TaskStatus;
    activity: ActivityEntry[];
    showAll: boolean;
    conflict?: Conflict;
    picker: Config["googlePicker"];
  },
): Html {
  const { task: t, status: s } = d;
  const self = `/tasks/${t.id}`;
  const rev = html`<input type="hidden" name="expected_revision" value="${t.revision}">`;
  const closed = t.state === "done" || t.state === "expired" || t.state === "shelved";
  const routine = !!t.recurrence;
  const isOwner = t.owner === ctx.me.userId;
  const { users, me, now } = ctx;

  const statusLine = closed
    ? ""
    : s.urgent
      ? html`<p class="status urgent" data-status>${s.urgent}</p>`
      : s.label || s.held
        ? html`<p class="status" data-status>${s.label || s.held}</p>`
        : "";

  const nextLine = closed
    ? html`<p class="next">${
        t.state === "done"
          ? html`Done ${t.closed_at ? agoText(t.closed_at, now) : ""}.`
          : t.state === "expired"
            ? html`No longer relevant${t.close_reason ? html` — ${t.close_reason}` : ""}.`
            : html`Shelved${t.close_reason ? html` — ${t.close_reason}` : ""}. Still here if it warms up.`
      }</p>`
    : html`<p class="next" data-next>Next: <strong>${actorText(t.next_actor, users, me)}</strong>${t.next_action ? html` — ${t.next_action}` : ""}</p>`;

  const waitingBox =
    t.state === "waiting" && t.waiting
      ? html`<div class="card pad" data-waiting>
          <div>Waiting${t.waiting.for ? html` for <strong>${t.waiting.for}</strong>` : ""} since ${agoText(t.waiting.since, now)}.</div>
          ${t.waiting.follow_up ? html`<div class="small muted">Follow up ${momentHtml(t.waiting.follow_up, now)}</div>` : ""}
          <form method="post" action="${self}/resume" class="actions">
            ${back(self)}${rev}
            <input type="text" name="note" placeholder="What came back? (optional)" aria-label="What came back">
            <button>It's back with us</button>
          </form>
        </div>`
      : "";

  const snoozed = s.snoozed_until
    ? html`<div class="linkrow small muted" data-snoozed>Snoozed until ${momentHtml({ at: s.snoozed_until }, now)}
        <form class="inline" method="post" action="${self}/snooze">${back(self)}<button class="quiet" name="until" value="">Unsnooze</button></form></div>`
    : "";

  const doneEarlier = (label: string) => html`<details class="sheet" name="verb">
      <summary>${label}</summary>
      <div class="body">
        <form method="post" action="${self}/done" class="presets">
          ${back(self)}
          <button name="at" value="yesterday">Yesterday</button>
          <button name="at" value="2 days ago">2 days ago</button>
        </form>
        <form method="post" action="${self}/done">
          ${back(self)}
          <label class="field"><span>Or pick a date</span><input type="date" name="at" max="${local(now).toISODate()}" required></label>
          <button class="wide">Record it</button>
        </form>
      </div>
    </details>`;

  const primary = closed
    ? html`<form method="post" action="${self}/reopen" class="actions">${back(self)}${rev}<button class="primary wide">Reopen</button></form>`
    : html`<form method="post" action="${self}/done" class="actions">${back(self)}<button class="primary wide">${routine ? "Did it" : "Done"}</button></form>`;

  const handoffOptions = [
    ...users.map((u) => ({
      value: u.id,
      label: u.id === me.userId ? `Me (${u.name})` : u.name,
    })),
    { value: "anyone", label: "Anyone" },
    { value: "agent", label: "An agent…" },
  ];

  const verbs = closed
    ? ""
    : html`<div class="verbs">
        ${doneEarlier(routine ? "Did it earlier…" : "Done earlier…")}
        ${
          routine
            ? html`<form method="post" action="${self}/skip">${back(self)}<button>Skip this time</button></form>`
            : ""
        }
        <details class="sheet" name="verb">
          <summary>Waiting for…</summary>
          <div class="body">
            <form method="post" action="${self}/waiting">
              ${back(self)}${rev}
              <label class="field"><span>What or who</span><input type="text" name="for" required placeholder="e.g. quote from the plumber"></label>
              <label class="field"><span>Follow up (optional)</span><input type="text" name="follow_up" placeholder="e.g. fri, +3d, 2026-10-10"></label>
              <button class="wide">Mark waiting</button>
            </form>
          </div>
        </details>
        <details class="sheet" name="verb">
          <summary>Snooze</summary>
          <div class="body">
            <form method="post" action="${self}/snooze" class="presets">
              ${back(self)}
              ${snoozePresets(now).map((p) => html`<button name="until" value="${p.at}">${p.label}</button>`)}
            </form>
            <form method="post" action="${self}/snooze">
              ${back(self)}
              <label class="field"><span>Or until…</span><input type="text" name="until" required placeholder="e.g. thu, tomorrow 9am, +3d"></label>
              <button class="wide">Snooze</button>
            </form>
          </div>
        </details>
        <details class="sheet" name="verb">
          <summary>Hand off</summary>
          <div class="body">
            <form method="post" action="${self}/handoff">
              ${back(self)}${rev}
              <label class="field"><span>To</span><select name="to">${handoffOptions.map(
                (o) => html`<option value="${o.value}">${o.label}</option>`,
              )}</select></label>
              <label class="field"><span>Agent name (if an agent)</span><input type="text" name="agent" placeholder="e.g. family-assistant" autocapitalize="off"></label>
              <label class="field"><span>Next action</span><input type="text" name="next_action" value="${t.next_action}" placeholder="What should they do next?"></label>
              <label class="field"><span>Note</span><textarea name="note" placeholder="Context for them (optional)"></textarea></label>
              <button class="wide">Hand off</button>
            </form>
          </div>
        </details>
        <details class="sheet" name="verb">
          <summary>No longer relevant</summary>
          <div class="body">
            <form method="post" action="${self}/close">
              ${back(self)}${rev}<input type="hidden" name="state" value="expired">
              <label class="field"><span>Why (optional)</span><input type="text" name="reason" placeholder="e.g. the event was cancelled"></label>
              <button class="wide danger">Mark no longer relevant</button>
            </form>
          </div>
        </details>
        <details class="sheet" name="verb">
          <summary>Shelve</summary>
          <div class="body">
            <p class="small muted">Out of rotation, still searchable. Not saying it doesn't matter.</p>
            <form method="post" action="${self}/close">
              ${back(self)}${rev}<input type="hidden" name="state" value="shelved">
              <label class="field"><span>Note (optional)</span><input type="text" name="reason"></label>
              <button class="wide">Shelve it</button>
            </form>
          </div>
        </details>
      </div>`;

  const note = html`<details class="sheet" ${closed ? "" : raw("open")}>
      <summary>Add note</summary>
      <div class="body">
        <form method="post" action="${self}/note">
          ${back(self)}
          <textarea name="note" aria-label="Note" required placeholder="Progress, a phone number, what you tried…"></textarea>
          <div class="actions"><button class="wide">Add note</button></div>
        </form>
      </div>
    </details>`;

  const briefSection = d.conflict
    ? html`<section class="card pad" data-conflict role="alert">
        <p><strong>Someone else changed the brief while you were editing.</strong> Nothing was lost — here's theirs, and yours is below to merge and save.</p>
        <p class="small muted">Current brief</p>
        <div class="brief md" data-current-brief>${t.brief ? markdownHtml(t.brief) : html`<span class="muted">(empty)</span>`}</div>
        <form method="post" action="${self}/brief">
          ${back(self)}${rev}
          <label class="field"><span>Your version</span><textarea name="brief" rows="6">${d.conflict.mine}</textarea></label>
          <button class="primary wide">Save my version</button>
        </form>
      </section>`
    : html`<section class="card pad">
        ${t.brief ? html`<div class="brief md" data-brief>${markdownHtml(t.brief)}</div>` : html`<div class="muted" data-brief>No brief yet.</div>`}
        <details>
          <summary class="small" style="min-height:44px;display:flex;align-items:center;color:var(--accent)">Edit brief</summary>
          <form method="post" action="${self}/brief">
            ${back(self)}${rev}
            <textarea name="brief" rows="6" aria-label="Brief">${t.brief}</textarea>
            <div class="actions"><button class="wide">Save brief</button></div>
          </form>
        </details>
      </section>`;

  const shown = d.showAll ? d.activity : d.activity.filter((e) => !QUIET_KINDS.has(e.kind));
  const hiddenCount = d.activity.length - shown.length;
  const history = html`<h2>History</h2>
    <div class="card">
      <ul class="history" data-history>
        ${[...shown].reverse().map((e) => {
          const x = activityText(e, t, users, me);
          const late =
            e.kind === "completion" &&
            new Date(e.recorded_at).getTime() - new Date(e.happened_at).getTime() > 3_600_000;
          return html`<li class="${e.author.agent ? "agent" : ""} ${QUIET_KINDS.has(e.kind) ? "sys" : ""}" data-kind="${e.kind}">
            <div class="when">${whenText(e.happened_at, now)} · ${authorHtml(e, users, me)}${late ? html` · recorded ${agoText(e.recorded_at, now)}` : ""}</div>
            <div><strong>${x.head}</strong></div>
            ${x.body ? html`<div class="body md">${markdownHtml(x.body)}</div>` : ""}
          </li>`;
        })}
      </ul>
    </div>
    ${
      hiddenCount > 0
        ? html`<p><a class="btn quiet" href="${self}?all=1">Show all (${hiddenCount} more)</a></p>`
        : d.showAll
          ? html`<p><a class="btn quiet" href="${self}">Show less</a></p>`
          : ""
    }`;

  return page({
    title: t.title,
    tab: null,
    flash: ctx.flash,
    live: ctx.live,
    top: html`${backLink("/", "Now")}<a class="iconlink small" href="${self}/inspect">Inspect</a>`,
    body: html`
      <h1>${t.title}</h1>
      <div>${stateBadge(t)} ${privateBadge(t)}</div>
      ${statusLine}
      ${nextLine}
      ${s.routine && !s.urgent ? html`<p class="small muted" data-routine>${s.routine.label}</p>` : ""}
      ${waitingBox}
      ${snoozed}
      ${primary}
      ${verbs}
      ${note}
      <h2>Brief</h2>
      ${briefSection}
      ${attachmentsSection(t, d.picker)}
      ${history}
      ${moreSection(ctx, t, isOwner)}
    `,
  });
}

/** Where a link goes, in a person's words. */
function linkSource(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "");
  if (host === "drive.google.com") return "Google Drive";
  if (host === "docs.google.com") return "Google Docs";
  return host;
}

function attachmentsSection(t: Task, picker: Config["googlePicker"]): Html {
  const self = `/tasks/${t.id}`;
  const list = t.attachments.length
    ? html`<ul class="list" data-attachments>
        ${t.attachments.map(
          (a) => html`<li data-attachment="${a.id}">
            <a class="row-main solo" href="${a.url}" target="_blank" rel="noopener noreferrer">
              <span class="row-title">${a.title}</span>
              <span class="row-why">${linkSource(a.url)}</span>
            </a>
            <form class="inline" method="post" action="${self}/attachments/remove">
              ${back(self)}<input type="hidden" name="attachment_id" value="${a.id}">
              <button class="quiet" aria-label="Remove ${a.title}">Remove</button>
            </form>
          </li>`,
        )}
      </ul>`
    : "";
  const drive = picker
    ? html`<button type="button" class="wide" data-drive-pick data-api-key="${picker.apiKey}" data-client-id="${picker.clientId}" data-app-id="${picker.appId}" data-folder="${picker.uploadFolderId ?? ""}">Choose or upload from Google Drive</button>
        <p class="small muted" data-drive-status role="status"></p>
        <form method="post" action="${self}/attachments/drive" data-drive-form hidden>${back(self)}<input type="hidden" name="items"></form>`
    : "";
  return html`<h2>Attachments</h2>
    ${list}
    <details class="sheet">
      <summary>Attach a file</summary>
      <div class="body">
        ${drive}
        <form method="post" action="${self}/attachments">
          ${back(self)}
          <label class="field"><span>Link</span><input type="url" name="url" required placeholder="https://drive.google.com/…" autocapitalize="off"></label>
          <label class="field"><span>Title (optional)</span><input type="text" name="title" placeholder="e.g. Plumber's quote"></label>
          <button class="wide">Attach link</button>
        </form>
        <p class="small muted">Tuit keeps the link, not the file. Opening it needs access to the file itself, so keep household files in a shared folder.</p>
      </div>
    </details>`;
}

function moreSection(ctx: Ctx, t: Task, isOwner: boolean): Html {
  const self = `/tasks/${t.id}`;
  const rev = html`<input type="hidden" name="expected_revision" value="${t.revision}">`;
  const { now } = ctx;
  const ruleText = (r: Task["target_rule"]) =>
    r
      ? `${Math.abs(r.offset_days)} days ${r.offset_days < 0 ? "before" : "after"} ${r.anchor}`
      : "";
  const dateField = (name: string, label: string, m: Moment | null, rule?: Task["target_rule"]) =>
    html`<label class="field"><span>${label}</span>
      <input type="text" name="${name}" value="${momentEditText(m)}" placeholder="e.g. sat, tomorrow 9am" autocapitalize="off">
      ${m ? html`<span class="small" data-moment="${name}">${momentHtml(m, now)}${rule ? html` · ${ruleText(rule)}` : ""}</span>` : ""}
    </label>`;
  return html`<details class="sheet" style="margin-top:24px">
    <summary>More</summary>
    <div class="body">
      <form method="post" action="${self}/edit">
        ${back(self)}${rev}
        <label class="field"><span>Title</span><input type="text" name="title" value="${t.title}" required></label>
        <label class="field"><span>Next action</span><input type="text" name="next_action" value="${t.next_action}"></label>
        <label class="field"><span>Done means</span><input type="text" name="done_means" value="${t.done_means}"></label>
        <button class="wide">Save</button>
      </form>
      <h2>Dates</h2>
      <p class="small muted">A day ("sat", "2026-10-03") is all-day; add a time ("sat 9am") for an exact moment. Clear a box to remove it.</p>
      <form method="post" action="${self}/dates">
        ${back(self)}${rev}
        ${dateField("available_from", "Available from", t.available_from, t.available_rule)}
        ${dateField("target", "Target (would like to by)", t.target, t.target_rule)}
        ${dateField("deadline", "Deadline (consequences after)", t.deadline)}
        ${dateField("expires", "Expires (irrelevant after)", t.expires)}
        <button class="wide">Save dates</button>
      </form>
      ${
        isOwner
          ? html`<h2>Visibility</h2>
            <form method="post" action="${self}/visibility">
              ${back(self)}${rev}
              <label class="check"><input type="checkbox" name="private" value="1" ${t.visibility === "private" ? raw("checked") : ""}> Private — only you (and your agents) can see it</label>
              <button class="wide">Save visibility</button>
            </form>`
          : ""
      }
      <h2>Contexts</h2>
      <form method="post" action="${self}/contexts">
        ${back(self)}${rev}
        <label class="field"><span>Requires (hard, comma separated)</span><input type="text" name="requires" value="${t.requires.join(", ")}" placeholder="e.g. computer" autocapitalize="off"></label>
        <label class="field"><span>Prefers (soft)</span><input type="text" name="prefers" value="${t.prefers.join(", ")}" placeholder="e.g. evening" autocapitalize="off"></label>
        <button class="wide">Save contexts</button>
      </form>
      <h2>Routine</h2>
      <form method="post" action="${self}/routine">
        ${back(self)}${rev}
        <label class="field"><span>Repeats</span><select name="mode">
          <option value="" ${t.recurrence ? "" : raw("selected")}>Not a routine</option>
          <option value="after_completion" ${t.recurrence?.mode === "after_completion" ? raw("selected") : ""}>Every N days after I do it</option>
          <option value="since_done" ${t.recurrence?.mode === "since_done" ? raw("selected") : ""}>Nudge when it's been N days</option>
        </select></label>
        <label class="field"><span>N days</span><input type="number" name="every_days" min="1" max="3650" inputmode="numeric" value="${t.recurrence?.every_days ?? 7}"></label>
        <button class="wide">Save routine</button>
      </form>
      <p><a class="btn quiet wide" href="${self}/inspect">Inspect everything</a></p>
    </div>
  </details>`;
}

// ---------------------------------------------------------------- Inspect

function json(v: unknown): Html {
  return html`<pre>${JSON.stringify(v, null, 2)}</pre>`;
}

function explanationHtml(e: Explanation): Html {
  return html`<p><span class="badge ${e.verdict === "excluded" ? "" : "done"}">${e.verdict.replace("_", " ")}</span> ${e.summary}</p>
    <ul class="checks">${e.checks.map((c) => html`<li class="${c.ok ? "" : "fail"}">${c.check}: ${c.detail}</li>`)}</ul>
    <p class="small muted">Order: ${e.order.join(" → ")}</p>`;
}

export function inspectPage(
  ctx: Ctx,
  d: {
    task: Task;
    status: TaskStatus;
    attention: { snoozed_until: string | null; pinned: boolean };
    activity: ActivityEntry[];
    membership: { queue: string; id: string | null; explanation: Explanation }[];
  },
): Html {
  const t = d.task;
  const fields = Object.entries(t) as [string, unknown][];
  return page({
    title: `Inspect: ${t.title}`,
    tab: null,
    flash: ctx.flash,
    live: ctx.live,
    top: backLink(`/tasks/${t.id}`, "Task"),
    body: html`
      <h1>${t.title}</h1>
      <p class="small muted">Task ${t.id} · revision ${t.revision}</p>
      <h2>State</h2>
      <div class="card pad"><table class="kv">${fields.map(
        ([k, v]) =>
          html`<tr><td>${k}</td><td>${
            v === null || v === ""
              ? html`<span class="muted">—</span>`
              : typeof v === "object"
                ? json(v)
                : String(v)
          }</td></tr>`,
      )}</table></div>
      <h2>Status for you</h2>
      <div class="card pad">${json(d.status)}${json(d.attention)}</div>
      <h2>Queue membership</h2>
      ${d.membership.map(
        (m) => html`<div class="card pad" style="margin-bottom:8px" data-membership="${m.queue}">
          <strong>${m.id ? html`<a href="/queues/${m.id}">${m.queue}</a>` : m.queue}</strong>
          ${explanationHtml(m.explanation)}
        </div>`,
      )}
      <h2>Full activity</h2>
      <div class="card"><ul class="history">${[...d.activity].reverse().map(
        (e) => html`<li class="${e.author.agent ? "agent" : ""}">
          <div class="when">#${e.id} · ${e.kind} · happened ${e.happened_at} · recorded ${e.recorded_at} · ${authorHtml(e, ctx.users, ctx.me)}</div>
          ${e.body ? html`<div class="body">${e.body}</div>` : ""}
          ${Object.keys(e.data).length ? json(e.data) : ""}
        </li>`,
      )}</ul></div>
    `,
  });
}

// ---------------------------------------------------------------- Queues

export const DEFAULT_QUEUE_CONFIG = JSON.stringify(
  { actor: "me_or_anyone", visible_limit: 5 },
  null,
  2,
);

export function queuesPage(
  ctx: Ctx,
  queues: Queue[],
  form?: { name: string; config: string; visibility: string; error: string },
): Html {
  const row = (href: string, title: string, why: string, extra: Html | string = "") =>
    html`<li><a class="row-main solo" href="${href}"><span class="row-title">${title} ${extra}</span><span class="row-why">${why}</span></a><span class="chev" aria-hidden="true">›</span></li>`;
  return page({
    title: "Queues",
    tab: "queues",
    flash: ctx.flash,
    live: ctx.live,
    top: topTitle("Queues"),
    body: html`
      <h2>Saved queues</h2>
      ${
        queues.length
          ? list(
              queues.map((q) =>
                row(
                  `/queues/${q.id}`,
                  q.name,
                  `${q.config.actor} · shows ${q.config.visible_limit}${q.created_by_agent ? ` · made by agent:${q.created_by_agent}` : ""}`,
                  html`${q.enabled ? "" : html`<span class="badge">disabled</span>`}${q.visibility === "private" ? html` <span class="badge private">private</span>` : ""}`,
                ),
              ),
              "Saved queues",
            )
          : html`<p class="muted small" style="margin:0 4px">None yet. Agents can make them, or add one below.</p>`
      }
      <h2>Built in</h2>
      ${list(
        [
          row("/queues/waiting", "Waiting", "Things waiting on someone or something"),
          row("/queues/open", "Everything open", "All open tasks you can see"),
          row("/queues/closed", "Recently closed", "Done, expired and shelved"),
        ],
        "Built-in views",
      )}
      <details class="sheet" ${form ? raw("open") : ""} style="margin-top:24px">
        <summary>New queue</summary>
        <div class="body">
          ${form?.error ? html`<div class="flash error" role="alert">${form.error}</div>` : ""}
          <form method="post" action="/queues">
            <label class="field"><span>Name</span><input type="text" name="name" required value="${form?.name ?? ""}"></label>
            <label class="field"><span>Visibility</span><select name="visibility">
              <option value="household">Household</option>
              <option value="private" ${form?.visibility === "private" ? raw("selected") : ""}>Private</option>
            </select></label>
            <label class="field"><span>Config (JSON)</span><textarea name="config" rows="8" autocapitalize="off" spellcheck="false">${form?.config ?? DEFAULT_QUEUE_CONFIG}</textarea></label>
            <button class="primary wide">Create queue</button>
          </form>
        </div>
      </details>
    `,
  });
}

export function queuePage(
  ctx: Ctx,
  d: {
    queue: Queue;
    result: QueueResult;
    preview?: QueueResult;
    form?: { name: string; config: string; visibility: string; enabled: boolean };
    error?: string;
    explain?: { query: string; results: { task: Task; explanation: Explanation }[] };
  },
): Html {
  const q = d.queue;
  const self = `/queues/${q.id}`;
  const shown = d.preview ?? d.result;
  const form = d.form ?? {
    name: q.name,
    config: JSON.stringify(q.config, null, 2),
    visibility: q.visibility,
    enabled: q.enabled,
  };
  const isOwner = q.owner === ctx.me.userId;
  return page({
    title: q.name,
    tab: "queues",
    flash: ctx.flash,
    live: ctx.live,
    top: html`${backLink("/queues", "Queues")}`,
    body: html`
      <h1>${q.name}</h1>
      <p class="small muted">${q.enabled ? "" : html`<span class="badge">disabled</span> `}${q.visibility === "private" ? html`<span class="badge private">private</span> ` : ""}${q.created_by_agent ? `made by agent:${q.created_by_agent} · ` : ""}owner ${ctx.users.find((u) => u.id === q.owner)?.name ?? q.owner}</p>
      ${d.preview ? html`<div class="banner" data-preview>Preview of your unsaved config. Nothing has been changed.</div>` : ""}
      ${urgentStrip(shown.urgent, self, "Time-critical (outside the limit)")}
      ${
        shown.items.length
          ? html`<h2>${d.preview ? "Preview" : "Items"}</h2>${list(
              quiet(ctx, shown.items).map((i) => itemRow(i, { backTo: self })),
              "Queue items",
            )}`
          : html`<div class="empty">Nothing matches right now.</div>`
      }
      ${shown.hidden_count > 0 ? html`<p class="center muted" data-hidden-count>${shown.hidden_count} more beyond the limit</p>` : ""}

      <h2>Why isn't something showing?</h2>
      <form method="get" action="${self}" class="capture">
        <input type="search" name="why" value="${d.explain?.query ?? ""}" placeholder="Task id or words from its title" aria-label="Task to explain">
        <button>Explain</button>
      </form>
      ${
        d.explain
          ? d.explain.results.length
            ? d.explain.results.map(
                (r) => html`<div class="card pad" style="margin-top:8px" data-explain>
                  <a href="/tasks/${r.task.id}"><strong>${r.task.title}</strong></a> ${stateBadge(r.task)}
                  ${explanationHtml(r.explanation)}
                </div>`,
              )
            : html`<p class="muted">No task you can see matches "${d.explain.query}".</p>`
          : ""
      }

      <h2>Configuration</h2>
      <div class="card pad">${json(q.config)}</div>
      <details class="sheet" ${d.form ? raw("open") : ""}>
        <summary>Edit</summary>
        <div class="body">
          ${d.error ? html`<div class="flash error" role="alert">${d.error}</div>` : ""}
          <form method="post" action="${self}">
            <input type="hidden" name="expected_revision" value="${q.revision}">
            <label class="field"><span>Name</span><input type="text" name="name" value="${form.name}"></label>
            ${
              isOwner
                ? html`<label class="field"><span>Visibility</span><select name="visibility">
                    <option value="household">Household</option>
                    <option value="private" ${form.visibility === "private" ? raw("selected") : ""}>Private</option>
                  </select></label>`
                : ""
            }
            <label class="check"><input type="checkbox" name="enabled" value="1" ${form.enabled ? raw("checked") : ""}> Enabled</label>
            <label class="field"><span>Config (JSON)</span><textarea name="config" rows="10" autocapitalize="off" spellcheck="false">${form.config}</textarea></label>
            <div class="actions">
              <button name="op" value="preview">Preview</button>
              <button class="primary" name="op" value="save">Save</button>
            </div>
          </form>
          <p class="small muted">Fields: actor, include_waiting, include_resting, contexts, only_requiring, text, recurring, owner, visibility, order, visible_limit.</p>
        </div>
      </details>
    `,
  });
}

export function viewPage(
  ctx: Ctx,
  d: { title: string; blurb: string; items: { task: Task; why: string }[]; badge?: boolean },
): Html {
  return page({
    title: d.title,
    tab: "queues",
    flash: ctx.flash,
    live: ctx.live,
    top: backLink("/queues", "Queues"),
    body: html`<h1>${d.title}</h1><p class="muted small">${d.blurb}</p>
      ${
        d.items.length
          ? list(
              d.items.map((i) => itemRow(i, { backTo: "", tick: false, badge: d.badge })),
              d.title,
            )
          : html`<div class="empty">Nothing here.</div>`
      }`,
  });
}

// ---------------------------------------------------------------- Search

export function searchPage(ctx: Ctx, q: string, results: Task[] | null): Html {
  return page({
    title: q ? `Search: ${q}` : "Search",
    tab: "search",
    flash: ctx.flash,
    live: ctx.live,
    top: topTitle("Search"),
    body: html`
      <form method="get" action="/search" class="capture" role="search">
        <input type="search" name="q" value="${q}" placeholder="Titles, briefs, notes…" aria-label="Search" autocapitalize="off" enterkeyhint="search">
        <button>Search</button>
      </form>
      ${
        results === null
          ? html`<p class="muted small center">Finds open and closed tasks, including expired and shelved ones.</p>`
          : results.length
            ? html`<h2>${results.length} found</h2>${list(
                results.map((t) =>
                  itemRow(
                    {
                      task: t,
                      why: t.close_reason || (t.next_action ? `Next: ${t.next_action}` : ""),
                    },
                    { backTo: "", tick: false, badge: true },
                  ),
                ),
                "Results",
              )}`
            : html`<div class="empty">Nothing matches "${q}".</div>`
      }
    `,
  });
}

// ---------------------------------------------------------------- Settings

export function settingsPage(
  ctx: Ctx,
  tokens: TokenInfo[],
  issued?: { token: string; info: TokenInfo },
): Html {
  const me = ctx.users.find((u) => u.id === ctx.me.userId);
  return page({
    title: "Settings",
    tab: null,
    flash: ctx.flash,
    live: ctx.live,
    top: backLink("/", "Now"),
    body: html`
      <h1>Settings</h1>
      <div class="card pad">
        <div>Signed in as <strong>${me?.name ?? ctx.me.userId}</strong></div>
        <div class="small muted">${me?.email ?? ""}</div>
        <form method="post" action="/logout" data-hard class="actions"><button class="wide">Sign out</button></form>
      </div>
      ${
        issued
          ? html`<section class="card pad" style="margin-top:12px" data-issued>
              <p><strong>New ${issued.info.kind} token${issued.info.agent ? ` for agent:${issued.info.agent}` : ""}.</strong> Copy it now; it won't be shown again.</p>
              <code class="token" id="new-token">${issued.token}</code>
              <div class="actions"><button type="button" data-copy="new-token">Copy</button></div>
            </section>`
          : ""
      }
      <h2>New token</h2>
      <details class="sheet">
        <summary>New agent token</summary>
        <div class="body">
          <p class="small muted">The agent acts for you, sees what you see, and its notes are marked as agent-written.</p>
          <form method="post" action="/settings/tokens">
            <input type="hidden" name="kind" value="agent">
            <label class="field"><span>Agent name</span><input type="text" name="agent" required placeholder="e.g. claude, family-assistant" autocapitalize="off" pattern="[A-Za-z0-9_.\\-]{1,64}"></label>
            <label class="field"><span>Access</span><select name="scope"><option value="write">Read and write</option><option value="read">Read only</option></select></label>
            <label class="field"><span>Label (optional)</span><input type="text" name="label"></label>
            <button class="primary wide">Create token</button>
          </form>
        </div>
      </details>
      <details class="sheet">
        <summary>New personal token</summary>
        <div class="body">
          <p class="small muted">For your own CLI. It acts as you, not as an agent.</p>
          <form method="post" action="/settings/tokens">
            <input type="hidden" name="kind" value="personal">
            <label class="field"><span>Access</span><select name="scope"><option value="write">Read and write</option><option value="read">Read only</option></select></label>
            <label class="field"><span>Label (optional)</span><input type="text" name="label" placeholder="e.g. laptop CLI"></label>
            <button class="primary wide">Create personal token</button>
          </form>
        </div>
      </details>
      <details class="sheet">
        <summary>New display token</summary>
        <div class="body">
          <p class="small muted">For a shared screen. Read-only, household items only, never private ones.</p>
          <form method="post" action="/settings/tokens">
            <input type="hidden" name="kind" value="display">
            <label class="field"><span>Label</span><input type="text" name="label" placeholder="e.g. kitchen screen"></label>
            <button class="primary wide">Create display token</button>
          </form>
        </div>
      </details>
      <h2>Your tokens</h2>
      ${
        tokens.length
          ? list(
              tokens.map(
                (t) => html`<li data-token="${t.id}">
                  <div class="row-main solo">
                    <span class="row-title">${t.kind === "agent" ? `agent:${t.agent}` : t.kind} <span class="badge">${t.scope}</span></span>
                    <span class="row-why">${t.label ? `${t.label} · ` : ""}created ${whenText(t.created_at, ctx.now)}${t.last_used_at ? ` · last used ${whenText(t.last_used_at, ctx.now)}` : " · never used"}</span>
                  </div>
                  <form method="post" action="/settings/tokens/${t.id}/revoke" style="padding-right:8px"><button class="danger">Revoke</button></form>
                </li>`,
              ),
              "Tokens",
            )
          : html`<p class="muted small" style="margin:0 4px">No tokens.</p>`
      }
    `,
  });
}

// ---------------------------------------------------------------- Misc

export function errorPage(ctx: Ctx | null, title: string, message: string): Html {
  return page({
    title,
    tab: ctx ? "now" : null,
    top: ctx ? backLink("/", "Now") : html``,
    live: ctx?.live,
    body: html`<div class="empty" data-error>
      <div class="big">${title}</div>
      <p>${message}</p>
      <p><a class="btn" href="/">Back to Now</a></p>
    </div>`,
  });
}

export function devLoginPage(users: { id: string; name: string }[], next: string): Html {
  return page({
    title: "Sign in",
    tab: null,
    top: html`<div class="title">Sign in</div>`,
    body: html`<p class="muted">Development sign-in.</p>
      <form method="post" action="/login/dev" data-hard>
        <input type="hidden" name="next" value="${next}">
        <div class="actions">${users.map((u) => html`<button class="wide" name="user" value="${u.id}">${u.name}</button>`)}</div>
      </form>`,
  });
}
