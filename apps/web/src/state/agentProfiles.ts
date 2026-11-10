import { createAgentProfileEnvironmentAtoms } from "@t3tools/client-runtime/state/agent-profiles";
import { connectionAtomRuntime } from "../connection/runtime";

export const agentProfileEnvironment = createAgentProfileEnvironmentAtoms(connectionAtomRuntime);
