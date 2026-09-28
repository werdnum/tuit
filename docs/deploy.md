# Deploying

**What's here:** what Tuit needs to run, the configuration it reads, and what to put in front of it.

## What it needs

- The container image built from `Dockerfile` (Node 24, no build step). It listens on port 8080 and
  exposes `GET /healthz` for probes.
- PostgreSQL. Migrations run on startup, and one replica is enough.
- An OpenID Connect provider for sign-in (Keycloak, Authentik, …). Use a confidential client with
  redirect URI `${PUBLIC_URL}/auth/callback`. The provider must release a verified email address.

## Configuration

| Variable | Example | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://u:p@db:5432/tuit?sslmode=no-verify` | Use `sslmode=no-verify` for a self-signed server certificate. |
| `PUBLIC_URL` | `https://tuit.example.com` | Used for OIDC and OAuth redirects, cookies (Secure when https) and same-origin checks. |
| `TUIT_USERS` | `alex:alex@example.com:Alex,sam:sam@example.com:Sam` | The household, as `id:email:Display name` entries separated by commas. Sign-in is refused for any other email. |
| `OIDC_ISSUER` | `https://id.example.com/realms/home` | |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | `tuit` / secret | |
| `OIDC_TRUST_UNVERIFIED_EMAIL` | `1` | Only set this if the provider fully controls users' emails but doesn't mark them verified. |
| `MCP_JWT_ISSUER` | `https://id.example.com/realms/home` | Optional. Remote MCP connectors authenticate with this authorization server instead of Tuit's built-in one (see below). |
| `MCP_JWT_AUDIENCE` | `tuit-mcp` (default) | The audience connector tokens must carry. |
| `MCP_JWT_JWKS_URI` | `http://keycloak.internal/realms/home/protocol/openid-connect/certs` | Optional. Where to fetch signing keys; defaults to the issuer's discovery document. |
| `TUIT_TIMEZONE` | `Australia/Sydney` (default) | The household zone for calendar dates. |
| `TUIT_SWEEP_INTERVAL_MS` | `60000` (default) | Background tick for time-driven feed events. Reads always sweep first anyway. |
| `TUIT_DEV_LOGIN` | `1` | Local only: pick-a-user login. Refused unless `PUBLIC_URL` is localhost, and forces a loopback bind. |
| `TUIT_TEST_CLOCK` | `1` | Tests only: exposes `POST /__test/clock`. Never set this in production. |

## In front of it

Tuit authenticates every request itself. Even so, it's reasonable to keep the web UI behind an
access proxy as well, such as Cloudflare Access or oauth2-proxy.

These paths serve machine clients and do their own authentication:

- `/mcp` accepts bearer tokens.
- `/oauth/*` and `/.well-known/oauth-*` are the OAuth server for remote MCP connectors such as
  claude.ai and ChatGPT. Consent still happens behind the normal sign-in.
- `/api/*` accepts bearer tokens for the CLI and automations.

If an access proxy blocks these paths, remote connectors can't connect. Header-capable clients
still can, for example with the proxy's service tokens.

The web UI's live updates are a long-lived server-sent events response on `/live`. Proxies must
not buffer it or cap the whole response's duration: Envoy's default 15s route timeout would cut it
(set `requestTimeout: 0s`), and nginx needs no change because Tuit sends `X-Accel-Buffering: no`.
Idle timeouts of 30s or more are fine; Tuit sends a heartbeat every 25s and ends each stream after
10 minutes, and the browser reconnects.

### Remote connectors through your own identity provider (recommended when exposed publicly)

Set `MCP_JWT_ISSUER` and Tuit accepts access tokens from that issuer on `/mcp`. Tuit's
protected-resource metadata then points connectors at the issuer, and the built-in OAuth server is
switched off.

- **Acting person:** the token's verified `email` picks the household member. It must be on
  `TUIT_USERS`.
- **Agent name:** the client the token was issued to becomes the agent name. `tuit-claude-ai`
  becomes `agent:claude-ai`.

Register one client per connector (claude.ai, ChatGPT, Claude Code), each with an audience mapper
for `tuit-mcp`.

This lets a gateway validate the same JWT before a request ever reaches Tuit. Expose `/mcp` and
`/.well-known/oauth-protected-resource` publicly, with the gateway checking the issuer, the
audience and a household email allowlist on `/mcp`. Keep everything else behind the access proxy.

Tuit's own tokens keep working for callers that don't go through the gateway, such as an
assistant running in the same cluster.

## First run

Sign in, open Settings, and create what you need:

- **Agent tokens**, one per agent and per person, such as `claude` and `family-assistant`.
- **A personal token** for your own terminal.
- **A display token**, if you want a shared screen.

See [agents.md](agents.md).
