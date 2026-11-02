import pino from "pino";
import { CodexRemoteControlActionSchema } from "../packages/protocol/src/codex-remote-control.js";
import { CodexAppServerAgentClient } from "../packages/server/src/server/agent/providers/codex-app-server-agent.js";

const action = CodexRemoteControlActionSchema.parse(process.argv[2] ?? "status");
const client = new CodexAppServerAgentClient(pino({ level: "silent" }), {
  env: { PASEO_CODEX_SHARED_SERVER: "1" },
});
const result = await client.remoteControl(action);
console.log(JSON.stringify(result, null, 2));
