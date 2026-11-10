import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as AgentExecutionService from "../../../agents/AgentExecutionService.ts";
import * as AgentExecutionStore from "../../../agents/AgentExecutionStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { AgentExecutionToolkit } from "./tools.ts";

const toFailure = (cause: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: cause.message });
const callerThread = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  return (yield* McpInvocationContext.requireThreadScope(scope, "agent_execution")).thread.threadId;
});

export const layer = McpToolAccess.toLayer(AgentExecutionToolkit, {
  agent_execution_read: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const store = yield* AgentExecutionStore.AgentExecutionStore;
      return yield* store.get(yield* callerThread).pipe(Effect.mapError(toFailure));
    }),
  ),
  agent_execution_update: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* AgentExecutionService.AgentExecutionService;
      return yield* service
        .update({ ...input, threadId: yield* callerThread }, "agent")
        .pipe(Effect.mapError(toFailure));
    }),
  ),
});
