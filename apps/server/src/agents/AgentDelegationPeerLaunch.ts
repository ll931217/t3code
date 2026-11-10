import {
  type AgentDelegationLaunchInput,
  MessageId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Providers from "../provider/ProviderInstanceRegistry.ts";
import { assertAgentProfileCompatible } from "./agentProfilePolicy.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Layer from "effect/Layer";
import * as Authority from "./AgentDelegationAuthority.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import { clientModeCeiling, type McpClientCaller } from "../mcp/McpInvocationContext.ts";

export class AgentDelegationPeerLaunch extends Context.Service<
  AgentDelegationPeerLaunch,
  {
    readonly launch: (
      input: AgentDelegationLaunchInput,
      caller: McpClientCaller,
    ) => Effect.Effect<ThreadLaunch.ThreadLaunchResult, OrchestratorMcpFailure>;
  }
>()("t3/agents/AgentDelegationPeerLaunch") {}

export const layer = Layer.effect(
  AgentDelegationPeerLaunch,
  Effect.gen(function* () {
    const digest = yield* Digest.Digest;
    const authority = yield* Authority.AgentDelegationAuthority;
    const launcher = yield* ThreadLaunch.ThreadLaunchService;
    const projections = yield* Projections.ProjectionStoreV2;
    const providers = yield* Providers.ProviderInstanceRegistry;
    return AgentDelegationPeerLaunch.of({
      launch: Effect.fn("AgentDelegationPeerLaunch.launch")(function* (input, caller) {
        if (
          caller.linked !== true ||
          caller.access === "read-only" ||
          input.commandId !== input.grant.reservation.commandId
        )
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "An authenticated delegation grant is required.",
          });
        const requestKey = Hex.encode(
          yield* digest
            .digest(
              Digest.sha256,
              new TextEncoder().encode(
                stableStringify({
                  task: input.task,
                  title: input.title,
                  projectId: input.projectId,
                  profileId: input.grant.snapshot.root.profile.id,
                }),
              ),
            )
            .pipe(
              Effect.mapError(
                () =>
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: "Delegation identity unavailable.",
                  }),
              ),
            ),
        );
        if (requestKey !== input.grant.reservation.requestKey)
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "The task does not match its delegation grant.",
          });
        const grant = yield* authority.accept(input.grant, caller.sessionId, input.projectId);
        if (
          input.commandId !== grant.reservation.commandId ||
          requestKey !== grant.reservation.requestKey
        )
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "The task does not match its authoritative delegation grant.",
          });
        if (grant.reservation.status === "cancelled" || grant.reservation.status === "completed") {
          const existing = yield* projections
            .getThreadProjection(grant.reservation.child.threadId)
            .pipe(Effect.option);
          if (Option.isSome(existing))
            return {
              threadId: grant.reservation.child.threadId,
              projection: existing.value,
              resumed: true,
            };
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "This delegation is already closed.",
          });
        }
        const profile = grant.snapshot.root.profile;
        const provider = yield* providers.getInstance(profile.modelSelection.instanceId);
        if (provider === undefined || !provider.enabled)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The profile provider is unavailable.",
          });
        yield* assertAgentProfileCompatible(
          {
            ...profile,
            permissions: {
              ...profile.permissions,
              writablePaths: grant.snapshot.writablePaths ?? profile.permissions.writablePaths,
            },
          },
          provider.driverKind,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: cause.message }),
          ),
        );
        return yield* launcher
          .launch({
            commandId: input.commandId,
            threadId: grant.reservation.child.threadId,
            projectId: input.projectId,
            title: input.title,
            modelSelection: grant.snapshot.root.profile.modelSelection,
            ...clientModeCeiling(caller),
            workspaceStrategy:
              grant.snapshot.root.profile.isolation === "worktree"
                ? { type: "worktree", baseRef: "HEAD" }
                : { type: "root" },
            initialMessage: {
              messageId: MessageId.make(`${input.commandId}:message`),
              text: input.task,
              attachments: [],
            },
            createdBy: "agent",
            creationSource: "mcp",
            linkOrigin: { sessionId: caller.sessionId, label: caller.label, access: caller.access },
            delegatedFrom: { ...grant.reservation.parent, title: input.title },
          })
          .pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("agent-delegation.launch-failed", {
                threadId: grant.reservation.child.threadId,
                operation: cause._tag === "ThreadLaunchError" ? cause.operation : "provider-check",
                detail:
                  cause._tag === "ThreadLaunchError"
                    ? cause.cause instanceof Error
                      ? cause.cause.message
                      : typeof cause.cause === "string"
                        ? cause.cause
                        : "Launch operation failed."
                    : cause.message,
              }),
            ),
            Effect.mapError(
              (cause) =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message:
                    cause._tag === "ThreadLaunchError"
                      ? `The delegated thread could not be launched during ${cause.operation}.`
                      : "The delegated profile provider is disabled for this project.",
                }),
            ),
          );
      }),
    });
  }),
);
