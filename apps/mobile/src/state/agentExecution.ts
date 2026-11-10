import { createAgentExecutionEnvironmentAtoms } from "@t3tools/client-runtime/state/agent-execution";
import { createAgentProfileEnvironmentAtoms } from "@t3tools/client-runtime/state/agent-profiles";
import { createAgentWorkspaceAtoms } from "@t3tools/client-runtime/state/agent-workspace";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentThreadDetails } from "./threads";

export const agentExecutionEnvironment =
  createAgentExecutionEnvironmentAtoms(connectionAtomRuntime);
export const agentProfileEnvironment = createAgentProfileEnvironmentAtoms(connectionAtomRuntime);
export const agentWorkspace = createAgentWorkspaceAtoms({
  detail: environmentThreadDetails.quietThreadAtom,
  snapshots: agentExecutionEnvironment.snapshots,
  writable: agentExecutionEnvironment.update.permissionAtom,
  stoppable: agentExecutionEnvironment.stop.permissionAtom,
});
