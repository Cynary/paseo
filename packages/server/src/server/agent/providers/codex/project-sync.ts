import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
} from "../../../workspace-registry.js";

interface ProjectSyncOptions {
  request: (method: string, params: unknown) => Promise<unknown>;
  paseoHome: string;
  workspaceId: string;
  threadId: string | null;
  title: string | null;
  logger: Logger;
}

const ProjectResponseSchema = z.object({ project: z.object({ id: z.string() }) });

export function codexPaseoHome(environment: Record<string, string>): string {
  return environment.PASEO_HOME || path.join(os.homedir(), ".paseo");
}

export async function syncCodexProject(options: ProjectSyncOptions): Promise<string> {
  // Read the authoritative persisted membership, not a cwd heuristic: multiple
  // workspaces can share a directory and worktrees live outside the project root.
  const workspaces = new FileBackedWorkspaceRegistry(
    path.join(options.paseoHome, "projects", "workspaces.json"),
    options.logger,
  );
  const projects = new FileBackedProjectRegistry(
    path.join(options.paseoHome, "projects", "projects.json"),
    options.logger,
  );
  const workspace = await workspaces.get(options.workspaceId);
  if (!workspace)
    throw new Error(`Workspace ${options.workspaceId} is missing during Codex project sync`);
  const project = await projects.get(workspace.projectId);
  if (!project)
    throw new Error(`Project ${workspace.projectId} is missing during Codex project sync`);
  const name = project.customName || project.displayName;
  const roots = [{ path: project.rootPath }];
  const metadata = { "paseo.projectId": project.projectId };
  const response = ProjectResponseSchema.parse(
    await options.request("project/create", {
      name,
      roots,
      metadata,
      idempotencyKey: `paseo:${options.paseoHome}:${project.projectId}`,
    }),
  );
  const projectId = response.project.id;
  await options.request("project/update", { projectId, name, roots, metadata });
  if (!options.threadId) return projectId;
  await options.request("thread/metadata/update", { threadId: options.threadId, projectId });
  if (options.title) {
    await options.request("thread/name/set", { threadId: options.threadId, name: options.title });
  }
  return projectId;
}
