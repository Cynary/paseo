import { parseArgs, promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import pino from "pino";
import { z } from "zod";
import { connectToDaemon } from "../packages/cli/src/utils/client.js";
import { AgentStorage } from "../packages/server/src/server/agent/agent-storage.js";

const { values } = parseArgs({
  options: {
    home: { type: "string", default: process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo") },
    "codex-home": { type: "string" },
    apply: { type: "boolean", default: false },
  },
});
if (!values["codex-home"])
  throw new Error("Specify --codex-home matching the daemon's Codex provider home.");
const home = path.resolve(values.home);
const codexHome = path.resolve(values["codex-home"]);
const { stdout } = await promisify(execFile)(
  "python3",
  [
    fileURLToPath(new URL("./codex-history-import.py", import.meta.url)),
    "--source",
    codexHome,
    "--inventory",
  ],
  { maxBuffer: 64 * 1024 * 1024 },
);
const inventory = z
  .object({
    threads: z.array(
      z.object({
        id: z.string(),
        cwd: z.string(),
        archived: z.number(),
        source: z.string(),
        first_user_message: z.string(),
        project_id: z.string().nullable(),
      }),
    ),
    projects: z.array(z.object({ id: z.string(), name: z.string(), path: z.string() })),
  })
  .parse(JSON.parse(stdout));
const storage = new AgentStorage(path.join(home, "agents"), pino({ level: "silent" }));
const existing = new Set(
  (await storage.list())
    .filter((r) => r.provider === "codex")
    .flatMap((r) => (r.persistence ? [r.persistence.sessionId, r.persistence.nativeHandle] : [])),
);
const candidates = inventory.threads.filter(
  (t) =>
    !t.archived &&
    !existing.has(t.id) &&
    !t.source.includes("subagent") &&
    !t.first_user_message.startsWith(
      "Generate metadata for a coding agent based on the user prompt.",
    ),
);
if (!values.apply) {
  console.log(JSON.stringify({ dryRun: true, count: candidates.length, candidates }, null, 2));
} else {
  const client = await connectToDaemon({ target: { kind: "instance", home } });
  const failures: Array<{ id: string; error: string }> = [];
  let imported = 0;
  try {
    const { config } = await client.getDaemonConfig();
    const configured =
      config.providers?.codex?.env?.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    if (path.resolve(configured) !== codexHome)
      throw new Error("--codex-home does not match the daemon Codex provider configuration.");
    const existingProjects = await client.listProjects();
    const roots = new Set(existingProjects.projects.map((project) => project.rootPath));
    const neededProjects = new Set(candidates.map((thread) => thread.project_id));
    for (const project of inventory.projects) {
      if (!neededProjects.has(project.id)) continue;
      if (roots.has(project.path)) continue;
      const added = await client.addProject(project.path);
      if (!added.project) {
        failures.push({ id: project.id, error: added.error ?? "Project directory unavailable" });
        continue;
      }
      await client.renameProject(added.project.projectId, project.name);
      roots.add(project.path);
    }
    for (const thread of candidates) {
      try {
        await client.importAgent({
          providerId: "codex",
          providerHandleId: thread.id,
          cwd: thread.cwd,
        });
        imported += 1;
        console.log(JSON.stringify({ imported, id: thread.id }));
      } catch (error) {
        failures.push({ id: thread.id, error: String(error) });
      }
    }
    console.log(JSON.stringify({ imported, failures }, null, 2));
    if (failures.length) process.exitCode = 1;
  } finally {
    await client.close();
  }
}
