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

## First run

Sign in, open Settings, and create what you need:

- **Agent tokens**, one per agent and per person, such as `claude` and `family-assistant`.
- **A personal token** for your own terminal.
- **A display token**, if you want a shared screen.

See [agents.md](agents.md).
