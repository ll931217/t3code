import { MessageId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Authority from "../../../agents/AgentDelegationAuthority.ts";
import * as GrantStore from "../../../agents/AgentDelegationAuthorityStore.ts";
import * as PeerLaunch from "../../../agents/AgentDelegationPeerLaunch.ts";
import * as Cancellations from "../../../agents/AgentDelegationCancellationService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { AgentDelegationToolkit } from "./tools.ts";
const peer = Effect.gen(function* () {
  const scope = yield* Invocation.McpInvocationContext;
  if (scope.thread !== undefined || scope.client?.linked !== true)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This protocol is restricted to authenticated environment links.",
    });
  return scope.client;
});
export const layer = Access.toLayer(AgentDelegationToolkit, {
  agent_delegation_review: Access.reads((input) =>
    Effect.gen(function* () {
      yield* peer;
      return yield* (yield* Authority.AgentDelegationAuthority).review(input);
    }),
  ),
  agent_delegation_reserve: Access.writes(
    (input) =>
      Effect.gen(function* () {
        yield* peer;
        return yield* (yield* Authority.AgentDelegationAuthority).reserveFromPeer(input);
      }),
    { linkedCallers: "allowed" },
  ),
  agent_delegation_status: Access.reads((input) =>
    Effect.gen(function* () {
      yield* peer;
      return yield* (yield* Authority.AgentDelegationAuthority).status(
        input.token,
        input.forCancellation ?? false,
      );
    }),
  ),
  agent_delegation_transition: Access.writes(
    (input) =>
      Effect.gen(function* () {
        yield* peer;
        return yield* (yield* Authority.AgentDelegationAuthority).transition(input);
      }),
    { linkedCallers: "allowed" },
  ),
  agent_delegation_launch: Access.writes(
    (input) =>
      Effect.gen(function* () {
        const caller = yield* peer;
        const launched = yield* (yield* PeerLaunch.AgentDelegationPeerLaunch).launch(input, caller);
        const run = launched.projection.runs.find(
          (item) => item.userMessageId === MessageId.make(`${input.commandId}:message`),
        );
        return {
          threadId: launched.threadId,
          projectId: input.projectId,
          modelSelection: launched.projection.thread.modelSelection,
          runId: run?.id ?? null,
          status: run?.status ?? null,
        };
      }),
    { linkedCallers: "allowed" },
  ),
  agent_delegation_admit: Access.writes(
    (input) =>
      Effect.gen(function* () {
        yield* peer;
        const grants = yield* GrantStore.AgentDelegationAuthorityStore;
        const inbound = yield* grants.inbound(input.child).pipe(
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "Delegation state unavailable.",
              }),
          ),
        );
        if (inbound === null || inbound.grant.token !== input.token)
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "The delegation grant is not recognized.",
          });
        yield* (yield* Authority.AgentDelegationAuthority).refresh(input.child);
        return { acknowledged: true as const };
      }),
    { linkedCallers: "allowed" },
  ),
  agent_delegation_request_cancel: Access.writes(
    (input) =>
      Effect.gen(function* () {
        const caller = yield* peer;
        yield* (yield* Cancellations.AgentDelegationCancellationService).requestFromPeer(
          input,
          caller,
        );
        return { acknowledged: true as const };
      }),
    { linkedCallers: "allowed" },
  ),
  agent_delegation_cancel: Access.writes(
    (input) =>
      Effect.gen(function* () {
        const caller = yield* peer;
        yield* (yield* Cancellations.AgentDelegationCancellationService).cancelFromPeer(
          input,
          caller,
        );
        return { acknowledged: true as const };
      }),
    { linkedCallers: "allowed" },
  ),
});
