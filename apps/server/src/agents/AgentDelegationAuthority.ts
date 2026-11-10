import {
  AGENT_DELEGATION_PEER_TOOLS as names,
  AgentDelegationGrant,
  AgentDelegationReserveInput,
  AgentDelegationReviewInput,
  AgentProfileSnapshot,
  type AgentDelegationReservation,
  type AgentDelegationStatusInput,
  type CommandId,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as Providers from "../provider/ProviderInstanceRegistry.ts";
import { assertAgentProfileCompatible } from "./agentProfilePolicy.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as AgentProfiles from "./AgentProfiles.ts";
import * as AgentDelegationStore from "./AgentDelegationStore.ts";
import * as GrantStore from "./AgentDelegationAuthorityStore.ts";
import * as Cancellations from "./AgentDelegationCancellations.ts";

type Reserve = {
  readonly parent: ScopedThreadRef;
  readonly child: ScopedThreadRef;
  readonly projectId: ProjectId;
  readonly snapshot: AgentProfileSnapshot;
  readonly commandId: CommandId;
  readonly requestKey: string;
};
const same = (left: ScopedThreadRef, right: ScopedThreadRef) =>
  left.environmentId === right.environmentId && left.threadId === right.threadId;
const denied = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "The delegation authority or reviewed profile does not authorize this request.",
  });
const isFailure = Schema.is(OrchestratorMcpFailure);
const failure = (cause: unknown) =>
  isFailure(cause)
    ? cause
    : new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "The delegation authority is unavailable or rejected the request.",
      });

export class AgentDelegationAuthority extends Context.Service<
  AgentDelegationAuthority,
  {
    readonly review: (
      input: typeof AgentDelegationReviewInput.Type,
    ) => Effect.Effect<AgentProfileSnapshot, OrchestratorMcpFailure>;
    readonly reviewThere: (
      environmentId: EnvironmentId,
      input: typeof AgentDelegationReviewInput.Type,
    ) => Effect.Effect<AgentProfileSnapshot, OrchestratorMcpFailure>;
    readonly reserve: (
      input: Reserve,
    ) => Effect.Effect<AgentDelegationGrant, OrchestratorMcpFailure>;
    readonly reserveFromPeer: (
      input: typeof AgentDelegationReserveInput.Type,
    ) => Effect.Effect<AgentDelegationGrant, OrchestratorMcpFailure>;
    readonly status: (
      token: string,
      forCancellation?: boolean,
    ) => Effect.Effect<AgentDelegationGrant, OrchestratorMcpFailure>;
    readonly transition: (
      input: typeof AgentDelegationStatusInput.Type,
    ) => Effect.Effect<AgentDelegationGrant, OrchestratorMcpFailure>;
    readonly accept: (
      grant: AgentDelegationGrant,
      peerSessionId: string,
      projectId: ProjectId,
    ) => Effect.Effect<AgentDelegationGrant, OrchestratorMcpFailure>;
    readonly refresh: (
      child: ScopedThreadRef,
      status?: AgentDelegationReservation["status"],
    ) => Effect.Effect<AgentDelegationGrant | null, OrchestratorMcpFailure>;
    readonly notify: Effect.Effect<void, OrchestratorMcpFailure>;
  }
>()("t3/agents/AgentDelegationAuthority") {}

const make = Effect.gen(function* () {
  const store = yield* AgentDelegationStore.AgentDelegationStore;
  const cancellations = yield* Cancellations.AgentDelegationCancellations;
  const grants = yield* GrantStore.AgentDelegationAuthorityStore;
  const profiles = yield* AgentProfiles.AgentProfiles;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const providers = yield* Effect.serviceOption(Providers.ProviderInstanceRegistry);
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const here = yield* identity.getEnvironmentId;
  const limits = { runtimeMode: "approval-required" as const, interactionMode: "default" as const };
  const review = Effect.fn("AgentDelegationAuthority.review")(function* (
    input: typeof AgentDelegationReviewInput.Type,
  ) {
    const project = yield* projects.get(input.projectId);
    if (Option.isNone(project) || project.value.deletedAt !== null) return yield* denied();
    const snapshot =
      input.snapshotId === undefined
        ? yield* profiles.resolveSnapshot(
            { projectId: input.projectId, workspaceRoot: project.value.workspaceRoot },
            input.profileId,
          )
        : yield* profiles.getSnapshot(input.snapshotId);
    if (
      snapshot === null ||
      snapshot.root.profile.id !== input.profileId ||
      (snapshot.root.sourceProjectId !== null && snapshot.root.sourceProjectId !== input.projectId)
    )
      return yield* denied();
    yield* profiles.assertSnapshotAllowed(snapshot.id);
    const reviewed =
      input.writablePaths === undefined
        ? snapshot
        : yield* profiles.narrowSnapshot(snapshot.id, input.writablePaths);
    if (Option.isNone(providers)) return yield* denied();
    const profile = reviewed.root.profile;
    const provider = yield* providers.value.getInstance(profile.modelSelection.instanceId);
    if (provider === undefined || !provider.enabled) return yield* denied();
    yield* assertAgentProfileCompatible(
      {
        ...profile,
        permissions: {
          ...profile.permissions,
          writablePaths: reviewed.writablePaths ?? profile.permissions.writablePaths,
        },
      },
      provider.driverKind,
    );
    return reviewed;
  }, Effect.mapError(failure));
  const reviewThere = Effect.fn("AgentDelegationAuthority.reviewThere")(function* (
    environmentId: EnvironmentId,
    input: typeof AgentDelegationReviewInput.Type,
  ) {
    return yield* environmentId === here
      ? review(input)
      : peers.call({
          environmentId,
          tool: names.review,
          arguments: input,
          limits,
          success: AgentProfileSnapshot,
        });
  });
  const cancelled = () =>
    new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This execution tree was cancelled. Launch a new profiled thread.",
    });
  const assertOpen = Effect.fn("AgentDelegationAuthority.assertOpen")(function* (
    ref: ScopedThreadRef,
  ) {
    if (yield* cancellations.requested(ref)) return yield* cancelled();
  });
  const status = Effect.fn("AgentDelegationAuthority.status")(function* (
    token: string,
    forCancellation = false,
  ) {
    const grant = yield* grants.byToken(token);
    if (grant === null || grant.reservation.root.environmentId !== here) return yield* denied();
    const reservation = yield* store.get(grant.reservation.child);
    if (reservation === null) return yield* denied();
    const cancellationRequested =
      (yield* cancellations.requested(reservation.child)) ||
      (yield* cancellations.requested(reservation.root));
    if (forCancellation) return { ...grant, reservation, cancellationRequested };
    if (cancellationRequested) return yield* cancelled();
    const root = yield* profiles.getThreadSnapshot(reservation.root.threadId);
    if (root === null) return yield* denied();
    yield* profiles.assertSnapshotAllowed(root.id);
    return { ...grant, reservation };
  }, Effect.mapError(failure));
  const issue = Effect.fn("AgentDelegationAuthority.issue")(function* (
    input: Reserve,
    parent: AgentDelegationReservation | null,
    parentSnapshot: AgentProfileSnapshot,
  ) {
    if (!parentSnapshot.root.profile.delegation.profiles.includes(input.snapshot.root.profile.id))
      return yield* denied();
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertOpen(input.parent);
        yield* assertOpen(parent?.root ?? input.parent);
        yield* assertOpen(input.child);
        const reservation = yield* store.reserve({
          commandId: input.commandId,
          root: parent?.root ?? input.parent,
          parent: input.parent,
          child: input.child,
          snapshotId: input.snapshot.id,
          requestKey: input.requestKey,
          limits: parent?.limits ?? parentSnapshot.root.profile.delegation,
        });
        return yield* grants.issue(reservation, input.snapshot);
      }),
    );
  }, Effect.mapError(failure));
  const reserveFromPeer = Effect.fn("AgentDelegationAuthority.reserveFromPeer")(function* (
    input: typeof AgentDelegationReserveInput.Type,
  ) {
    const parent = yield* status(input.parentToken);
    const checked = yield* reviewThere(input.child.environmentId, {
      projectId: input.projectId,
      profileId: input.snapshot.root.profile.id,
      snapshotId: input.snapshot.id,
    });
    if (checked.id !== input.snapshot.id) return yield* denied();
    return yield* issue(
      { ...input, snapshot: checked, parent: parent.reservation.child },
      parent.reservation,
      parent.snapshot,
    );
  });
  const reserve = Effect.fn("AgentDelegationAuthority.reserve")(function* (input: Reserve) {
    if (input.parent.environmentId !== here) return yield* denied();
    yield* assertOpen(input.parent);
    yield* assertOpen(input.child);
    const parent = yield* store.get(input.parent);
    if (parent !== null && parent.root.environmentId !== here) {
      const inbound = yield* grants.inbound(input.parent);
      if (inbound === null) return yield* denied();
      const grant = yield* peers.call({
        environmentId: parent.root.environmentId,
        tool: names.reserve,
        arguments: {
          parentToken: inbound.grant.token,
          commandId: input.commandId,
          child: input.child,
          projectId: input.projectId,
          snapshot: input.snapshot,
          requestKey: input.requestKey,
        },
        limits,
        success: AgentDelegationGrant,
      });
      if (input.child.environmentId === here) {
        yield* grants.accept(grant, inbound.peerSessionId, input.projectId);
        yield* store.mirror(grant.reservation);
      }
      return grant;
    }
    const parentSnapshot = yield* profiles.getThreadSnapshot(input.parent.threadId);
    if (parentSnapshot === null) return yield* denied();
    yield* profiles.assertSnapshotAllowed(parentSnapshot.id);
    return yield* issue(input, parent, parentSnapshot);
  }, Effect.mapError(failure));
  const transition = Effect.fn("AgentDelegationAuthority.transition")(function* (
    input: typeof AgentDelegationStatusInput.Type,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const grant = yield* status(
          input.token,
          input.forCancellation === true && input.status === "cancelled",
        );
        const reservation = yield* store.transition(
          grant.reservation.child,
          input.status,
          input.providerSuspended,
        );
        yield* grants.markNotified(input.token, false);
        return { ...grant, reservation };
      }),
    );
  }, Effect.mapError(failure));
  const accept = Effect.fn("AgentDelegationAuthority.accept")(function* (
    supplied: AgentDelegationGrant,
    peerSessionId: string,
    projectId: ProjectId,
  ) {
    if (
      supplied.reservation.child.environmentId !== here ||
      supplied.reservation.root.environmentId === here
    )
      return yield* denied();
    const grant = yield* peers.call({
      environmentId: supplied.reservation.root.environmentId,
      tool: names.status,
      arguments: { token: supplied.token },
      limits,
      success: AgentDelegationGrant,
    });
    if (
      !same(grant.reservation.child, supplied.reservation.child) ||
      grant.reservation.commandId !== supplied.reservation.commandId ||
      grant.reservation.requestKey !== supplied.reservation.requestKey ||
      grant.snapshot.id !== supplied.snapshot.id
    )
      return yield* denied();
    yield* review({
      projectId,
      profileId: grant.snapshot.root.profile.id,
      snapshotId: grant.snapshot.id,
    });
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* assertOpen(grant.reservation.child);
        yield* grants.accept(grant, peerSessionId, projectId);
        yield* store.mirror(grant.reservation);
        yield* profiles.pinThread({
          threadId: grant.reservation.child.threadId,
          snapshotId: grant.snapshot.id,
        });
      }),
    );
    return grant;
  }, Effect.mapError(failure));
  const refresh = Effect.fn("AgentDelegationAuthority.refresh")(function* (
    child: ScopedThreadRef,
    requested?: AgentDelegationReservation["status"],
  ) {
    const inbound = yield* grants.inbound(child);
    if (inbound === null) return null;
    const grant = yield* peers.call({
      environmentId: inbound.grant.reservation.root.environmentId,
      tool: requested === undefined || requested === "queued" ? names.status : names.transition,
      arguments:
        requested === undefined || requested === "queued"
          ? { token: inbound.grant.token }
          : { token: inbound.grant.token, status: requested, providerSuspended: true },
      limits,
      success: AgentDelegationGrant,
    });
    if (!same(grant.reservation.child, child)) return yield* denied();
    yield* grants.accept(grant, inbound.peerSessionId, inbound.projectId);
    yield* store.mirror(grant.reservation);
    return grant;
  }, Effect.mapError(failure));
  const notify = Effect.fn("AgentDelegationAuthority.notify")(function* () {
    yield* Effect.forEach(
      yield* grants.pendingNotifications(),
      (original) =>
        Effect.gen(function* () {
          const grant = yield* status(original.grant.token);
          if (grant.reservation.status !== "active") return;
          if (grant.reservation.child.environmentId !== here)
            yield* peers.call({
              environmentId: grant.reservation.child.environmentId,
              tool: names.admit,
              arguments: { token: grant.token, child: grant.reservation.child },
              limits,
              success: Schema.Void,
            });
          yield* grants.markNotified(grant.token, true, original.generation);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Remote admission notification will retry", cause),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  }, Effect.mapError(failure));
  return AgentDelegationAuthority.of({
    review,
    reviewThere,
    reserve,
    reserveFromPeer,
    status,
    transition,
    accept,
    refresh,
    notify: notify(),
  });
});

export const layer = Layer.effect(AgentDelegationAuthority, make);
