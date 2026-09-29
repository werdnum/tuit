# Tuit

*For things you'll do when you get a round tuit.*

A household tracker for unfinished business, built for Alex and Sam and their agents. It is
not a checklist and not a project manager. It keeps apart three questions: what exists, what
deserves attention now, and whose turn it is. It spends its complexity on what "done", "waiting",
"recurring" and "no longer relevant" mean.

- **Now**: a short list for today plus anything time-critical. Finishing items doesn't slide
  replacements in, and "Enough for now" is a real option. After a month away there's still no
  backlog: expired things are gone, commitments are surfaced, and the list is short.
- **Task detail**: the outcome, a short editable brief (Markdown, with collapsible sections), one next action, and whose turn it is.
  History is append-only; agent entries are marked. Files are attached as links (paste one, or
  pick or upload from Google Drive), so Tuit never stores them.
- **Routines**: "every N days after I actually did it", or "time since done" (quiet until a
  threshold, then "last done 18 days ago", never "overdue"). You can record that you did it
  yesterday. Skipping doesn't count as doing.
- **Agents are first-class**: MCP, OAuth connectors for claude.ai and ChatGPT, and a CLI, all over
  the same domain operations. `checkpoint` records progress and changes hands atomically.
- **Private means private**: it is enforced on the server, before anything leaves it, on every
  path — web, REST, MCP, search, queues, change feed and export.

Docs: [design](docs/design.md) · [agents and integrations](docs/agents.md) ·
[deploying](docs/deploy.md) · [original brief](docs/requirements.md)

## Try it locally

Needs Node 24 and PostgreSQL server binaries (`initdb`, `pg_ctl`; e.g. `brew install postgresql@16`).

```bash
npm install
npm run local        # persistent Postgres in .tmp/localpg, dev login, http://localhost:8080
```

Pick a person on the sign-in page. To use it from the terminal, create a personal token in
Settings, then:

```bash
./bin/tuit login --url http://localhost:8080 --token <token>
./bin/tuit add ring the vet about Milo\'s teeth
./bin/tuit            # Now
```

## Tests

```bash
npm run typecheck && npm run lint
npm test              # API, MCP, CLI and unit tests (vitest) against real Postgres + real server
npm run test:e2e      # Playwright, iPhone WebKit profile, real OIDC sign-in
```

Every functional test runs the real server as a subprocess against a fresh database. Sign-in goes
through a real OpenID provider (node-oidc-provider). A controllable clock (`POST /__test/clock`,
enabled only with `TUIT_TEST_CLOCK=1`) drives missed routines, expiry, lapsed claims and month-long
absences. Unit tests exist only for rough date parsing, where the edge cases are subtle.

## Layout

| Path | What |
| --- | --- |
| `src/domain/` | The deterministic core: tasks, checkpoint, recurrence, attention (Now/queues/explain), sweep, feed |
| `src/api/` | REST, auth (OIDC sessions, tokens), OAuth server for remote MCP connectors |
| `src/mcp/` | MCP server (streamable HTTP, stateless) |
| `src/web/` | Server-rendered, phone-first web UI |
| `src/cli/`, `bin/tuit` | CLI, a pure REST client |
| `src/db/migrations/` | SQL migrations, applied on startup |
| `deploy/kube-config/` | Draft manifests for the cluster (not yet applied) |

## What's in and what isn't

**Shipped:**
- sign-in (OIDC) and household/private visibility;
- title-only capture;
- Now with a sticky daily list, "enough for now", urgent items outside every limit, and an
  "away" summary;
- attachments as links, from the web (including Google's Drive picker when configured), MCP and
  the CLI;
- task detail: note, waiting-for (reply / until / another task), snooze, hand off, done, done
  earlier, no longer relevant, shelve, reopen;
- dates versus instants, with derived dates stored as rules (e.g. deadline − 7 days);
- completion-based and time-since-done routines;
- queues: typed config with preview, explain and enable/disable, and contexts where requirements
  filter and preferences only reorder;
- an inspect view;
- atomic checkpoint, idempotency keys, revision checks, and claims with side-effect-aware leases;
- the change feed, and live updates in the web UI driven by it (no refreshing to see changes);
- export;
- MCP, OAuth connectors and the CLI.

**Deferred:**
- **Calendar-based routines** ("every Tuesday"). They need a real template/instance split.
- **Webhook or push delivery** of the feed. The feed is the integration point, and
  family-assistant owns notifications.
- **Offline capture.** There's no service worker.
- **A browser surface for display tokens.** They work over the API only.
- **An idempotency key on capture from the web** (a double-submit on a flaky connection can
  create two tasks).
