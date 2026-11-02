# Codex Remote Control fork

This fork uses Electron 45.2.1 (Chromium 156) and can share a Paseo-owned
Codex app-server with the official Codex phone app. Tested with Codex 0.166.0
on Linux. The shared server is opt-in; ordinary providers keep their existing
process lifecycle.

## Setup

Use a separate `PASEO_HOME` when trying the fork beside another Paseo install.
Use a separate `CODEX_HOME` for the shared server when another Codex server
already has Remote Control enabled. Sign in with ChatGPT in that home.

In the Codex provider settings, choose **Enable Remote Control**, then
**Pair phone**. Enter the displayed manual code in the phone's computer pairing
flow. The host must remain awake and online. **Disable Remote Control** revokes
the running host connection; it does not disable local Paseo sessions.

The equivalent development commands are:

```sh
PASEO_HOME=/path/to/paseo-home CODEX_HOME=/path/to/codex-home \
  npx tsx scripts/codex-remote-control.mts enable
PASEO_HOME=/path/to/paseo-home CODEX_HOME=/path/to/codex-home \
  npx tsx scripts/codex-remote-control.mts pair
```

`status` and `disable` are also available. Pairing output is sensitive and
short-lived; do not post it in issues or commit it.

## Shared conversations and projects

Paseo connects to one persistent official Codex server over its private Unix
socket. Each provider session has a separate WebSocket-to-stdio adapter.
Closing an adapter does not stop the server. Idle cleanup retains shared
subscriptions so turns started from the phone reach Paseo.

The daemon also watches durable Codex history/index writes and imports newly
discovered threads through Paseo’s existing import workflow. This includes
phone-created conversations and an initial reconciliation on startup. Discovery
is driven by filesystem events, with duplicate and archived imports suppressed.

Paseo project IDs map idempotently to Codex projects. Project names and root
paths are synchronized when starting or reopening a session. A worktree's
conversation remains under its parent project, with its own working directory.
Conversation titles are synchronized on reopen. Pane splits, tab order, project
icons, and other Paseo presentation preferences are not Codex project metadata
and do not transfer to the phone.

Phone discovery is still under investigation with Android app 1.2026.293:
server-side projects and threads exist, but the phone's ordinary list can omit
them. Legacy workspace metadata did not resolve this. Pinning a verification
thread is being tested as a workaround for the behavior reported in
[openai/codex#41470](https://github.com/openai/codex/issues/41470).
Do not treat server-side project assignment as proof of phone visibility.

Enabling this setting does not move an already running thread from a different
server. Finish its turn and close its old runtime before reopening it against
the shared server. A thread still owned by another server will report an active
writer error. A separate home requires a deliberate history migration; changing
`CODEX_HOME` alone does not import history. Do not copy a live SQLite database
or overwrite another server's state files.

The server survives closing Paseo, allowing phone use while the desktop window
is closed. Its socket, PID, and log live in
`$PASEO_HOME/runtime/codex/<identity>/`. Disable Remote Control before retiring
that host. Stop its recorded PID only after its turns have finished.

## Touchpad speed

On Wayland the fork enables `WaylandUnscaledTouchpadScrolling`. Set
`PASEO_TOUCHPAD_SCROLL_FACTOR=1.0` for slower scrolling, or choose another
positive number. The built-in default is Chromium's 2.5. This setting affects
touchpads separately from mouse-wheel scrolling. Explicit Chromium feature
overrides in `PASEO_ELECTRON_FLAGS` take precedence. X11 is unaffected.

## Validation

The opt-in real-server test uses a temporary Codex home without credentials:

```sh
cd packages/server
PASEO_TEST_CODEX_BINARY=/absolute/path/to/codex npx vitest run \
  src/server/agent/providers/codex/shared-server.integration.test.ts
```

It verifies shared thread access, idempotent project creation and assignment,
cross-client turn notifications, attaching during a subsequent active turn,
and server survival after disconnecting a client. The test performs no
authenticated model calls. Codex 0.166 can reject a resume of a newly started
thread before its first turn has finished initializing its history; retry after
that first turn finishes.
