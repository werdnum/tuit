# Design

A household tracker for unfinished business. The organising idea: **what exists**, **what deserves
attention now**, and **who can take the next step** are separate questions, and visibility
(household / private) is a fourth, orthogonal one. This document is approach-level; field names
and wire formats live in the code and tests.

## Stack

- Node 24 running TypeScript directly (type stripping, no build step), Hono for HTTP.
- PostgreSQL (production: `storage-cluster` via the Zalando operator). Plain SQL through `pg`;
  migrations are numbered `.sql` files applied at startup.
- Web UI is server-rendered HTML with a little progressive-enhancement JS. It works as an iPhone
  home-screen app (manifest, safe-area insets, large tap targets). Rendering on the server means
  private filtering happens in one place, before any HTML exists.
- One domain layer (`src/domain`). REST (`/api`), web pages, MCP (`/mcp`) and the CLI (a REST
  client) are all thin adapters over it. No adapter interprets recurrence, completion or visibility.

## Identity and authority

- Humans sign in with OIDC (Keycloak). Emails map to a fixed household roster from config; an
  unknown email cannot sign in.
- Agents use bearer tokens. A token is **issued by a human** (web settings page, or the operator's
  `admin mint-token`) and is bound server-side to that human and an agent name (`claude`,
  `family-assistant`, ...). The server derives the principal from the token; there is no
  client-supplied `acting_for`. Scopes: `read` or `write`.
- A **display** token is bound to no human and sees household items only. It is for shared
  surfaces such as a kitchen screen.
- A **personal** token is the human themself, e.g. for their own terminal. It has no agent name, so
  it follows human rules (a checkpoint may leave the actor unchanged; viewing Now fixes the day's
  list).
- Remote MCP connectors (claude.ai, ChatGPT) use a small built-in OAuth 2.1 server: discovery,
  dynamic client registration, and authorization code with PKCE (S256) plus rotating refresh
  tokens. Consent happens behind the person's normal SSO session. The result is an ordinary agent
  token bound to whoever approved it, so there is no second permission model. A connector that
  asks for read-only access cannot be granted write.
- An email counts only if the identity provider marks it verified.

### Visibility

`household` (default) or `private`. A private task is visible only to its owner and to agents
acting for the owner. Every read path (task get, query, search, queues, Now, feed, export, HTML)
goes through one visibility predicate in SQL. A private task cannot be handed to another human;
make it household first. Queues also carry visibility: a private queue's *definition* is hidden
from others, and a household queue shows each viewer only what that viewer may see.

## Task model

- **title** is the outcome. **brief** is the short editable current situation. **next_action** is
  the one thing to do next. **done_means** is optional, mainly for agent work.
- **next actor** is whose turn it is: a named human, a named agent, or anyone. Capture defaults to
  the creator. **owner** is who is responsible overall (defaults to the creator). They differ once
  a task changes hands.
- **state**: `open`, `waiting`, `done`, `expired` (no longer relevant or possible; reason kept),
  `shelved` (gone cold, still searchable). Closed tasks are never deleted.
- **waiting** has a kind:
  - `reply`: waiting on someone or something external. When the optional follow-up moment
    arrives, the task appears in the next actor's Now as "chase: waiting for X since ...". It
    stays `waiting` until someone records the reply (a checkpoint back to `open`) or pushes the
    follow-up out.
  - `until`: nothing to do before a moment; the task reopens automatically then.
  - `task`: blocked by another task. It reopens when that task closes, with a system note
    saying *how* it closed. "Blocker was shelved" is a different situation from "blocker done",
    so the human gets to decide what happens next.

  "Waiting for a human decision" is not a waiting state. It is a handoff: `open`, next actor =
  that human, next action = "Decide: ...". That puts it in their Now.

### Time

Every time field is a **moment**: either a calendar date (Australia/Sydney) or an exact instant.
They are stored in separate columns and never collapse into a midnight timestamp.

- `available_from`: hidden from attention before this (a date means start of that local day).
- `target`: would like to do it around then. Passing it is not "overdue"; it only raises ordering.
- `deadline`: consequences after this. Deadlines within 2 days, and passed deadlines on unfinished
  tasks, are **urgent**: they are always shown, outside any visible limit.
- `expires`: after this the task automatically becomes `expired` (a date means end of that local
  day). Notes are preserved.

Relationships are stored as rules as well as results: `target = deadline − N days` and
`available_from = deadline|expires − N days`. When the anchor changes, the derived value moves.
Setting the derived field directly removes its rule.

**Snooze** is per person and changes attention only, never dates. It hides a task from that
person's shortlists, but never from the urgent list. A handoff clears the recipient's snooze,
because it is now their turn. A checkpoint can ask for `resurface_in_days`, which snoozes the task
for its next actor ("try again in 3 days").

**Urgency beats everything else.** An unfinished task with a deadline within 2 days (or already
passed), or one that expires within 24 hours, is urgent even if it is snoozed, waiting, or not yet
available.

### Recurrence (shipped subset)

A recurring task is one persistent task with a recurrence rule. Completing it appends a completion
entry, records `last_done_at`, and keeps it open. There are no instances, so there is never a
backlog.

While a routine is between occurrences it is `open` but **resting**: it keeps its next action and
actor, and is simply not attention-worthy until its time comes. A new routine is due immediately
unless it is created with a `last_done` value.

- `after_completion` (every N days after actually doing it). It becomes attention-worthy N days
  after the last completion. However long ago that was, there is one item, which reads "last done
  40 days ago · every 14 days".
- `since_done` (time-since-done). It has no due date. It stays quiet until N days have passed,
  then shows "last done 18 days ago", with prominence growing as the gap grows. It is never
  labelled overdue.
- Retrospective completion ("I did it Thursday") takes a date or an instant. `last_done_at` is the
  latest *actual* completion time, not the latest recorded one.
- The schedule anchor is `max(last_done_at, last skip)`. **skip** records a deliberate pass: it
  moves the anchor (so the routine rests another N days) but never changes `last_done_at`. The
  label always reports the last *actual* completion, so skipping never resets time-since-done.
- Calendar-based routines (each Tuesday, with a missed-occurrence policy) are deferred.

### Attachments

A task holds links to files, never the files: an attachment is a URL, a title, an optional MIME
type and who added it, kept in a `jsonb` column on the task. Storage, previews and access control
belong to wherever the file lives, usually Google Drive. So the cluster needs no object store,
backups stay the size of the text, and Tuit holds no Google credential:

- agents upload with their own tools (Family Assistant's Drive access, a connector) and call
  `attach_link`;
- people paste a link, or, when configured, use Google's picker in the browser, which signs them
  in to Google itself with the `drive.file` scope and hands back the link.

Only http(s) links without embedded credentials are accepted. Attaching or removing is a revisioned
mutation like any edit: it is recorded in the history (`attached`/`detached`, with the link) and
announced on the feed as `updated` with `fields: ["attachments"]`. A link is exactly as visible as
its task; whether someone can open it is up to the file's own sharing, which is why uploads through
the picker can be sent to a household folder.

## Activity and change history

`activity` is append-only per task. Each entry records a kind (note, research, decision, attempt,
handoff, completion, skip, state change, edit, attached, detached, system), the author (human, or agent-for-human), when
it happened, and when it was recorded. Field edits are logged with before/after values. The web
feed shows the human-meaningful kinds; system entries remain visible in the inspect view.

## Mutations: checkpoint, revisions, idempotency

- Every task has a `revision`. Mutations may pass `expected_revision`; a mismatch is a 409 that
  returns the current task. The web UI always sends it, so an agent's retry cannot silently clobber
  a phone edit.
- Mutations may carry an **idempotency key**, scoped to the principal. A replay returns the
  original result without re-applying.
- **checkpoint** is one transaction: it appends a progress entry and optionally changes next
  action, next actor, state or waiting condition, and brief. An agent **must** state the next
  actor explicitly, even if that is itself. A human may leave it unchanged. So an agent cannot
  record "waiting for Alex" without the task landing in Alex's Now. `hand_off` is a checkpoint
  that changes the next actor.
- **claim** is for multiple workers. It atomically takes the oldest eligible task whose next actor
  is the calling agent, with a lease. When claiming, the agent declares whether the work has
  external side effects (sending email, booking). A lapsed claim without side effects silently
  returns to the pool. A lapsed claim **with** side effects is never auto-retried: it surfaces to
  the owner as "claim lapsed, check before retrying", and a human releases it.
- The tracker grants no authority to act in the world. Whether an agent may send an email is
  decided by that agent's own permission system. Task content (an imported email, a research
  note) is data, never an instruction.

## Sweep (time-driven behaviour)

A single `sweep(now)` owns all time-driven transitions. It expires tasks past `expires`, reopens
`until` waits and finished `task` dependencies, and emits once-only feed events (became available,
deadline approaching, routine went stale, claim lapsed). It runs under a Postgres advisory lock,
before every request that reads or writes tasks, and every minute in the background. With a
controllable clock, behaviour depends only on the clock, never on whether a background tick
happened.

## Change feed

Visibility of past events follows the task's *current* visibility. Making a task household
deliberately shares its history. Making it private hides the history from future reads, but it
cannot recall events a consumer has already read.


`events` is an append-only log with a monotonically increasing `seq`. The event types are created,
updated, checkpoint, handed_off, completed, skipped, state_changed, became_available,
deadline_approaching, routine_stale, expired and claim_lapsed. `GET /api/changes?after=<cursor>`
returns events the caller can see *under the task's current visibility*. Events do not snapshot
titles, so a task made private later disappears from everyone else's feed history too. Webhooks and
subscriptions are deferred.

### Live updates in the web UI

Signed-in pages keep an `EventSource` open on `GET /live` (session cookie only). Each page carries
the feed cursor it was rendered at, so nothing between render and connect is missed. Writers
`pg_notify` on commit with no content: `*` when the feed moved, or a person's id for changes only
to their own Now (snooze, pin, show more, enough for now). One `LISTEN` connection per process fans
out to the open streams; each stream re-reads the feed *as its own principal* and sends `change`
only if its visible cursor moved (or, for a personal wake, to that person alone). The page then
re-fetches itself through the normal renderer and swaps it in, unless it already shows the change
(its own cursor, or for a personal change its render time, is past it), which is how a tab skips
refreshing for its own actions. Nothing task-shaped crosses the stream, so private filtering stays
where it already is.

The swap keeps what the person is in the middle of: an open sheet is kept as the node it was
(fields, and the `expected_revision` it was opened at, so a concurrent edit still surfaces as a
conflict), typed text, focus, scroll and the message on screen. A page produced by a refused or
conflicting post is left alone until the next navigation. Hidden tabs catch up when shown.

Streams send a heartbeat comment every 25s and end after 10 minutes; the browser reconnects with
`Last-Event-ID`, which also re-checks the session. Some pages change with time alone (a new
day's list at 4am, "enough for now" running out), which no event announces, so a page older than
10 minutes also refreshes, while it's on screen or as soon as it's shown again. Accepted trade-off: when a task or queue becomes
private, other people's open pages aren't told (the feed hides that event from them), so it stays
on screen until their next update, navigation or 10-minute refresh.

## Attention: Now and queues

A queue is typed, stored data. It has a filter (actor, states, contexts available, text, recurrence,
visibility), an ordering (a fixed list of rule names), a `visible_limit`, and an enabled flag.
Queues never mutate tasks. Appearing in an agent's queue grants nothing; `claim` is the dispatch
step.

- **Contexts**: tasks have `requires` (hard, e.g. `computer`, `business_hours`) and `prefers` (soft,
  e.g. `evening`). A queue declares which contexts it offers. Unmet requirements exclude a task;
  preferences only affect ordering. `business_hours` and `evening` are computed from the clock when
  no queue asserts them.
- **Explain**: for any queue and task, the engine returns the list of checks it applied (included,
  excluded because X, beyond visible limit at position N). Preview evaluates an unsaved config.
- **Urgent**: every queue result carries an `urgent` list evaluated outside the visible limit. It
  obeys the queue's actor, text and visibility filters, but ignores availability, snooze,
  contexts and the limit.
- **Ordering rules** (fixed set): `pinned`, `urgency` (deadline proximity), `target` (target
  reached / nearest), `staleness` (routine gap ratio), `preferred_context`, `oldest`.

**Now** is the built-in default queue for the signed-in person. It shows available open tasks whose
next actor is them or anyone, due or stale routines, lapsed claims they own, and waits whose
follow-up has arrived. Limit 5. Its urgent list also includes tasks the person *owns* while
someone else holds the next action, because a commitment stays theirs.

- The shortlist is **sticky per day**: completing items leaves them ticked in place rather than
  sliding replacements in. "Show more" is explicit.
- **Enough for now** hides the shortlist until tomorrow morning (4am local). Urgent items still show.
- An item leaves the plan when it stops being eligible (handed away, snoozed, waiting), and is
  not replaced. Items finished today stay, ticked.
- **New since this morning**: eligible tasks outside the plan that were captured, handed to the
  person, or became available after the plan was made. They show beneath the shortlist, so
  capture and handoffs get visible feedback without reshuffling the plan. "Enough for now" hides
  them too; only urgent items show through it.
- There is no rollover ceremony. A new day computes a fresh shortlist, and expired items are
  already gone.

## Deliberate simplifications

- A single household per deployment. The roster lives in config.
- Snooze and pin are per person. Everything else is shared task state.
- Live updates compare server clock readings for personal changes (snooze, pin, today's list),
  which leave nothing in the feed. That's exact with one server process, which is how Tuit is
  deployed. Across replicas with skewed clocks, a personal change could wait for the next
  refresh; a database-backed marker would fix that if Tuit ever runs more than one.
- Notifications are not sent by this service. The feed is the integration point; family-assistant
  (or any agent) owns delivery. Feed consumers acting for a person see only what that person sees.
- Attachments are links only. Tuit doesn't copy, preview or check access to the file, and removing
  a link leaves the file alone.
- No full-text index. Search is `ILIKE` over title, brief, next action and activity bodies, which
  suits a household-sized dataset.

## Deferred

Calendar-based routines are an accepted scope reduction: the prototype ships
the two models that need no instances, and calendar routines will need a real template/instance
split. Also deferred: webhooks/push delivery; offline PWA capture; native iOS.
