import { z } from "zod";

export const CodexRemoteControlActionSchema = z.enum(["status", "enable", "disable", "pair"]);
export const CodexRemoteControlStatusSchema = z.object({
  status: z.enum(["disabled", "connecting", "connected", "errored"]),
  serverName: z.string(),
  installationId: z.string(),
  environmentId: z.string().nullable(),
});
export const CodexRemoteControlPairingSchema = z.object({
  pairingCode: z.string(),
  manualPairingCode: z.string().nullable(),
  environmentId: z.string(),
  expiresAt: z.number(),
});
export const CodexRemoteControlResultSchema = z.object({
  state: CodexRemoteControlStatusSchema,
  pairing: CodexRemoteControlPairingSchema.nullable(),
});
export type CodexRemoteControlAction = z.infer<typeof CodexRemoteControlActionSchema>;
export type CodexRemoteControlResult = z.infer<typeof CodexRemoteControlResultSchema>;
