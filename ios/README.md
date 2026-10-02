# Tuit for iPhone

A native SwiftUI client over the same REST API as the web app and CLI (`/api`). It doesn't
interpret anything itself: urgency, labels, recurrence and visibility all come from the server.

- **Now**: urgent items, today's sticky list (finished items stay ticked), "new since this
  morning", area chips, show more, and "enough for now". Swipe right to finish, left to snooze
  until tomorrow or pin.
- **Capture**: title-only, with `#area` at either end. Also "Add to Tuit" in Siri, Shortcuts
  and the Action button.
- **Task**: brief (Markdown), next action, whose turn, waiting, dates, links and history. You
  can mark it done or done earlier, skip a routine, add a note, hand off, set waiting-for or
  stop waiting, snooze, pin, edit, attach a link, mark it no longer relevant, shelve or reopen.
  Every change sends `expected_revision`, so a concurrent edit shows up as a conflict instead
  of being overwritten.
- **Tasks**: search, or browse by state.
- **Sharing**: tap Share in a task, or long-press a task in Now or Tasks and choose
  Share task. This opens the iOS share sheet with the task's web link; recipients still need
  access to the task, and sharing doesn't change its visibility.
- **Live updates**: while the app is open it polls `/api/changes` every 15 seconds and
  reloads when the feed moves.
- `tuit://tasks/<id>` opens a task (the scheme is only for links, never for sign-in).

## Offline use

After signing in online, Tuit saves Now, your tasks, their briefs and history on this phone.
Saved screens appear immediately after a cold launch. While disconnected, Tasks searches the
saved titles, briefs, next actions and notes. The banner marks saved data; urgency and dates
remain the server's last assessment until you reconnect. A view that hasn't finished downloading
shows a clear message instead of an endless spinner.

Capture (including Siri/Shortcuts), notes, edits, handoffs, waiting, completion, skipping,
closing, reopening and attachment changes are saved to an ordered outbox **before** sending.
Captures and changes remain visible in Settings → Saved changes across app restarts. They sync
when the app returns to the foreground, during its regular polling, or with **Sync now**.
Changes appear in task lists after the server accepts them. Completion preserves when you tapped
Done, rather than recording the eventual reconnection time.

The request and idempotency key survive retries. Successive edits from the same saved revision
chain through the server revisions acknowledged for your own changes; every send still checks
its revision, so another person's intervening edit produces a conflict. A lost response cannot
create another capture or completion. Conflicts and rejected changes stay visible and stop the
outbox: review the current task, discard the rejected change and make a new edit. Retry resends
the original request; it never removes the revision check. Signing out discards saved data and
unsynced changes, with a confirmation that names that consequence. Snapshots and the outbox
belong to one sign-in and server, use iOS file protection, and are excluded from backup.

Snooze, pin, Show more and Enough for now still require a connection. Those endpoints do not
have durable idempotency keys; the app does not silently replay them. Offline search covers only
successfully downloaded data, and automatic syncing needs the app in the foreground.

### Offline tests

```bash
npm ci
cd ios && mise exec -- tuist generate --no-open && cd ..
npm run test:ios:offline
```

The runner starts an isolated PostgreSQL database and the real REST server, then runs Swift
persistence/API tests, real-server integration tests, and an iPhone simulator UI test. Its local
proxy deliberately disconnects requests and drops a response after a committed write. Tests
verify deduplicated captures, completion/history, revision conflicts, saved browsing and capture
across cold launches, and reconnection. The xcresult includes a real simulator screenshot.
The fixture cleans up its server and database. Port 18089 must be free. Set
`TUIT_IOS_DESTINATION` or `TUIT_IOS_DERIVED_DATA` to override the simulator or build directory.
Ordinary Xcode tests run the persistence/API suite without the fixture; use the runner for full
integration and UI coverage. GitHub's iOS workflow runs the full fixture-backed suite on PRs.

## Signing in

The app signs in with the household's identity provider (Keycloak), not with Tuit. It uses
standard OpenID Connect in a browser sheet (`ASWebAuthenticationSession`), as the public client
`tuit-ios` with PKCE and a consent screen:

1. It opens Keycloak's authorization endpoint, found from `TuitIssuer` in Project.swift.
2. Keycloak sends the code to `https://<host>/.well-known/app-auth-callback`. That is a Universal
   Link: iOS gives it only to this app, because the app's associated domains list the host and
   the server's `apple-app-site-association` names the app. A `tuit://` scheme would not do,
   because any app can claim one.
3. The app redeems the code and its PKCE verifier at Keycloak's token endpoint. It asks for
   `offline_access`, so the refresh token outlives the browser session.
4. The refresh token lives in the Keychain. Access tokens (`aud=tuit-api`) are kept in memory
   and renewed shortly before they lapse, or once after a 401.
5. On `/api`, the gateway checks each access token before Tuit sees it, as for `/mcp`. Tuit
   checks it again and, because `tuit-ios` is a personal client, acts as the person rather than
   as an agent.
6. Signing out revokes the refresh token at Keycloak.

Tuit itself issues nothing for the app.

For this to work:

- the server is the one in `Project.swift` (`host`), since entitlements are fixed at build time;
- Keycloak has the `tuit-ios` client, with that callback as its redirect URI;
- Tuit has `TUIT_IOS_APP_IDS`, `tuit-api` in `MCP_JWT_AUDIENCE`, and `tuit-ios` in
  `MCP_JWT_PERSONAL_CLIENTS` (see docs/deploy.md).

Any other server, such as `npm run local`, works with a pasted personal token from
Settings → Tokens.

## On your iPhone

On a Mac where Xcode is signed in to the team, plug in the phone (unlocked, Developer Mode
on) and run:

```bash
./ios/build-and-install.sh
```

It generates the project, builds a Release build, installs it and launches it. After the first
cable install you can pair the phone over Wi-Fi in Xcode (Window → Devices), and later installs
don't need the cable.

## TestFlight with Xcode Cloud

The generated Xcode project and shared scheme are checked in so Xcode Cloud can discover the
archive scheme in its workflow editor. `ci_scripts/ci_post_clone.sh` installs the Tuist version
pinned in `.mise.toml` and regenerates the project after Xcode Cloud clones the repo. When
`Project.swift` changes, regenerate and commit the project too. One-time setup, on a Mac with
Xcode signed in to team `H7NBC2S52X`:

1. The App Store Connect app record for `dev.andrewgarrett.tuit` exists.
2. In the Apple Developer portal, the App ID `dev.andrewgarrett.tuit` has **Associated Domains**
   enabled. Automatic signing usually does this on the first signed build.
3. Run `cd ios && tuist generate`, open `Tuit.xcodeproj`, then choose Product → Xcode Cloud →
   Create Workflow for the `Tuit` scheme and grant access to `werdnum/tuit`.
4. Edit the workflow:
   - start condition: changes to `main` under `ios/`;
   - action: **Archive**, platform iOS;
   - post-action: **TestFlight Internal Testing**, to your internal group.
5. Start a build. The build number comes from Xcode Cloud.

Nothing about the workflow is stored in the repo. If `ci_post_clone.sh` fails to find Tuist,
check that the workflow's clone includes `ios/.mise.toml`.

## Building

Generate the project with [Tuist](https://tuist.dev) (`brew install tuist`, or `mise install`):

```bash
cd ios
tuist generate            # writes Tuit.xcodeproj and opens it
xcodebuild -project Tuit.xcodeproj -scheme Tuit \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

Signing is automatic, with team `H7NBC2S52X` and bundle id `dev.andrewgarrett.tuit`. To use
another team, change both in `Project.swift`, along with `host`. If the repo is on a network or
shared volume, pass `-derivedDataPath` pointing at a local disk.

### Against a local server

`npm run local` serves on `http://localhost:8080`. The simulator can reach it, and App
Transport Security allows local networking. Debug builds also accept launch environment
variables, which skip sign-in for screenshots:

```bash
SIMCTL_CHILD_TUIT_SERVER=http://localhost:8080 SIMCTL_CHILD_TUIT_TOKEN=<personal token> \
SIMCTL_CHILD_TUIT_OPEN=<task id> xcrun simctl launch booted dev.andrewgarrett.tuit
```

## Not yet

- Push notifications. The server doesn't send any; family-assistant owns delivery.
- Widgets.
- Queues. They're configured on the web.
- Full block Markdown. Briefs render inline Markdown, and list items become bullets.
