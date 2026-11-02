import { useCallback } from "react";
import { z } from "zod";
import { Text, View } from "react-native";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CodexRemoteControlAction } from "@getpaseo/protocol/codex-remote-control";
import { useFetchQuery } from "@/data/query";
import { Button } from "@/components/ui/button";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

function useRemoteControl(serverId: string, provider: string) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "codexRemoteControl");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const queryClient = useQueryClient();
  const queryKey = ["codex-remote-control", serverId, provider];
  const environment = z
    .record(z.string(), z.string())
    .safeParse(config?.providers?.[provider]?.env);
  const providerEnv = environment.success ? environment.data : {};
  const shared = providerEnv.PASEO_CODEX_SHARED_SERVER === "1";
  const status = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey,
    enabled: Boolean(client && connected && supported && shared),
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      if (!client) throw new Error("Host disconnected");
      return client.codexRemoteControl(provider, "status");
    },
  });
  const action = useMutation({
    mutationFn: async (next: CodexRemoteControlAction) => {
      if (!client || !connected || !config) throw new Error("Host disconnected");
      if (!shared) {
        const updated = await patchConfig({
          providers: {
            [provider]: {
              env: {
                ...providerEnv,
                PASEO_CODEX_SHARED_SERVER: "1",
              },
            },
          },
        });
        if (!updated) throw new Error("Host disconnected");
      }
      return client.codexRemoteControl(provider, next);
    },
    onSuccess: (result) => queryClient.setQueryData(queryKey, result),
  });
  return { supported: supported && Boolean(config), connected, shared, status, action };
}

export function CodexRemoteControlCard({
  serverId,
  provider,
}: {
  serverId: string;
  provider: string;
}) {
  const { supported, connected, shared, status, action } = useRemoteControl(serverId, provider);
  const result = status.data;
  const enabled = shared && result?.state.status !== "disabled";
  const error = action.error ?? status.error;
  const handlePrimary = useCallback(
    () => action.mutate(enabled ? "pair" : "enable"),
    [action, enabled],
  );
  const handleRefresh = useCallback(() => action.mutate("status"), [action]);
  const handleDisable = useCallback(() => action.mutate("disable"), [action]);
  if (!supported) return null;
  return (
    <View style={settingsStyles.card}>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Codex phone Remote Control</Text>
          <Text style={settingsStyles.rowHint}>
            Share Paseo’s Codex server with your phone. Requires Codex 0.166 or newer and ChatGPT
            sign-in. Existing open sessions switch servers when reopened.
          </Text>
          <Text style={settingsStyles.rowHint}>
            Status: {shared ? (result?.state.status ?? "loading") : "disabled"}
          </Text>
          {result?.pairing ? (
            <Text selectable style={settingsStyles.rowTitle}>
              Pairing code: {result.pairing.manualPairingCode ?? result.pairing.pairingCode}
            </Text>
          ) : null}
          {error ? <Text style={settingsStyles.rowError}>{error.message}</Text> : null}
          <Button size="sm" disabled={!connected || action.isPending} onPress={handlePrimary}>
            {enabled ? "Pair phone" : "Enable Remote Control"}
          </Button>
          {shared ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!connected || action.isPending}
              onPress={handleRefresh}
            >
              Refresh status
            </Button>
          ) : null}
          {enabled ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={!connected || action.isPending}
              onPress={handleDisable}
            >
              Disable Remote Control
            </Button>
          ) : null}
        </View>
      </View>
    </View>
  );
}
