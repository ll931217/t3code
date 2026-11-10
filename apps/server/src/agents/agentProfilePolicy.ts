import { AgentProfileError, type AgentProfile, type ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const readTools = ["Read", "Glob", "Grep"];
const writeTools = ["Write", "Edit", "NotebookEdit"];
const networkTools = ["WebFetch", "WebSearch"];
const profileMcpTools = new Set([
  "agent_worktree_action",
  "agent_execution_read",
  "agent_execution_update",
  "delegate_task",
  "task_status",
  "task_cancel",
  "orchestrator_capabilities",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_wait",
  "t3_thread_search",
  "t3_thread_update",
  "t3_project_list",
  "t3_project_read",
  "t3_environment_read",
  "t3_environment_links",
  "t3_worktree_list",
  "t3_worktree_status",
  "list_thread_pull_requests",
  "read_pull_request_guide",
]);

export function claudeAgentProfileTools(profile: AgentProfile): ReadonlyArray<string> {
  if (profile.permissions.nativeTools !== "capability-defaults")
    return profile.permissions.nativeTools;
  return [
    ...readTools,
    ...(profile.permissions.filesystem === "workspace-write" ? writeTools : []),
    ...(profile.permissions.commands ? ["Bash"] : []),
    ...(profile.permissions.network ? networkTools : []),
  ];
}

export const assertAgentProfileCompatible = Effect.fn("AgentProfilePolicy.assertCompatible")(
  function* (profile: AgentProfile, driverKind: ProviderDriverKind) {
    const permissions = profile.permissions;
    const supportedTools = [
      ...readTools,
      ...(permissions.filesystem === "workspace-write" ? writeTools : []),
      ...(permissions.commands ? ["Bash"] : []),
      ...(permissions.network ? networkTools : []),
    ];
    const supported =
      (driverKind === "codex" || driverKind === "claudeAgent") &&
      (driverKind !== "codex" ||
        (permissions.nativeTools === "capability-defaults" &&
          permissions.approvalPolicy === "never")) &&
      (driverKind !== "claudeAgent" ||
        claudeAgentProfileTools(profile).every((tool) => supportedTools.includes(tool))) &&
      (!permissions.commands || !permissions.network || permissions.integrations.publish) &&
      (permissions.writablePaths.length === 0 ||
        (driverKind === "claudeAgent" && !permissions.commands)) &&
      permissions.mcpTools.every((tool) => profileMcpTools.has(tool));
    if (!supported)
      return yield* new AgentProfileError({ reason: "unsupported", profileId: profile.id });
  },
);
