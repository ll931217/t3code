import {
  type AgentProfileId,
  type AgentProfileSnapshot,
  type AgentProfileScope,
  type CommandId,
  type EnvironmentId,
  OrchestratorMcpFailure,
  type ProjectId,
  type ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Authority from "./AgentDelegationAuthority.ts";
import * as GrantStore from "./AgentDelegationAuthorityStore.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as AgentProfiles from "./AgentProfiles.ts";
import * as AgentDelegationStore from "./AgentDelegationStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import { modelSelectionsEqual } from "@t3tools/shared/model";

export class AgentProfileDelegation extends Context.Service<
  AgentProfileDelegation,
  {
    readonly assertCommand: (
      command: Extract<
        OrchestrationV2Command,
        { readonly type: "thread.create" | "delegated_task.request" }
      >,
      destinationProjectId?: ProjectId,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly assertRemoteAllowed: (
      parentThreadId: ThreadId,
      requestedProfileId?: AgentProfileId,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly prepare: (input: {
      readonly parentThreadId: ThreadId;
      readonly childThreadId: ThreadId;
      readonly environmentId: EnvironmentId;
      readonly targetProjectId: ProjectId;
      readonly destinationScope?: AgentProfileScope;
      readonly profileId?: AgentProfileId;
      readonly writablePaths?: readonly string[];
      readonly commandId: CommandId;
      readonly requestKey: string;
      readonly deferAdmission?: boolean;
      readonly expectedSnapshotId?: string;
    }) => Effect.Effect<AgentProfileSnapshot | null, OrchestratorMcpFailure>;
  }
>()("t3/agents/AgentProfileDelegation") {}

const isFailure = Schema.is(OrchestratorMcpFailure);
const make = Effect.gen(function* () {
  const profiles = yield* AgentProfiles.AgentProfiles;
  const authority = yield* Effect.serviceOption(Authority.AgentDelegationAuthority);
  const grants = yield* GrantStore.AgentDelegationAuthorityStore;
  const sql = yield* SqlClient.SqlClient;
  const digest = yield* Digest.Digest;
  const admissions = yield* AgentDelegationStore.AgentDelegationStore;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const assertCommand = Effect.fn("AgentProfileDelegation.assertCommand")(
    function* (
      command: Extract<
        OrchestrationV2Command,
        { readonly type: "thread.create" | "delegated_task.request" }
      >,
      destinationProjectId?: ProjectId,
    ) {
      const threadId =
        command.type === "thread.create"
          ? command.threadId
          : derive.delegatedTaskThread({ commandId: command.commandId });
      const child = yield* profiles.getThreadSnapshot(threadId);
      const reservation = yield* admissions.get({ environmentId, threadId });
      if (command.type === "thread.create") {
        const inbound =
          reservation !== null ? yield* grants.inbound({ environmentId, threadId }) : null;
        if (
          reservation !== null &&
          (inbound === null ||
            inbound.grant.reservation.commandId !== command.commandId ||
            inbound.projectId !== command.projectId ||
            inbound.peerSessionId !== command.linkOrigin?.sessionId ||
            reservation.parent.environmentId !== command.delegatedFrom?.environmentId ||
            reservation.parent.threadId !== command.delegatedFrom?.threadId)
        )
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "A reserved delegated thread must be created by its delegation command.",
          });
        if (
          child !== null &&
          (!modelSelectionsEqual(command.modelSelection, child.root.profile.modelSelection) ||
            (child.root.sourceProjectId !== null &&
              command.projectId !== child.root.sourceProjectId))
        )
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "The launch does not match the thread's pinned profile.",
          });
        if (child !== null) yield* profiles.assertSnapshotAllowed(child.id);
        return;
      }
      const parent = yield* profiles.getThreadSnapshot(command.parentThreadId);
      if (parent === null) return;
      yield* profiles.assertSnapshotAllowed(parent.id);
      if (
        reservation === null ||
        child === null ||
        reservation.commandId !== command.commandId ||
        reservation.parent.threadId !== command.parentThreadId ||
        reservation.parent.environmentId !== environmentId ||
        reservation.snapshotId !== child.id ||
        (child.root.sourceProjectId !== null &&
          (command.targetProjectId ?? destinationProjectId) !== undefined &&
          child.root.sourceProjectId !== (command.targetProjectId ?? destinationProjectId)) ||
        !parent.root.profile.delegation.profiles.includes(child.root.profile.id) ||
        !modelSelectionsEqual(command.modelSelection, child.root.profile.modelSelection)
      )
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This delegation has no matching profile reservation.",
        });
      yield* profiles.assertSnapshotAllowed(child.id);
    },
    Effect.mapError((cause) =>
      isFailure(cause)
        ? cause
        : new OrchestratorMcpFailure({ code: "capability_denied", message: cause.message }),
    ),
  );
  return AgentProfileDelegation.of({
    assertCommand,
    assertRemoteAllowed: Effect.fn("AgentProfileDelegation.assertRemoteAllowed")(
      function* (parentThreadId, requestedProfileId) {
        const parent = yield* profiles
          .getThreadSnapshot(parentThreadId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorMcpFailure({ code: "invalid_request", message: cause.message }),
            ),
          );
        if (
          (parent !== null || requestedProfileId !== undefined) &&
          (parent === null ||
            requestedProfileId === undefined ||
            Option.isNone(authority) ||
            !parent.root.profile.delegation.profiles.includes(requestedProfileId))
        )
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "Profile-managed remote delegation requires root-authority admission and destination snapshot acknowledgement.",
          });
      },
    ),
    prepare: Effect.fn("AgentProfileDelegation.prepare")(
      function* (input) {
        const parent = yield* profiles.getThreadSnapshot(input.parentThreadId);
        if (parent === null && input.profileId === undefined && input.writablePaths === undefined)
          return null;
        if (parent === null || input.profileId === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "Profile delegation requires a pinned parent profile and an explicitly allowed child profile.",
          });
        yield* profiles.assertSnapshotAllowed(parent.id);
        if (
          input.destinationScope !== undefined &&
          input.destinationScope.projectId !== input.targetProjectId
        )
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "The destination profile scope does not match the project.",
          });
        if (!parent.root.profile.delegation.profiles.includes(input.profileId))
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "This profile is not in the parent's allowed delegation graph.",
          });
        const pinned = yield* profiles.getThreadSnapshot(input.childThreadId);
        let snapshot =
          pinned ??
          (input.destinationScope === undefined
            ? yield* profiles.deriveSnapshot(parent.id, input.profileId)
            : yield* profiles.resolveSnapshot(input.destinationScope, input.profileId));
        if (pinned === null && input.writablePaths !== undefined)
          snapshot = yield* profiles.narrowSnapshot(snapshot.id, input.writablePaths);
        yield* profiles.assertSnapshotAllowed(snapshot.id);
        if (snapshot.root.profile.id !== input.profileId)
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "The existing thread snapshot uses another profile.",
          });
        if (
          snapshot.root.sourceProjectId !== null &&
          snapshot.root.sourceProjectId !== input.targetProjectId
        )
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message:
              "This pinned repository profile belongs to another project. Review and trust the destination profile before delegation.",
          });
        if (input.expectedSnapshotId !== undefined && snapshot.id !== input.expectedSnapshotId)
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "The reviewed profile changed during launch preparation.",
          });
        if (input.deferAdmission === true) return snapshot;
        const parentRef = { environmentId: input.environmentId, threadId: input.parentThreadId };
        const inherited = yield* admissions.get(parentRef);
        const requestKey = Hex.encode(
          yield* digest.digest(Digest.sha256, new TextEncoder().encode(input.requestKey)),
        );
        if (inherited !== null && inherited.root.environmentId !== input.environmentId) {
          if (Option.isNone(authority))
            return yield* new OrchestratorMcpFailure({
              code: "capability_denied",
              message: "The original delegation authority is unavailable.",
            });
          yield* authority.value.reserve({
            parent: parentRef,
            child: { environmentId: input.environmentId, threadId: input.childThreadId },
            projectId: input.targetProjectId,
            snapshot,
            commandId: input.commandId,
            requestKey,
          });
          yield* profiles.pinThread({ threadId: input.childThreadId, snapshotId: snapshot.id });
          return snapshot;
        }
        const limits = inherited?.limits ?? parent.root.profile.delegation;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* admissions.reserve({
              commandId: input.commandId,
              root: inherited?.root ?? parentRef,
              parent: parentRef,
              child: { environmentId: input.environmentId, threadId: input.childThreadId },
              snapshotId: snapshot.id,
              requestKey,
              limits,
            });
            yield* profiles.pinThread({ threadId: input.childThreadId, snapshotId: snapshot.id });
          }),
        );
        return snapshot;
      },
      Effect.mapError((cause) =>
        isFailure(cause)
          ? cause
          : new OrchestratorMcpFailure({ code: "invalid_request", message: cause.message }),
      ),
    ),
  });
});

export const layer = Layer.effect(AgentProfileDelegation, make);
