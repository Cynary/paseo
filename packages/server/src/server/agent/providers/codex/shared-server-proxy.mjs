// Codex's control socket speaks WebSocket, including through `app-server proxy`.
// Adapt its messages to the provider's existing newline-delimited stdio transport.
import { createInterface } from "node:readline";
import { WebSocket } from "ws";

const socket = new WebSocket(`ws+unix://${process.argv[2]}:/`, {
  maxPayload: 128 * 1024 * 1024,
  handshakeTimeout: 10000,
});
process.stdin.pause();
socket.on("open", () => {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(line);
  });
  lines.on("close", () => socket.close());
  process.stdin.resume();
});
socket.on("message", (data) => {
  if (!process.stdout.write(`${data.toString()}\n`)) socket.pause();
});
process.stdout.on("drain", () => socket.resume());
socket.on("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
  socket.terminate();
});
socket.on("close", () => process.exit(process.exitCode ?? 0));
