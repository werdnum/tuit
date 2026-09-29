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
- **Live updates**: while the app is open it polls `/api/changes` every 15 seconds and
  reloads when the feed moves.
- `tuit://tasks/<id>` opens a task.

## Signing in

The app opens `/app/authorize` in a browser sheet (`ASWebAuthenticationSession`). There the
person signs in with the normal SSO and confirms "Sign in to the Tuit app?". The server
redirects to `tuit://signed-in` with a one-time code, and the app swaps the code and its PKCE
verifier at `POST /app/token` for a **personal token**. The token is stored in the Keychain
and appears in Settings → Tokens as "Tuit app on <device>". Signing out revokes it
(`POST /app/signout`). This path works whether or not the built-in OAuth server is on, i.e.
also when connectors use Keycloak.

Pasting a personal token made in Settings → Tokens works too.

## On your iPhone

On a Mac where Xcode is signed in to the team, plug in the phone (unlocked, Developer Mode
on) and run:

```bash
./ios/build-and-install.sh
```

It generates the project, builds a Release build, installs it and launches it. After the first
cable install you can pair the phone over Wi-Fi in Xcode (Window → Devices), and later installs
don't need the cable.

## Building

The Xcode project is generated from `Project.swift` with [Tuist](https://tuist.dev)
(`brew install tuist`) and is not checked in.

```bash
cd ios
tuist generate            # writes Tuit.xcodeproj and opens it
xcodebuild -project Tuit.xcodeproj -scheme Tuit \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

Signing is automatic, with team `H7NBC2S52X` and bundle id `dev.andrewgarrett.tuit`. To use
another team, change both in `Project.swift`. If the repo is on a network or shared volume,
pass `-derivedDataPath` pointing at a local disk.

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
- Widgets, and offline capture.
- Queues. They're configured on the web.
- Full block Markdown. Briefs render inline Markdown, and list items become bullets.
