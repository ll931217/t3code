import {
  AGENT_DELEGATION_PEER_TOOLS as names,
  AgentDelegationGrant,
  AgentDelegationReviewInput,
  AgentDelegationReserveInput,
  AgentDelegationTokenInput,
  AgentDelegationStatusInput,
  AgentDelegationLaunchInput,
  AgentDelegationRequestCancelInput,
  AgentDelegationCancelInput,
  AgentProfileSnapshot,
  ScopedThreadRef,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as McpSchema from "effect/ai/McpSchema";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as Authority from "../../../agents/AgentDelegationAuthority.ts";
import * as GrantStore from "../../../agents/AgentDelegationAuthorityStore.ts";
import * as PeerLaunch from "../../../agents/AgentDelegationPeerLaunch.ts";
import * as Cancellations from "../../../agents/AgentDelegationCancellationService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProjectToolkit } from "../project/tools.ts";
const linkedPeer = () => {
  const fiber = Fiber.getCurrent();
  const scope = fiber && Context.getOrUndefined(fiber.context, Invocation.McpInvocationContext);
  return scope?.thread === undefined && scope?.client?.linked === true;
};
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Authority.AgentDelegationAuthority,
    GrantStore.AgentDelegationAuthorityStore,
    PeerLaunch.AgentDelegationPeerLaunch,
    Cancellations.AgentDelegationCancellationService,
    Invocation.McpInvocationContext,
    Threads.ThreadManagementService,
  ],
};
export const AgentDelegationToolkit = Toolkit.make(
  Tool.make(names.requestCancel, {
    ...shared,
    description: "Internal peer protocol: request durable subtree cancellation at its authority.",
    parameters: AgentDelegationRequestCancelInput,
    success: Schema.Void,
  })
    .annotate(Tool.Idempotent, true)
    .annotate(McpSchema.EnabledWhen, linkedPeer),
  Tool.make(names.cancel, {
    ...shared,
    description: "Internal peer protocol: stop a delegation and acknowledge cancellation.",
    parameters: AgentDelegationCancelInput,
    success: Schema.Void,
  })
    .annotate(Tool.Idempotent, true)
    .annotate(McpSchema.EnabledWhen, linkedPeer),
  Tool.make(names.review, {
    ...shared,
    description: "Internal peer protocol: resolve a reviewed destination profile.",
    parameters: AgentDelegationReviewInput,
    success: AgentProfileSnapshot,
  })
    .annotate(Tool.Readonly, true)
    .annotate(McpSchema.EnabledWhen, linkedPeer),
  Tool.make(names.reserve, {
    ...shared,
    description: "Internal peer protocol: reserve capacity at the original tree authority.",
    parameters: AgentDelegationReserveInput,
    success: AgentDelegationGrant,
  })
    .annotate(Tool.Idempotent, true)
    .annotate(McpSchema.EnabledWhen, linkedPeer),
  Tool.make(names.status, {
    ...shared,
    description: "Internal peer protocol: read an authoritative reservation.",
    parameters: AgentDelegationTokenInput,
    success: AgentDelegationGrant,
  })
    .annotate(Tool.Readonly, true)
    .annotate(McpSchema.EnabledWhen, linkedPeer),
  Tool.make(names.transition, {
    ...shared,
    description: "Internal peer protocol: acknowledge suspended work or request capacity.",
    parameters: AgentDelegationStatusInput,
    success: AgentDelegationGrant,
  })
    .annotate(Tool.Idempotent, true)
    .annotate(McpSchema.EnabledWhen, linkedPeer),
  Tool.make(names.launch, {
    ...shared,
    description: "Internal peer protocol: launch a reviewed, admitted delegation.",
    parameters: AgentDelegationLaunchInput,
    success: ProjectToolkit.tools.t3_thread_launch.successSchema,
  })
    .annotate(Tool.Idempotent, true)
    .annotate(McpSchema.EnabledWhen, linkedPeer),
  Tool.make(names.admit, {
    ...shared,
    description: "Internal peer protocol: wake a persisted delegation after admission.",
    parameters: Schema.Struct({
      token: AgentDelegationTokenInput.fields.token,
      child: ScopedThreadRef,
    }),
    success: Schema.Void,
  })
    .annotate(Tool.Idempotent, true)
    .annotate(McpSchema.EnabledWhen, linkedPeer),
);
