/** @vitest-environment jsdom */
import React from "react";
import { render, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderSubagentConversation } from "./provider-subagent-conversation";

const fixture = vi.hoisted(() => ({
  provider: "codex",
  supported: true,
  importAgent: vi.fn(),
  retarget: vi.fn(),
}));
vi.mock("@/panels/pane-context", () => ({
  usePaneContext: () => ({
    serverId: "host",
    workspaceId: "workspace",
    tabId: "child-tab",
    target: { kind: "provider_subagent", parentAgentId: "parent", subagentId: "native-child" },
    retargetCurrentTab: fixture.retarget,
  }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: unknown) => unknown) =>
    select({
      sessions: {
        host: {
          client: { importAgent: fixture.importAgent },
          agents: new Map([["parent", { provider: fixture.provider }]]),
          serverInfo: { features: { codexSubagentImport: fixture.supported } },
        },
      },
    }),
}));
vi.mock("@/subagents/provider-store", () => ({
  providerSubagentKey: () => "child",
  useProviderSubagentStore: (select: (state: unknown) => unknown) =>
    select({ descriptors: new Map() }),
}));

beforeEach(() => {
  vi.stubGlobal("React", React);
  fixture.provider = "codex";
  fixture.supported = true;
  fixture.importAgent.mockReset().mockResolvedValue({ id: "managed-child" });
  fixture.retarget.mockReset();
});
afterEach(cleanup);

describe("provider subagent conversation routing", () => {
  it("opens the same Codex thread in the ordinary agent tab with parent identity", async () => {
    render(<ProviderSubagentConversation fallback="Projected child" />);
    await waitFor(() =>
      expect(fixture.retarget).toHaveBeenCalledWith({ kind: "agent", agentId: "managed-child" }),
    );
    expect(fixture.importAgent).toHaveBeenCalledWith({
      provider: "codex",
      sessionId: "native-child",
      workspaceId: "workspace",
      parentAgentId: "parent",
    });
  });
  it("retains the projected pane for other providers", () => {
    fixture.provider = "claude";
    const view = render(<ProviderSubagentConversation fallback="Projected child" />);
    expect(view.getByText("Projected child")).toBeTruthy();
    expect(fixture.importAgent).not.toHaveBeenCalled();
  });
  it("does not silently import without verified parent support on an old daemon", () => {
    fixture.supported = false;
    const view = render(<ProviderSubagentConversation fallback="Projected child" />);
    expect(view.getByText("codexSubagent.hostUpdateRequired")).toBeTruthy();
    expect(fixture.importAgent).not.toHaveBeenCalled();
  });
});
