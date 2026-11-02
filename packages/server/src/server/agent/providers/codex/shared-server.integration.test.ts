import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { CodexAppServerClient } from "./app-server-transport.js";
import { connectSharedCodexServer, sharedCodexSocket } from "./shared-server.js";

test.skipIf(!process.env.PASEO_TEST_CODEX_BINARY)(
  "two real clients share a thread and project; disconnect preserves server",
  async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "paseo-codex-"));
    const codexHome = path.join(home, "codex");
    await mkdir(codexHome);
    await writeFile(path.join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');
    const options = {
      command: process.env.PASEO_TEST_CODEX_BINARY ?? "codex",
      args: [],
      goalsEnabled: false,
      environment: {
        PATH: process.env.PATH ?? "",
        HOME: os.homedir(),
        CODEX_HOME: codexHome,
        PASEO_HOME: home,
      },
    };
    const clients: CodexAppServerClient[] = [];
    const connect = async () => {
      const client = new CodexAppServerClient(
        await connectSharedCodexServer(options),
        createTestLogger(),
      );
      clients.push(client);
      await client.request(
        "initialize",
        {
          clientInfo: { name: "paseo_integration", version: "1" },
          capabilities: { experimentalApi: true },
        },
        10000,
      );
      client.notify("initialized", {});
      return client;
    };
    try {
      const [first, second] = await Promise.all([connect(), connect()]);
      const thread = z
        .object({ thread: z.object({ id: z.string() }) })
        .parse(
          await first.request("thread/start", { cwd: home, historyMode: "paginated" }, 10000),
        ).thread;
      const completed = new Promise<void>((resolve) =>
        first.setNotificationHandler((method) => {
          if (method === "turn/completed") resolve();
        }),
      );
      await first.request(
        "turn/start",
        {
          threadId: thread.id,
          input: [{ type: "text", text: "integration test", text_elements: [] }],
        },
        10000,
      );
      await completed;
      const resumed = await second.request(
        "thread/resume",
        { threadId: thread.id, excludeTurns: true },
        10000,
      );
      expect(resumed).toMatchObject({ thread: { id: thread.id } });
      const projectParams = {
        name: "Paseo integration",
        roots: [{ path: home }],
        idempotencyKey: "paseo-integration",
      };
      const project = z
        .object({ project: z.object({ id: z.string() }) })
        .parse(await first.request("project/create", projectParams, 10000)).project;
      expect(await second.request("project/create", projectParams, 10000)).toMatchObject({
        project: { id: project.id },
      });
      await first.request(
        "thread/metadata/update",
        { threadId: thread.id, projectId: project.id },
        10000,
      );
      expect(await second.request("thread/read", { threadId: thread.id }, 10000)).toMatchObject({
        thread: { projectId: project.id },
      });
      expect(await first.request("remoteControl/status/read", {}, 10000)).toMatchObject({
        status: "disabled",
      });
      const startedElsewhere = new Promise<void>((resolve) =>
        first.setNotificationHandler((method) => {
          if (method === "turn/started") resolve();
        }),
      );
      await second.request(
        "turn/start",
        {
          threadId: thread.id,
          input: [{ type: "text", text: "second client", text_elements: [] }],
        },
        10000,
      );
      await startedElsewhere;
      expect(
        await first.request("thread/resume", { threadId: thread.id, excludeTurns: true }, 10000),
      ).toMatchObject({ thread: { id: thread.id } });
      await first.dispose();
      expect(await second.request("thread/loaded/list", {}, 10000)).toMatchObject({
        data: expect.arrayContaining([thread.id]),
      });
      const third = await connect();
      expect(await third.request("thread/loaded/list", {}, 10000)).toMatchObject({
        data: expect.arrayContaining([thread.id]),
      });
    } finally {
      await Promise.all(clients.map((client) => client.dispose()));
      const pidPath = path.join(path.dirname(sharedCodexSocket(options)), "server.pid");
      const pid = Number(await readFile(pidPath, "utf8").catch(() => "0"));
      if (pid > 0) process.kill(pid, "SIGTERM");
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  60000,
);
