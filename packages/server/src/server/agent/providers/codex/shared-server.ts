import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnProcess } from "../../../../utils/spawn.js";

export interface SharedCodexServerOptions {
  command: string;
  args: string[];
  environment: Record<string, string>;
  goalsEnabled: boolean;
}

const starting = new Map<string, Promise<void>>();

export function sharedCodexEnabled(environment: Record<string, string>): boolean {
  return environment.PASEO_CODEX_SHARED_SERVER === "1";
}

export function sharedCodexSocket(options: SharedCodexServerOptions): string {
  const home = options.environment.PASEO_HOME || path.join(os.homedir(), ".paseo");
  const codexHome = options.environment.CODEX_HOME || path.join(os.homedir(), ".codex");
  const identity = JSON.stringify([options.command, options.args, codexHome]);
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  const socket = path.join(home, "runtime", "codex", key, "server.sock");
  if (Buffer.byteLength(socket) > 100) {
    throw new Error("PASEO_HOME is too long for the shared Codex Unix socket (maximum 100 bytes).");
  }
  return socket;
}

async function isListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const finish = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

async function startServer(options: SharedCodexServerOptions, socketPath: string): Promise<void> {
  if (await isListening(socketPath)) return;
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const log = await open(path.join(path.dirname(socketPath), "server.log"), "a", 0o600);
  const args = [...options.args, "app-server", "--listen", `unix://${socketPath}`];
  if (options.goalsEnabled) args.push("--enable", "goals");
  // The server is host-scoped. Agent-specific shell variables are supplied in
  // each thread's shell_environment_policy, never inherited from the first agent.
  const environment = { ...options.environment };
  delete environment.PASEO_AGENT_ID;
  delete environment.PASEO_AGENT_CWD;
  const child = spawnProcess(options.command, args, {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    baseEnv: environment,
  });
  let spawnError: Error | null = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.unref();
  await log.close();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await isListening(socketPath)) {
      await writeFile(path.join(path.dirname(socketPath), "server.pid"), String(child.pid), {
        mode: 0o600,
      });
      return;
    }
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Shared Codex server exited. See ${path.dirname(socketPath)}/server.log`);
    }
    await delay(50);
  }
  child.kill("SIGTERM");
  throw new Error(`Shared Codex server did not listen within 15 seconds: ${socketPath}`);
}

/** Each session owns only its proxy; closing it never terminates the host server. */
export async function connectSharedCodexServer(
  options: SharedCodexServerOptions,
): Promise<ChildProcessWithoutNullStreams> {
  if (process.platform === "win32") {
    throw new Error("Shared Codex Remote Control currently requires Linux or macOS.");
  }
  const socketPath = sharedCodexSocket(options);
  let ready = starting.get(socketPath);
  if (!ready) {
    ready = startServer(options, socketPath).finally(() => starting.delete(socketPath));
    starting.set(socketPath, ready);
  }
  await ready;
  const child = spawnProcess(
    process.execPath,
    [fileURLToPath(new URL("./shared-server-proxy.mjs", import.meta.url)), socketPath],
    {
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      envMode: "internal",
      baseEnv: { ...options.environment, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Codex proxy did not provide stdio pipes");
  }
  const stdio: ChildProcessWithoutNullStreams["stdio"] = [
    child.stdin,
    child.stdout,
    child.stderr,
    child.stdio[3],
    child.stdio[4],
  ];
  return Object.assign(child, {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    stdio,
  });
}
