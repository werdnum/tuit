# Requirements (original brief)

## 1. What this is

A personal/household task tracker whose purpose is **keeping track of unfinished business without making all of it your problem right now**. Not a better checklist, and not a project-management app. Existing to-do apps often have complexity we don't want (projects, kanban, priorities, percent-done) and lack the complexity we do want (staleness, handoffs, forgiving recurrence, agent collaboration).

The organising insight — build everything around it:

**"What exists", "what deserves attention now", and "who can take the next step" are three different things.** Visibility to other household members is a fourth, orthogonal axis.

Spend complexity on the *meaning* of "done", "available", "waiting", "recurring" and "no longer relevant" — not on features for their own sake.

Lessons from what has actually been tried:
- Vikunja is available, but Alex has barely used it: its UI feels clunky and confusing. He has **not** meaningfully tested using it through an agent, so don't treat "Vikunja + agent" as a failed experiment. Its API is not, by itself, a reason to assume it would be a good daily task system.
- A flat note managed through the assistant has also been tried and has not been especially successful. Easy capture alone isn't sufficient either. This prototype needs both a low-friction everyday experience **and** genuinely useful semantics and surfacing. Neither an API nor conversational capture alone is enough.

## 2. Users and clients

- Two humans: Alex and Sam (household). SSO/OIDC is available for identity.
- Agents as first-class clients: family-assistant (MCP), Claude and ChatGPT web (remote MCP connectors), coding agents (CLI).
- Timezone matters: Australia/Sydney. Calendar dates ("Saturday") and exact instants ("9:00am", a flight departure) must remain distinct types — neither collapses into a midnight timestamp.

## 3. Domain model

### Task
- **Outcome**: what we're trying to achieve ("get the pool fence repaired").
- **Current brief**: short, editable — current situation, constraints, useful links.
- **Next action**: the single thing someone can actually do next.
- **Next actor**: me / named person / a specific agent / anyone-capable. This is "whose turn is it", distinct from **owner** ("who is responsible for it eventually happening" — defaults to creator, mostly invisible).
- **Waiting condition**: a reply, a date, another task, a human decision. A human decision that can be made now should appear as actionable, not disappear into "waiting".
- **State**: open / waiting / done / expired / shelved. These are distinct and matter:
  - *expired*: no longer relevant or possible ("check in for flight" after departure). Archived with reason. Not done, notes preserved.
  - *shelved*: gone cold, removed from rotation, still searchable, not asserted irrelevant.
  - Real obligations stay discoverable — "forgiving" never means quietly losing commitments.
- Human/agent/collaborative tasks are NOT different types. The next action has an actor; the task changes hands. An agent finishing a run doesn't finish the task (producing a shortlist hands it back to the human). Optional "done means…" sentence for agent work.
- **Visibility**: `household` (default) or `private`. Binary. No ACLs.

### Time (all optional; capture requires only a title)
- **available_from** — not useful/possible before this.
- **target** — would like to tackle around then. Missing a target is not "overdue".
- **deadline** — finishing after this has consequences.
- **expires** — the action stops being relevant/possible.
- Snoozing changes *attention*, never dates.
- Calculated dates store the **relationship**, not just the result: "target = deadline − 7d", "show when event is 2w away", "resurface 3d after last attempt". A small fixed set of offset relationships — no expression language.

### Recurrence — three models
1. **Calendar-based**: each Tuesday / 1st of month. Explicit missed-occurrence policy; occurrences are instances of a persistent routine template (Taskwarrior-style template/instance split).
2. **Completion-based**: again N weeks after actually done. One outstanding task; schedule moves with completion.
3. **Time-since-done**: no due date at all. Quiet until a threshold, then shows "last done 18 days ago" with growing prominence. Not "4 days overdue". This is a key differentiator; implement it properly when included.

Rules: default to **no catch-up debt** (missed occurrences skip or collapse to one outstanding action). Retrospective completion ("I did that Thursday") is easy, and the *actual* completion time drives recurrence. "Completed", "skipped" and "expired" are distinct — skipping must not reset time-since-done.

### Queues — views, not folders
- A queue is a saved selection + ordering + presentation rules (e.g. `visible_limit: 3`). A task appears in many queues without duplication.
- Contexts distinguish **requirements** (needs a computer, needs business hours) from **preferences** (prefer evenings). Preferences never become hard filters — an evening-preferred task is still findable on a free afternoon.
- Queue config is ordinary, typed, stored data: created conversationally by agents but inspectable, explainable, editable, previewable, disableable afterwards. "Why is this here / why isn't that showing?" must be answerable.
- Display rules never mutate member tasks (a task in two queues must not acquire conflicting scheduling). Appearing in an agent's queue does not grant permission to execute — selection and dispatch are separate.
- Genuinely urgent items get a warning *outside* the visible limit — "show only 3" must never hide a fourth deadline.
- Ordering: simple explainable rules + manual pinning. No mandatory LLM re-ranking on every open.

### Scratch space — two layers
- **Current brief** (editable): what this is, situation, next action, decision needed.
- **Activity history** (append-only, timestamped, typed): notes, research, decisions, attempts, handoffs, completions, system changes. Distinguish human-authored from agent-generated. Never silently erase evidence. Do NOT dump agent execution traces into the human feed — "found a candidate but they don't service the area" is progress; "looked at another webpage" is not.

## 4. Architecture requirements

### One domain API, several interfaces
Web UI, CLI and MCP server are clients of the same task operations. No interface should have its own interpretation of recurrence or completion. Tool surface small and task-oriented: create, query, get, update, complete, record-earlier-completion, checkpoint, hand off, manage queues/routines as implemented. Not one opaque execute-anything tool.

### Checkpoint — the most important operation
Atomically: append a progress note AND update next action/actor/state. Prevents an agent recording "waiting for Alex" without the task actually entering Alex's queue. Mutations should have idempotency keys; use revision checks and keep a readable change history (agents retry, and must not clobber phone edits). With multiple workers: atomic claiming of eligible work; never auto-repeat an uncertain external action because a worker timed out.

### Event/change feed — first-class integration path
Target events: created, became available, handed off, deadline approaching, routine went stale, expired, checkpoint recorded. A cursor-based poll endpoint is a useful minimum; subscription/webhook can follow. This is the integration lynchpin: automations can subscribe to the feed; long-tail integrations (email, etc.) can be agents reacting to events. Build a minimal, reliable change feed early rather than broad, untested delivery machinery; prioritise a useful human surface over feed polish.

### Identity and visibility — day one, server-side
- Use the existing OIDC/SSO setup where practical. The server must derive the human principal from a verified login or authorised delegation; a CLI or MCP client cannot choose an arbitrary `acting_for` identity. Agents act with appropriately scoped authority on behalf of a particular human, not via a household-wide superuser token. The exact grant/claim design is an implementation decision, not a client-supplied string.
- `private` filtering is enforced by the server **before anything leaves it** — task reads, search, queue results, change feeds and rendered views. The threat isn't just the other person browsing; it's an agent helpfully answering "what's Alex planning for my birthday?", a shared kitchen display rendering a household queue, or an event leaking "Sam Xmas — ring size confirmed" to an automation acting for Sam. Test this with two distinct signed-in users, including through MCP and the feed if provided.
- Private task titles never appear in notification content on shared surfaces.
- Authority stays separate from task content: an imported email or research note is not permission to act. Reuse existing agent permissions; don't invent a second permissions universe.

### Deterministic core, interpretive edges
The core owns task state, completion history, date arithmetic, recurrence, explicit expiry, query behaviour, conflict handling. Clicking "Done" or computing "14 days after last completion" must not need a model. Agents do: extracting candidate tasks, enriching sloppy captures, suggesting context/timing, creating queues, preparing work ("prepare this for me": collect the phone number, docs, proposed next step while the task stays mine), interpreting replies, unsticking stale tasks. A small scheduled script is a fine home for an odd behaviour — the requirement is that behaviour is defined, inspectable, and has one owner.

### A task is not an execution attempt
One task survives multiple agent sessions, failed runs, provider changes, human intervention. The tracker records what was requested, the useful result, what happens next. MCP's own "tasks" facility is execution state — a possible adapter, not this domain model.

### Notifications — separate attention policy
"Belongs in a queue" ≠ "interrupt me". One delivery owner per notification (don't double-send from app and assistant). Re-check state and expiry before delivery; deep-link to the decision. Ignoring a push never loses the task.

## 5. UI rule

**Use progressive disclosure.** The landing page should be an uncomplicated "toothbrush" interface for capturing and doing tasks, not a form for administering the task model. Task detail may expose more, and a dedicated inspection/debugging view is welcome for reading the full state, dates, queue membership, history and automation decisions. Complexity is good when deliberately requested; it should not be the price of everyday use.

Everyday surfaces: **Now** (short contextual selection + anything time-critical), **Queues**, **Task detail** (brief, next action, history); allow deeper inspection without crowding Now. Primary verbs: done, waiting-for, snooze, add note — plus record-earlier-completion, hand off, no-longer-relevant, and a meaningful "enough for now" (completing three tasks needn't slide three replacements into view). Capture from anywhere, title-only, tolerant of rough input (agents can enrich later). No streaks, no daily-planning ceremony, no auto-migration of yesterday's list.

## 6. Vertical slice for the prototype

Non-negotiable path: sign in → capture a title-only task on a phone → see it in a useful Now view → open its brief/history → add progress or hand it off → complete, shelve or expire it → return after a simulated long absence without backlog debt. Include a usable CLI and MCP path through the same data. Must be pleasant to use on an iPhone from day one (mobile web/PWA is fine).

End-to-end workflows:
1. A one-off task with useful notes appears in a useful view, then **expires without being marked done**, notes preserved; the user can still find and inspect it.
2. A completion-based routine supports "I did this yesterday", shows time-since-completion, and creates **no backlog after a long absence**.
3. A human–agent handoff via checkpoint: agent prepares, human decides, task moves views atomically.
4. An agent creates/modifies a queue via MCP; web UI and CLI show identical behaviour; configuration is inspectable and explainable.
5. An agent-to-agent handoff across sessions where the **current brief is the only shared context**.

Test against a **controllable clock**, test persistence across a restart, and test that Sam cannot see Alex's private task via the UI, CLI, MCP, search or change feed.

Standing acceptance tests:
- *After ignoring this for a month, can I open it, understand what matters, and do one useful thing without first maintaining the system?*
- *Can I capture a task here with less friction than putting it on a flat note, and does it actually help me act on it later?*

## 7. Explicitly out of scope

Visual workflow builder; arbitrary custom status systems; project hierarchies; automatic calendar packing; productivity scores; deep bidirectional sync; permissions beyond household/private; streaks/gamification. Private-vs-household must be explicit, never inferred from tags. Full export of tasks/history/config should be straightforward.
