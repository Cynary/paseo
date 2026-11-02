import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { createFileObserver, type FileObserverSubscription } from "../file-observer/index.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import type { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import type { WorkspaceProvisioningService } from "../session/workspace-provisioning/workspace-provisioning-service.js";
import { importProviderSession, listImportableProviderSessions } from "./import-sessions.js";

/** Discover phone-created threads from durable writes, without a polling timer. */
export function createSharedCodexImports(options: {
  snapshots: ProviderSnapshotManager;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  workspaceProvisioning: WorkspaceProvisioningService;
  onWorkspace: (workspaceId: string) => Promise<void>;
  logger: Logger;
}) {
  let closed = false;
  let signature = "";
  let timer: NodeJS.Timeout | undefined;
  let running = Promise.resolve();
  let watchers: FSWatcher[] = [];
  const observer = createFileObserver();
  let subscriptions: FileObserverSubscription[] = [];

  const scan = async () => {
    const homes = options.snapshots.sharedCodexHomes();
    if (closed || homes.length === 0) return;
    const listing = await listImportableProviderSessions({
      agentManager: options.agentManager,
      agentStorage: options.agentStorage,
      providerSnapshotManager: options.snapshots,
      request: {
        type: "fetch_recent_provider_sessions_request",
        requestId: "codex-discovery",
        providers: homes.map((entry) => entry.provider),
        limit: 500,
      },
    });
    for (const session of listing.entries) {
      if (closed) return;
      if (
        (
          await options.agentStorage.listByProviderSession(
            session.providerId,
            session.providerHandleId,
          )
        ).length
      )
        continue;
      try {
        const result = await importProviderSession({
          ...options,
          request: {
            provider: session.providerId,
            providerHandleId: session.providerHandleId,
            cwd: session.cwd,
            requestId: "codex-shared-discovery",
          },
        });
        if (result.createdWorkspace) await options.onWorkspace(result.createdWorkspace.workspaceId);
      } catch (err) {
        // The first history write can precede a resumable rollout. A subsequent
        // history/index write retries it; an already imported thread is skipped.
        options.logger.debug(
          { err, threadId: session.providerHandleId },
          "Shared Codex thread not yet importable",
        );
      }
    }
  };
  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      running = running
        .then(scan)
        .catch((err) => options.logger.warn({ err }, "Shared Codex discovery failed"));
    }, 500);
    timer.unref();
  };
  const configure = async () => {
    const homes = options.snapshots.sharedCodexHomes();
    const next = JSON.stringify(homes);
    if (closed || next === signature) return;
    for (const subscription of subscriptions) await subscription.unsubscribe();
    subscriptions = [];
    for (const watcher of watchers) watcher.close();
    watchers = [];
    for (const { home } of homes) {
      const sessions = path.join(home, "sessions");
      await mkdir(sessions, { recursive: true });
      if (closed) return;
      const history = await observer.subscribe(sessions, (err, events) => {
        if (err) options.logger.warn({ err, home }, "Shared Codex history watcher failed");
        if (events.some((event) => event.path.endsWith(".jsonl"))) schedule();
      });
      subscriptions.push(history);
      if (closed) return;
      const index = watch(home, (_event, file) => {
        if (file === "session_index.jsonl") schedule();
      });
      for (const watcher of [index]) {
        watcher.on("error", (err) =>
          options.logger.warn({ err, home }, "Shared Codex history watcher failed"),
        );
        watchers.push(watcher);
      }
    }
    signature = next;
    schedule();
  };
  const changed = () => {
    running = running
      .then(configure)
      .catch((err) => options.logger.warn({ err }, "Shared Codex watcher setup failed"));
  };
  return {
    start() {
      options.snapshots.on("change", changed);
      changed();
    },
    async close() {
      closed = true;
      options.snapshots.off("change", changed);
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      await running;
      for (const watcher of watchers) watcher.close();
      await observer.close();
    },
  };
}
