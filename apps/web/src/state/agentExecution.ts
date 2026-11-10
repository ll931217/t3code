import { createAgentExecutionEnvironmentAtoms } from "@t3tools/client-runtime/state/agent-execution";
import { connectionAtomRuntime } from "../connection/runtime";

export const agentExecutionEnvironment =
  createAgentExecutionEnvironmentAtoms(connectionAtomRuntime);
