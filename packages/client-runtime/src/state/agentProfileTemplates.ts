import type { AgentProfile, ModelSelection } from "@t3tools/contracts";

const prompts = {
  orchestrator:
    "Coordinate the objective. Delegate repository changes to allowed worker profiles. Keep objective, tasks, and verification evidence current. Report unresolved work honestly.",
  worker:
    "Implement your assigned task within the granted paths and tools. Verify changes and record evidence. Report results to your parent.",
  reviewer:
    "Review the assigned changes for correctness and regressions. Record findings and verification evidence without changing repository files.",
  researcher:
    "Investigate the assigned question using the available sources. Record findings, supporting evidence, and uncertainties without changing repository files.",
};

export function createAgentProfileTemplate(
  role: keyof typeof prompts,
  modelSelection: ModelSelection,
): AgentProfile {
  return {
    id: `personal/${role}`,
    name: role[0]!.toUpperCase() + role.slice(1),
    description: "",
    prompt: prompts[role],
    modelSelection,
    permissions: {
      filesystem: role === "worker" ? "workspace-write" : "read-only",
      commands: role === "worker",
      network: false,
      writablePaths: [],
      nativeTools: "capability-defaults",
      mcpTools: [
        "agent_execution_read",
        "agent_execution_update",
        ...(role === "orchestrator"
          ? ["orchestrator_capabilities", "delegate_task", "task_status", "task_cancel"]
          : []),
      ],
      approvalPolicy: "never",
      integrations: { commit: false, merge: false, publish: false },
    },
    delegation: {
      profiles: role === "orchestrator" ? ["personal/worker"] : [],
      maxConcurrent: 4,
      maxAgents: 16,
      maxDepth: 3,
    },
    isolation: "worktree",
  };
}
