import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { usePaneContext } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import { providerSubagentKey, useProviderSubagentStore } from "@/subagents/provider-store";

export function ProviderSubagentConversation({ fallback }: { fallback: ReactNode }) {
  const { serverId, target } = usePaneContext();
  invariant(target.kind === "provider_subagent", "ProviderSubagentPanel requires provider target");
  const descriptorProvider = useProviderSubagentStore(
    (state) =>
      state.descriptors.get(providerSubagentKey(serverId, target.parentAgentId, target.subagentId))
        ?.provider,
  );
  const parentProvider = useSessionStore(
    (state) =>
      (
        state.sessions[serverId]?.agents.get(target.parentAgentId) ??
        state.sessions[serverId]?.agentDetails.get(target.parentAgentId)
      )?.provider,
  );
  return (descriptorProvider ?? parentProvider) === "codex" ? (
    <CodexSubagentConversation />
  ) : (
    fallback
  );
}

/** Open the same native Codex thread through the ordinary agent panel and controls. */
function CodexSubagentConversation() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target, retargetCurrentTab } = usePaneContext();
  invariant(target.kind === "provider_subagent", "Expected a provider subagent target");
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.codexSubagentImport === true,
  );
  const retargetRef = useRef(retargetCurrentTab);
  retargetRef.current = retargetCurrentTab;
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    if (!client || !supported) return;
    let cancelled = false;
    setError(null);
    void client
      .importAgent({
        provider: "codex",
        sessionId: target.subagentId,
        workspaceId,
        // The server verifies native parentage before creating the normal child record.
        parentAgentId: target.parentAgentId,
      })
      .then((agent) => {
        if (!cancelled) retargetRef.current({ kind: "agent", agentId: agent.id });
        return undefined;
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [client, target.parentAgentId, target.subagentId, workspaceId, supported, attempt]);
  if (!supported)
    return (
      <View style={styles.unsupported}>
        <Text style={styles.unsupportedText}>{t("codexSubagent.hostUpdateRequired")}</Text>
      </View>
    );
  if (error)
    return (
      <View style={styles.unsupported}>
        <Text style={styles.unsupportedText}>{error}</Text>
        <Button variant="secondary" onPress={retry}>
          {t("common.retry")}
        </Button>
      </View>
    );
  return (
    <View style={styles.unsupported}>
      <ActivityIndicator />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  unsupported: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  unsupportedText: { color: theme.colors.foregroundMuted, textAlign: "center" },
}));
