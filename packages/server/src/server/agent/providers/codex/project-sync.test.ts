import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { syncCodexProject } from "./project-sync.js";

test("keeps worktree threads under their named parent project and preserves new-thread creation", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "paseo-project-sync-"));
  try {
    await mkdir(path.join(home, "projects"));
    const timestamps = {
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-01T00:00:00Z",
      archivedAt: null,
    };
    await writeFile(
      path.join(home, "projects/projects.json"),
      JSON.stringify([
        {
          ...timestamps,
          projectId: "paseo-project",
          rootPath: "/repo",
          kind: "git",
          displayName: "repo",
          customName: "My project",
        },
      ]),
    );
    await writeFile(
      path.join(home, "projects/workspaces.json"),
      JSON.stringify([
        {
          ...timestamps,
          workspaceId: "workspace",
          projectId: "paseo-project",
          cwd: "/worktrees/feature",
          kind: "worktree",
          displayName: "feature",
        },
      ]),
    );
    const requests: Array<{ method: string; params: unknown }> = [];
    const options = {
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        return method === "project/create" ? { project: { id: "codex-project" } } : {};
      },
      paseoHome: home,
      workspaceId: "workspace",
      title: "Feature conversation",
      logger: createTestLogger(),
    };
    expect(await syncCodexProject({ ...options, threadId: null })).toBe("codex-project");
    expect(requests.map((request) => request.method)).toEqual(["project/create", "project/update"]);
    expect(requests[0].params).toMatchObject({ name: "My project", roots: [{ path: "/repo" }] });
    const firstCreate = requests[0];
    requests.length = 0;
    await syncCodexProject({ ...options, threadId: "thread" });
    expect(requests[0]).toEqual(firstCreate);
    expect(requests.slice(2)).toEqual([
      {
        method: "thread/metadata/update",
        params: { threadId: "thread", projectId: "codex-project" },
      },
      { method: "thread/name/set", params: { threadId: "thread", name: "Feature conversation" } },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
