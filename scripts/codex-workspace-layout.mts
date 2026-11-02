import { parseArgs, promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { z } from "zod";
import { AgentStorage } from "../packages/server/src/server/agent/agent-storage.js";
import { FileBackedWorkspaceRegistry } from "../packages/server/src/server/workspace-registry.js";
import { generateWorkspaceId } from "../packages/server/src/server/workspace-registry-model.js";

const { values } = parseArgs({
  options: {
    home: { type: "string" },
    "source-codex-home": { type: "string" },
    apply: { type: "boolean", default: false },
  },
});
if (!values.home || !values["source-codex-home"])
  throw new Error("Specify --home and --source-codex-home.");
const home = path.resolve(values.home);
if (values.apply) {
  const pidFile = await readFile(path.join(home, "paseo.pid"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  const pid = pidFile ? z.object({ pid: z.number() }).parse(JSON.parse(pidFile)).pid : null;
  if (pid) {
    let running = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") running = false;
      else throw error;
    }
    if (running)
      throw new Error("Stop the selected Paseo daemon before changing workspace membership.");
  }
}
const { stdout } = await promisify(execFile)(
  "python3",
  [
    fileURLToPath(new URL("./codex-history-import.py", import.meta.url)),
    "--source",
    path.resolve(values["source-codex-home"]),
    "--inventory",
  ],
  { maxBuffer: 64 * 1024 * 1024 },
);
const inventory = z
  .object({ threads: z.array(z.object({ id: z.string() })) })
  .parse(JSON.parse(stdout));
const nativeIds = new Set(inventory.threads.map((thread) => thread.id));
const logger = pino({ level: "silent" });
const agents = new AgentStorage(path.join(home, "agents"), logger);
const workspaces = new FileBackedWorkspaceRegistry(
  path.join(home, "projects/workspaces.json"),
  logger,
);
const records = await agents.list();
const selected = records.filter(
  (agent) =>
    agent.provider === "codex" &&
    !agent.archivedAt &&
    agent.persistence &&
    nativeIds.has(agent.persistence.sessionId),
);
const reserved = new Set(
  records
    .filter((agent) => !selected.includes(agent) && !agent.archivedAt)
    .map((agent) => agent.workspaceId),
);
const plan = [];
for (const agent of selected) {
  if (!agent.workspaceId) throw new Error(`Agent ${agent.id} has no workspace`);
  const previous = await workspaces.get(agent.workspaceId);
  if (!previous || previous.archivedAt)
    throw new Error(`Agent ${agent.id} has no active workspace`);
  const workspaceId = reserved.has(previous.workspaceId)
    ? generateWorkspaceId()
    : previous.workspaceId;
  reserved.add(workspaceId);
  const workspace = {
    ...previous,
    workspaceId,
    title: agent.title || previous.title,
    pinnedAt: workspaceId === previous.workspaceId ? previous.pinnedAt : null,
  };
  plan.push({ agent, workspace });
}
if (values.apply) {
  const backup = path.join(home, "layout-backups", String(Date.now()));
  await mkdir(backup, { recursive: true, mode: 0o700 });
  await cp(path.join(home, "agents"), path.join(backup, "agents"), { recursive: true });
  await cp(path.join(home, "projects"), path.join(backup, "projects"), { recursive: true });
  try {
    for (const { agent, workspace } of plan) {
      await workspaces.upsert(workspace);
      await agents.upsert({ ...agent, workspaceId: workspace.workspaceId });
    }
  } catch (error) {
    await cp(path.join(backup, "agents"), path.join(home, "agents"), { recursive: true });
    await cp(path.join(backup, "projects"), path.join(home, "projects"), { recursive: true });
    throw error;
  }
  console.log(
    JSON.stringify({
      conversations: plan.length,
      workspaces: new Set(plan.map((item) => item.workspace.workspaceId)).size,
      backup,
    }),
  );
} else {
  console.log(
    JSON.stringify({
      dryRun: true,
      conversations: plan.length,
      newWorkspaces: plan.filter((item) => item.workspace.workspaceId !== item.agent.workspaceId)
        .length,
    }),
  );
}
