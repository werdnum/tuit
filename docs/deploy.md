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
| `MCP_JWT_AUDIENCE` | `tuit-mcp,tuit-api` | Audiences accepted from the issuer, comma-separated. Default `tuit-mcp`. |
| `MCP_JWT_PERSONAL_CLIENTS` | `tuit-ios` | Optional. Clients whose tokens act as the person themself, not as an agent (the iPhone app). |
| `TUIT_IOS_APP_IDS` | `H7NBC2S52X.dev.andrewgarrett.tuit` | Optional. `<Team ID>.<bundle id>` of the iPhone app, comma-separated for several. Served in `apple-app-site-association`, so only that app receives the sign-in callback link. |
| `MCP_JWT_JWKS_URI` | `http://keycloak.internal/realms/home/protocol/openid-connect/certs` | Optional. Where to fetch signing keys; defaults to the issuer's discovery document. |
| `GOOGLE_PICKER_API_KEY` | `AIza...` | Optional. With the next two, adds "Choose or upload from Google Drive" to the task page (see below). A browser key: restrict it to your `PUBLIC_URL`. |
| `GOOGLE_PICKER_CLIENT_ID` | `1234-abc.apps.googleusercontent.com` | A Google OAuth client of type "Web application". |
| `GOOGLE_PICKER_APP_ID` | `123456789012` | The Google Cloud project number. |
| `GOOGLE_PICKER_UPLOAD_FOLDER_ID` | `1AbC...` | Optional. Files uploaded through the picker go into this Drive folder (share it with the household) instead of the uploader's My Drive. |
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
- `/api/*` accepts bearer tokens for the CLI, automations and the iPhone app.
- `/.well-known/apple-app-site-association` and `/.well-known/app-auth-callback` must be public.
  The identity provider sends the iPhone app's sign-in code to the second, and Apple fetches the
  first to learn that only the Tuit app may receive it.

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

### The iPhone app

The app signs in with the same issuer, as a public client with PKCE (e.g. `tuit-ios`, with consent
required). Its redirect URI is `https://<PUBLIC_URL host>/.well-known/app-auth-callback`, it asks
for `openid email offline_access`, and its access tokens carry `aud=tuit-api`. Tuit issues no
tokens for it, so no Tuit endpoint has to face the internet for sign-in.

- Add `tuit-api` to `MCP_JWT_AUDIENCE` and the client to `MCP_JWT_PERSONAL_CLIENTS`, so its tokens
  act as the person, not as an agent.
- Set `TUIT_IOS_APP_IDS`.
- Expose `/api` publicly, with the gateway checking the issuer, `aud=tuit-api` and the household
  email allowlist, as for `/mcp`. The web UI doesn't use `/api`, so nothing else needs it from
  outside.

## Google Drive on the task page (optional)

Attachments are links: Tuit never stores files or holds a Google credential. With the three
`GOOGLE_PICKER_*` settings, the task page also offers Google's own picker to choose a Drive file
or upload one. It runs entirely in the browser: each person signs in to Google the first time,
with the `drive.file` scope (only files they pick or upload through it), and the resulting link
is attached like any other.

In the Google Cloud console, in one project:

1. Enable the **Google Picker API**.
2. Create an **API key**, restricted to websites `https://tuit.example.com/*` and to the Picker
   API.
3. On the OAuth consent screen, add the `.../auth/drive.file` scope. While the app is in testing,
   add each household member as a test user.
4. Create an **OAuth client ID** of type *Web application*, with `https://tuit.example.com` as an
   authorised JavaScript origin. No redirect URI is needed.
5. The **app ID** is the project number, from the project's settings page.

For uploads that the rest of the household can open, create a Drive folder, share it with them,
and set `GOOGLE_PICKER_UPLOAD_FOLDER_ID` to the id at the end of its URL. Choosing an existing
file doesn't change its sharing, so a file only its owner can open stays that way.

## First run

Sign in, open Settings, and create what you need:

- **Agent tokens**, one per agent and per person, such as `claude` and `family-assistant`.
- **A personal token** for your own terminal.
- **A display token**, if you want a shared screen.

See [agents.md](agents.md).
