import {
  AgentExecutionRecord,
  AgentExecutionUpdateInput,
  AgentExecutionUpdateResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as AgentExecutionService from "../../../agents/AgentExecutionService.ts";
import * as AgentExecutionStore from "../../../agents/AgentExecutionStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  AgentExecutionService.AgentExecutionService,
  AgentExecutionStore.AgentExecutionStore,
];

const Read = Tool.make("agent_execution_read", {
  description:
    "Read your thread's objective, tasks, verification evidence, and revision. Null means no plan yet; start at expectedRevision 0.",
  parameters: Tool.EmptyParams,
  success: Schema.NullOr(AgentExecutionRecord),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

const Update = Tool.make("agent_execution_update", {
  description:
    "Replace your thread's objective and checklists at expectedRevision. Keep stable item IDs and include existing items you want retained. Use a new commandId per edit, the same ID on retry. Passed checks need evidence; your reports remain agent-reported. Never mark a parent check passed merely because a worker returned.",
  parameters: Schema.Struct({
    commandId: AgentExecutionUpdateInput.fields.commandId,
    expectedRevision: AgentExecutionUpdateInput.fields.expectedRevision,
    objective: AgentExecutionUpdateInput.fields.objective,
    tasks: AgentExecutionUpdateInput.fields.tasks,
    verifications: AgentExecutionUpdateInput.fields.verifications,
  }),
  success: AgentExecutionUpdateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const AgentExecutionToolkit = Toolkit.make(Read, Update);
