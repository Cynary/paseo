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

Android app 1.2026.293 can omit server-side projects and threads from its
ordinary list. Legacy workspace metadata did not resolve this. Pinning the
verification thread made it visible, and the paired phone successfully sent
messages through the shared server; Paseo received external turns and replies.
This matches the behavior reported in
[openai/codex#41470](https://github.com/openai/codex/issues/41470).
The test conversation subsequently remained visible under its normal project
after its temporary section assignment was removed. The empty test section was
deleted. Android displays the folder basename instead of the custom project name
([openai/codex#36754](https://github.com/openai/codex/issues/36754)). The fork does
not automatically pin conversations or create duplicate project sections.

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

## One-time import and machine transfer

Run these repository scripts with Python 3.10+ and the fork's Node/npm dependencies
installed. `codex-history-import.py` understands Codex 0.166's `state_5.sqlite` and
`thread_history_1.sqlite`; it refuses differing table columns. Initialize the
destination home once with the same Codex version before merging.

There are two separate steps: merge Codex history while both homes are offline,
then register conversations with a running Paseo daemon. If Paseo uses the existing
Codex home directly, skip the merge entirely. No UI or Electron process is required
on a headless host.

### t14s: merge the original home into the paired fork

From the fork checkout, preview without changing either home:

```sh
python3 scripts/codex-history-import.py \
  --source "$HOME/.codex" --target "$HOME/.codex-paseo"
```

Close the original Codex/Paseo applications and stop their app-server processes
before applying. Also stop the fork daemon and its persistent shared app-server;
closing just its desktop window does not stop that server. Its PID is recorded
under `$HOME/.paseo-fork/runtime/codex/<identity>/server.pid`. Do not stop the server
that owns a conversation still doing work, including an ongoing import-setup task.
On Linux the importer refuses an apply if another process has either history
database open.

```sh
python3 scripts/codex-history-import.py \
  --source "$HOME/.codex" --target "$HOME/.codex-paseo" --apply
```

This adds missing thread IDs and their paginated history, projects, sections,
and rollout files, including historical fork/rewind generations that are absent
from the current thread catalog. Existing thread IDs are skipped wholesale; this is not a
merge of two independently edited versions of a conversation. Archived threads
remain archived in Codex. Destination databases are backed up under
`paseo-import-backups/<timestamp>/`, and a failed database merge rolls back its
rows and newly copied files. Keep both homes offline throughout the operation.
The source is unchanged. Authentication, Remote Control pairing, settings,
memories, goals, queues, and machine-local execution state are not imported.

Start the fork again. Automatic discovery imports recent eligible conversations.
For an explicit complete registration without the recent-list window limit:

```sh
npx tsx scripts/codex-bulk-import.mts \
  --home "$HOME/.paseo-fork" --codex-home "$HOME/.codex-paseo" --apply
```

Omit `--apply` for a preview. This skips archived Codex conversations, provider
subagents, metadata-generation helpers, and conversations already registered in
Paseo (including archived Paseo records). It registers project roots/names when
not already present and uses Paseo's normal workspace import for each conversation.
Existing Paseo organization takes precedence. Multi-root project layout and pane
layout are not transferred. Failures are reported per item and produce a nonzero
exit status; rerunning skips successful imports. Missing working directories must
be restored or mapped before import.

### Headless devbox using its existing Codex home

Stop the old app-server. Configure the fork's Codex provider with
`PASEO_CODEX_SHARED_SERVER=1` and `CODEX_HOME` pointing at the existing home, then
start the Paseo daemon normally. Run the registration step on that machine:

```sh
npx tsx scripts/codex-bulk-import.mts \
  --home "$HOME/.paseo" --codex-home "$HOME/.codex" --apply
```

The daemon persists Paseo projects/workspaces in its own home. Pair its shared
server independently if phone control is wanted. Do not reuse another machine's
Remote Control enrollment.

### Move conversations to another machine

With the source app-server stopped, export a portable directory:

```sh
python3 scripts/codex-history-import.py \
  --source "$HOME/.codex-paseo" --export /path/to/new-history-export
```

Transfer that directory with `rsync` or `scp`. It contains private conversation
history, but excludes authentication files and strips Remote Control enrollment
from the exported state database. Repositories and external attachments are not
included. Copy/clone the repositories separately.

On the destination, initialize a Codex home, stop its app-server, then merge:

```sh
python3 scripts/codex-history-import.py \
  --source /path/to/new-history-export --target "$HOME/.codex" \
  --map-path /home/olduser/Projects=/home/newuser/Projects --apply
```

`--map-path` is repeatable; the longest matching path prefix wins. For histories without fork/rewind lineage, it updates working directories,
project roots, structured session metadata, and sandbox paths while adjusting
history byte offsets for changed rollout metadata. Forked paginated histories
currently require the original working-directory paths on the destination; the
importer refuses path remapping for them instead of invalidating lineage offsets. Old
paths in historical message text remain historical text. Then start Paseo and
run `codex-bulk-import.mts` as above. This is a copy/import, not ongoing sync;
keep the old copy inactive once work continues on the new machine.
