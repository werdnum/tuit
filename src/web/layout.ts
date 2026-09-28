import { html, raw } from "hono/html";

export type Html = ReturnType<typeof html>;

/** A page's position in the change feed and the server time it was rendered (ms). */
export interface LiveMark {
  cursor: string;
  at: number;
}

export type Tab = "now" | "queues" | "search" | null;

export interface Flash {
  text: string;
  kind: "info" | "error";
}

const CSS = `
:root {
  color-scheme: light dark;
  --bg: #f2f2f7;
  --card: #ffffff;
  --text: #1c1c1e;
  --muted: #6e6e73;
  --line: rgba(60, 60, 67, 0.18);
  --accent: #1f7a68;
  --accent-soft: rgba(31, 122, 104, 0.12);
  --on-accent: #ffffff;
  --urgent: #b4460f;
  --urgent-soft: rgba(212, 98, 26, 0.12);
  --danger: #c0352b;
  --agent: #6b4fbb;
  --agent-soft: rgba(107, 79, 187, 0.12);
  --tabbar: rgba(249, 249, 251, 0.92);
  --radius: 14px;
  --tap: 44px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #000000;
    --card: #1c1c1e;
    --text: #f2f2f7;
    --muted: #98989f;
    --line: rgba(84, 84, 88, 0.6);
    --accent: #4cc3a8;
    --accent-soft: rgba(76, 195, 168, 0.16);
    --on-accent: #00241c;
    --urgent: #ff9f5a;
    --urgent-soft: rgba(255, 159, 90, 0.14);
    --danger: #ff6b61;
    --agent: #b9a6ff;
    --agent-soft: rgba(185, 166, 255, 0.16);
    --tabbar: rgba(22, 22, 24, 0.92);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; background: var(--bg); }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 17px/1.4 -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif;
  -webkit-tap-highlight-color: transparent;
  padding: 0 max(16px, env(safe-area-inset-right)) calc(84px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
}
main { max-width: 640px; margin: 0 auto; }
a { color: var(--accent); text-decoration: none; }
h1 { font-size: 28px; line-height: 1.2; margin: 8px 0 6px; letter-spacing: -0.01em; overflow-wrap: anywhere; }
h2 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 26px 4px 8px; }
p { margin: 8px 0; }
.muted { color: var(--muted); }
.small { font-size: 14px; }
.topbar {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding-top: calc(env(safe-area-inset-top) + 8px);
  min-height: calc(env(safe-area-inset-top) + 52px);
  max-width: 640px; margin: 0 auto;
}
.topbar .title { font-size: 34px; font-weight: 700; letter-spacing: -0.02em; }
.topbar .date { color: var(--muted); font-size: 15px; }
.iconlink { display: inline-flex; align-items: center; justify-content: center; min-width: var(--tap); min-height: var(--tap); color: var(--accent); }
.back { display: inline-flex; align-items: center; min-height: var(--tap); gap: 2px; font-size: 17px; }
.card { background: var(--card); border-radius: var(--radius); overflow: hidden; }
.pad { padding: 14px 16px; }
ul.list { list-style: none; margin: 0; padding: 0; background: var(--card); border-radius: var(--radius); overflow: hidden; }
ul.list > li { display: flex; align-items: center; min-height: 56px; border-top: 0.5px solid var(--line); }
ul.list > li:first-child { border-top: 0; }
.row-main { flex: 1; min-width: 0; display: block; padding: 10px 16px 10px 0; color: var(--text); min-height: var(--tap); }
.row-main.solo { padding-left: 16px; }
.row-title { display: block; overflow-wrap: anywhere; }
.row-why { display: block; font-size: 14px; color: var(--muted); margin-top: 1px; }
.chev { color: var(--muted); padding-right: 12px; font-size: 20px; }
li.done .row-title { text-decoration: line-through; color: var(--muted); }
li.urgent .row-why { color: var(--urgent); font-weight: 500; }
.tickform { margin: 0; }
.tick {
  width: 56px; height: 56px; border: 0; background: none; padding: 0; cursor: pointer;
  display: flex; align-items: center; justify-content: center; color: var(--muted);
}
.tick::before {
  content: ""; width: 24px; height: 24px; border-radius: 50%; border: 2px solid currentColor; display: block;
}
.tick:active::before { background: var(--accent-soft); }
li.done .tick { color: var(--accent); }
li.done .tick::before { background: var(--accent); border-color: var(--accent);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M6 12.5l4 4 8-9' fill='none' stroke='white' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-size: 100%; }
.strip { background: var(--urgent-soft); border-radius: var(--radius); margin-top: 12px; overflow: hidden; }
.strip h2 { color: var(--urgent); margin: 12px 16px 2px; }
.strip ul.list { background: transparent; }
.banner { background: var(--accent-soft); border-radius: var(--radius); padding: 12px 16px; margin-top: 12px; }
.flash { border-radius: var(--radius); padding: 12px 16px; margin: 12px 0 0; background: var(--accent-soft); }
.flash.error { background: rgba(192, 53, 43, 0.12); color: var(--danger); }
.capture { display: flex; gap: 8px; margin-top: 4px; }
.capture input { flex: 1; }
input[type=text], input[type=search], input[type=date], input[type=number], select, textarea {
  font: inherit; font-size: 17px; color: var(--text); background: var(--card);
  border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; min-height: var(--tap); width: 100%;
  -webkit-appearance: none; appearance: none;
}
select { background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%);
  background-position: calc(100% - 18px) 55%, calc(100% - 13px) 55%; background-size: 5px 5px; background-repeat: no-repeat; padding-right: 32px; }
textarea { min-height: 96px; resize: vertical; line-height: 1.4; }
input:focus, textarea:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
label.field { display: block; margin: 10px 0; }
label.field > span { display: block; font-size: 14px; color: var(--muted); margin: 0 4px 4px; }
.check { display: flex; align-items: center; gap: 10px; min-height: var(--tap); }
.check input { width: 22px; height: 22px; accent-color: var(--accent); }
button, .btn {
  font: inherit; font-size: 17px; font-weight: 600; border: 0; border-radius: 12px; min-height: var(--tap);
  padding: 10px 16px; background: var(--accent-soft); color: var(--accent); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; text-align: center;
}
button.primary, .btn.primary { background: var(--accent); color: var(--on-accent); }
button.quiet, .btn.quiet { background: transparent; font-weight: 500; }
button.danger { color: var(--danger); background: rgba(192, 53, 43, 0.1); }
button.wide, .btn.wide { width: 100%; }
button:disabled { opacity: 0.5; }
.busy button { opacity: 0.6; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.actions > * { flex: 1 1 auto; }
.inline { display: inline; margin: 0; }
.center { text-align: center; }
.empty { text-align: center; padding: 40px 16px 24px; color: var(--muted); }
.empty .big { font-size: 22px; color: var(--text); font-weight: 600; margin-bottom: 6px; }
.calm { text-align: center; padding: 28px 16px; }
.calm .big { font-size: 22px; font-weight: 600; }
.badge { display: inline-block; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
  padding: 2px 7px; border-radius: 6px; background: var(--line); color: var(--muted); vertical-align: 2px; }
.badge.done { background: var(--accent-soft); color: var(--accent); }
.badge.expired { background: rgba(192, 53, 43, 0.12); color: var(--danger); }
.badge.waiting, .badge.urgent { background: var(--urgent-soft); color: var(--urgent); }
.badge.agent { background: var(--agent-soft); color: var(--agent); text-transform: none; letter-spacing: 0; }
.badge.private { background: var(--agent-soft); color: var(--agent); }
.next { font-size: 17px; }
.status { color: var(--muted); font-size: 15px; }
.status.urgent { color: var(--urgent); font-weight: 600; }
.brief { white-space: pre-wrap; overflow-wrap: anywhere; }
details.sheet { background: var(--card); border-radius: var(--radius); margin-top: 8px; }
details.sheet > summary { list-style: none; min-height: var(--tap); display: flex; align-items: center; justify-content: space-between;
  padding: 10px 16px; font-weight: 600; color: var(--accent); cursor: pointer; }
details.sheet > summary::-webkit-details-marker { display: none; }
details.sheet > summary::after { content: "›"; color: var(--muted); font-size: 22px; transition: transform 0.15s; }
details.sheet[open] > summary::after { transform: rotate(90deg); }
details.sheet > .body { padding: 0 16px 14px; }
.verbs { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
.verbs > details, .verbs > form { margin: 0; }
.verbs > details[open] { grid-column: 1 / -1; }
.verbs > form > button, .verbs > details > summary { width: 100%; }
.verbs details.sheet { margin: 0; }
.verbs details.sheet > summary { justify-content: center; background: var(--card); border-radius: var(--radius); font-weight: 500; color: var(--text); }
.verbs details.sheet > summary::after { content: none; }
.verbs details[open] > summary { color: var(--accent); font-weight: 600; }
.verbs > form > button { background: var(--card); color: var(--text); font-weight: 500; border-radius: var(--radius); }
.presets { display: flex; flex-wrap: wrap; gap: 8px; }
.presets button { flex: 1 1 40%; }
.history { list-style: none; margin: 0; padding: 0; }
.history li { padding: 10px 16px; border-top: 0.5px solid var(--line); }
.history li:first-child { border-top: 0; }
.history .when { font-size: 13px; color: var(--muted); }
.history .body { white-space: pre-wrap; overflow-wrap: anywhere; }
.history li.agent { border-left: 3px solid var(--agent); }
.history li.sys .body { color: var(--muted); font-size: 15px; }
pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--bg); padding: 10px; border-radius: 10px; margin: 6px 0; }
table.kv { width: 100%; border-collapse: collapse; font-size: 14px; }
table.kv td { border-top: 0.5px solid var(--line); padding: 6px 4px; vertical-align: top; overflow-wrap: anywhere; }
table.kv td:first-child { color: var(--muted); width: 38%; }
.checks { list-style: none; padding: 0; margin: 6px 0; font-size: 14px; }
.checks li::before { content: "✓ "; color: var(--accent); }
.checks li.fail::before { content: "✗ "; color: var(--danger); }
.token { display: block; padding: 12px; background: var(--bg); border-radius: 10px; word-break: break-all; font-size: 14px; user-select: all; -webkit-user-select: all; }
.moment-kind { font-size: 12px; color: var(--muted); }
.linkrow { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
nav.tabbar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 10;
  display: flex; justify-content: space-around;
  background: var(--tabbar); -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px);
  border-top: 0.5px solid var(--line);
  padding: 4px max(8px, env(safe-area-inset-right)) env(safe-area-inset-bottom) max(8px, env(safe-area-inset-left));
}
nav.tabbar a { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  min-height: 50px; font-size: 11px; font-weight: 500; color: var(--muted); }
nav.tabbar a[aria-current=page] { color: var(--accent); }
nav.tabbar svg { width: 26px; height: 26px; }
`;

// Progressive enhancement: submit POST forms with fetch and swap the page in place, so ticking
// an item doesn't jump the scroll position. Everything still works as plain form posts.
// Submissions are queued, never dropped: quick successive captures must all arrive. Text typed
// while a request is in flight survives the swap.
const JS = `
let chain = Promise.resolve();
let held = false;
function formData(f, submitter) {
  const body = new URLSearchParams();
  for (const el of f.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === "submit" || el.tagName === "BUTTON") continue;
    if ((el.type === "checkbox" || el.type === "radio") && !el.checked) continue;
    body.append(el.name, el.value);
  }
  if (submitter && submitter.name) body.append(submitter.name, submitter.value);
  return body;
}
function fieldKey(el) {
  const f = el.form;
  return (f ? (f.getAttribute("action") || "") : "") + "|" + (el.id || el.name);
}
const TEXT = "input[type=text], input:not([type]), input[type=search], textarea";
// Carry over anything the person has typed and not yet sent: fields changed from what the page
// loaded with, except values that were just submitted (the server's answer replaces those).
// Sheets other than the one that was submitted keep their open/closed state, so one opened
// while the request was in flight isn't snapped shut.
function swap(doc, submitted, form) {
  const typed = new Map();
  let focused = null;
  for (const el of document.querySelectorAll(TEXT)) {
    const k = fieldKey(el);
    if (el.value !== el.defaultValue && submitted.get(k) !== el.value) typed.set(k, el.value);
    if (el === document.activeElement) focused = k;
  }
  const oldSheets = keyed(document, "details", sheetKey);
  for (const [k, d] of keyed(doc, "details", sheetKey)) {
    const old = oldSheets.get(k);
    if (old && !old.contains(form)) d.open = old.open;
  }
  document.title = doc.title;
  document.body.replaceWith(doc.body);
  for (const el of document.querySelectorAll(TEXT)) {
    const k = fieldKey(el);
    if (typed.has(k)) {
      el.value = typed.get(k);
      const d = el.closest("details");
      if (d) d.open = true;
    }
    if (k === focused) el.focus();
  }
}
document.addEventListener("submit", (e) => {
  const f = e.target;
  if (!(f instanceof HTMLFormElement) || f.method.toLowerCase() !== "post" || "hard" in f.dataset) return;
  e.preventDefault();
  const body = formData(f, e.submitter);
  const s = e.submitter;
  const action = (s && s.getAttribute("formaction")) || f.getAttribute("action") || location.pathname;
  if ("capture" in f.dataset) {
    const input = f.querySelector("input[name=title]");
    if (input) input.value = "";
  }
  const submitted = new Map();
  for (const el of f.querySelectorAll(TEXT)) submitted.set(fieldKey(el), el.value);
  chain = chain.then(async () => {
    try {
      const res = await fetch(action, { method: "POST", body, credentials: "same-origin" });
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const moved = res.redirected && res.url !== location.href;
      if (moved) history.pushState(null, "", res.url);
      swap(doc, submitted, f);
      shownAt = Date.now();
      if (moved) window.scrollTo(0, 0);
      // A post answered with a page rather than a redirect (a conflict, a refusal) shows
      // something that exists only in this response; a live refresh must not replace it.
      held = !res.redirected;
    } catch {
      const fallback = document.createElement("form");
      fallback.method = "post";
      fallback.action = action;
      for (const [k, v] of body) {
        const i = document.createElement("input");
        i.type = "hidden"; i.name = k; i.value = v;
        fallback.appendChild(i);
      }
      document.body.appendChild(fallback);
      fallback.submit();
    }
  });
});
window.addEventListener("popstate", () => location.reload());

// Live updates: the server says when something this person can see has changed, and the page
// re-fetches itself and swaps in quietly. Whatever the person is in the middle of stays as it
// is: an open sheet keeps its own fields (including the revision it was opened at, so a
// concurrent edit still shows as a conflict), typed text and focus survive, and so does the
// scroll position and any message or welcome-back summary on screen.
let liveQueued = false;
// Time alone changes some pages (a new day's list at 4am, "enough for now" running out) with
// no event to announce it, so a page this old is refreshed when shown again or on reconnect.
const STALE_MS = 10 * 60 * 1000;
let shownAt = Date.now();
let livePending = false;
let source = null;
function sheetKey(d) {
  const s = d.querySelector("summary");
  const f = d.querySelector("form");
  return (s ? s.textContent.trim() : "") + "|" + (f ? f.getAttribute("action") || "" : "");
}
function keyed(root, sel, keyOf) {
  const out = new Map();
  for (const el of root.querySelectorAll(sel)) {
    const base = keyOf(el);
    let i = 0;
    while (out.has(base + "#" + i)) i++;
    out.set(base + "#" + i, el);
  }
  return out;
}
function liveSwap(doc) {
  // Fields are keyed by form, name and position, so same-named fields in forms that share an
  // action (several open token dialogs, say) keep their own values.
  const typed = new Map();
  let focusKey = null;
  const active = document.activeElement;
  for (const [k, el] of keyed(document, TEXT, fieldKey)) {
    if (el.value !== el.defaultValue) typed.set(k, el.value);
    if (el === active) focusKey = k;
  }
  const sel = focusKey ? [active.selectionStart, active.selectionEnd] : null;
  const kept = [];
  const oldSheets = keyed(document, "details", sheetKey);
  for (const [k, d] of keyed(doc, "details", sheetKey)) {
    const old = oldSheets.get(k);
    if (!old || !doc.body.contains(d)) continue;
    if (old.open) {
      d.replaceWith(old);
      kept.push(old);
    } else d.open = false;
  }
  const shown = document.querySelector("main > .flash");
  const main = doc.querySelector("main");
  if (shown && main && !main.querySelector(".flash")) main.prepend(shown);
  // The welcome-back summary is shown once per return; a live refresh mustn't swallow it.
  const away = document.querySelector("[data-away]");
  if (away && main && !doc.querySelector("[data-away]")) {
    const capture = main.querySelector("form[data-capture]");
    if (capture) capture.after(away);
    else main.prepend(away);
  }
  const y = window.scrollY;
  document.title = doc.title;
  document.body.replaceWith(doc.body);
  for (const [k, el] of keyed(document, TEXT, fieldKey)) {
    // A kept sheet is the same element as before, values and all.
    const same = kept.some((d) => d.contains(el));
    if (!same && typed.has(k)) el.value = typed.get(k);
    if (same ? el === active : k === focusKey) {
      el.focus({ preventScroll: true });
      if (sel && el.setSelectionRange) try { el.setSelectionRange(sel[0], sel[1]); } catch {}
    }
  }
  window.scrollTo(0, y);
}
// Skip changes this page already shows: usually this tab's own action, whose response has
// just been swapped in. Refreshing again would only move things under the person's finger.
let liveWanted = [];
function alreadyShown(d) {
  const b = document.body;
  if (Number(b.getAttribute("data-live")) < d.cursor) return false;
  return d.at === undefined || Number(b.getAttribute("data-live-at")) > d.at;
}
function liveRefresh(e) {
  if (e) { try { liveWanted.push(JSON.parse(e.data)); } catch {} }
  if (document.hidden) { livePending = true; return; }
  if (liveQueued) return;
  liveQueued = true;
  chain = chain.then(async () => {
    liveQueued = false;
    const wanted = liveWanted;
    liveWanted = [];
    if (held || !document.body.hasAttribute("data-live")) return;
    if (wanted.length && wanted.every(alreadyShown)) return;
    try {
      const url = location.href;
      const res = await fetch(url, { credentials: "same-origin" });
      if (res.redirected || (res.status !== 200 && res.status !== 404)) return;
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      if (held || location.href !== url || !doc.body.hasAttribute("data-live")) return;
      liveSwap(doc);
      shownAt = Date.now();
    } catch {}
  });
}
function liveConnect() {
  const at = document.body && document.body.getAttribute("data-live");
  if (at === null || !window.EventSource) return;
  if (source && source.readyState !== EventSource.CLOSED) return;
  const rendered = document.body.getAttribute("data-live-at") || "";
  source = new EventSource("/live?after=" + encodeURIComponent(at) + "&at=" + encodeURIComponent(rendered));
  source.addEventListener("change", liveRefresh);
  source.addEventListener("ready", () => { if (Date.now() - shownAt > STALE_MS) liveRefresh(); });
}
document.addEventListener("DOMContentLoaded", liveConnect);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  liveConnect();
  if (livePending || Date.now() - shownAt > STALE_MS) { livePending = false; liveRefresh(); }
});
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("[data-copy]");
  if (!b) return;
  const el = document.getElementById(b.dataset.copy);
  if (el && navigator.clipboard) navigator.clipboard.writeText(el.textContent.trim()).then(() => { b.textContent = "Copied"; });
});
`;

const ICONS = {
  now: raw(
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16.5 9"/></svg>`,
  ),
  queues: raw(
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>`,
  ),
  search: raw(
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>`,
  ),
  settings: raw(
    `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 20c1.4-3.6 4.3-5.5 7.5-5.5s6.1 1.9 7.5 5.5"/></svg>`,
  ),
  back: raw(
    `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>`,
  ),
};

export function settingsLink(): Html {
  return html`<a class="iconlink" href="/settings" aria-label="Settings">${ICONS.settings}</a>`;
}

export function backLink(href: string, label: string): Html {
  return html`<a class="back" href="${href}">${ICONS.back}${label}</a>`;
}

function tabbar(tab: Tab): Html {
  const t = (id: Exclude<Tab, null>, href: string, label: string) =>
    html`<a href="${href}" ${tab === id ? raw('aria-current="page"') : ""}>${ICONS[id]}<span>${label}</span></a>`;
  return html`<nav class="tabbar" aria-label="Main">
    ${t("now", "/", "Now")}${t("queues", "/queues", "Queues")}${t("search", "/search", "Search")}
  </nav>`;
}

export function flashBox(flash: Flash | null): Html {
  if (!flash) return html``;
  return html`<div class="flash ${flash.kind}" role="${flash.kind === "error" ? "alert" : "status"}">${flash.text}</div>`;
}

export function page(opts: {
  title: string;
  tab: Tab;
  top: Html;
  body: Html;
  flash?: Flash | null;
  /** For a signed-in page: where it was rendered. Turns on live updates. */
  live?: LiveMark;
}): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Tuit">
<meta name="theme-color" content="#f2f2f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<meta name="format-detection" content="telephone=no">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
<title>${opts.title}</title>
<style>${raw(CSS)}</style>
<script>${raw(JS)}</script>
</head>
<body${opts.live ? html` data-live="${opts.live.cursor}" data-live-at="${opts.live.at}"` : ""}>
<header class="topbar">${opts.top}</header>
<main>
${flashBox(opts.flash ?? null)}
${opts.body}
</main>
${opts.tab !== null ? tabbar(opts.tab) : ""}
</body>
</html>`;
}

export const MANIFEST = {
  name: "Tuit",
  short_name: "Tuit",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#f2f2f7",
  theme_color: "#1f7a68",
  icons: [
    { src: "/static/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/static/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/static/icon.svg", sizes: "any", type: "image/svg+xml" },
  ],
};
