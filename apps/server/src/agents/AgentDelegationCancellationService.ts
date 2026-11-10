import {
  AGENT_DELEGATION_PEER_TOOLS as names,
  AgentDelegationGrant,
  AgentDelegationAcknowledgement,
  type AgentDelegationCancelInput,
  type AgentDelegationRequestCancelInput,
  type CommandId,
  type ScopedThreadRef,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Identity from "../environment/ServerEnvironment.ts";
import * as Peers from "../peer/PeerMcpClient.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import type { McpClientCaller } from "../mcp/McpInvocationContext.ts";
import { forkParked } from "../serverActivation.ts";
import * as Admissions from "./AgentDelegationStore.ts";
import * as Grants from "./AgentDelegationAuthorityStore.ts";
import * as Cancellations from "./AgentDelegationCancellations.ts";
import * as Gate from "./AgentProfileGate.ts";

export class AgentDelegationCancellationService extends Context.Service<
  AgentDelegationCancellationService,
  {
    readonly requestSubtree: (
      root: ScopedThreadRef,
      commandId: CommandId,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly requestFromPeer: (
      input: AgentDelegationRequestCancelInput,
      caller: McpClientCaller,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly cancelFromPeer: (
      input: AgentDelegationCancelInput,
      caller: McpClientCaller,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly reconcile: Effect.Effect<void>;
  }
>()("t3/agents/AgentDelegationCancellationService") {}

const same = (a: ScopedThreadRef, b: ScopedThreadRef) =>
  a.environmentId === b.environmentId && a.threadId === b.threadId;
const key = (ref: ScopedThreadRef) => JSON.stringify([ref.environmentId, ref.threadId]);
const denied = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "The delegation cancellation is not authorized.",
  });
const isFailure = Schema.is(OrchestratorMcpFailure);
const failure = (cause: unknown) =>
  isFailure(cause)
    ? cause
    : new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "Delegation cancellation remains pending until its stop is confirmed.",
      });
const limits = { runtimeMode: "approval-required" as const, interactionMode: "default" as const };

export const layer = Layer.effect(
  AgentDelegationCancellationService,
  Effect.gen(function* () {
    const cancellations = yield* Cancellations.AgentDelegationCancellations;
    const admissions = yield* Admissions.AgentDelegationStore;
    const grants = yield* Grants.AgentDelegationAuthorityStore;
    const peers = yield* Peers.PeerMcpClient;
    const threads = yield* Threads.ThreadManagementService;
    const projections = yield* Projections.ProjectionStoreV2;
    const gate = yield* Gate.AgentProfileGate;
    const sql = yield* SqlClient.SqlClient;
    const here = yield* (yield* Identity.ServerEnvironmentIdentity).getEnvironmentId;

    const requestSubtree = Effect.fn("AgentDelegationCancellationService.requestSubtree")(
      function* (selected: ScopedThreadRef, commandId: CommandId) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const reservation = yield* admissions.get(selected);
            if (selected.environmentId !== here && reservation?.root.environmentId !== here)
              return yield* denied();
            const all = yield* admissions.list(reservation?.root ?? selected);
            const selectedRefs = new Map([[key(selected), selected]]);
            let expanded = true;
            while (expanded) {
              expanded = false;
              for (const row of all) {
                if (selectedRefs.has(key(row.parent)) && !selectedRefs.has(key(row.child))) {
                  selectedRefs.set(key(row.child), row.child);
                  expanded = true;
                }
              }
            }
            for (const child of selectedRefs.values())
              yield* cancellations.request(child, commandId);
          }),
        );
      },
      Effect.mapError(failure),
    );

    const stopLocal = Effect.fn("AgentDelegationCancellationService.stopLocal")(function* (
      child: ScopedThreadRef,
    ) {
      if (child.environmentId !== here) return yield* denied();
      const stop = Effect.gen(function* () {
        const projection = yield* projections
          .getThread(child.threadId)
          .pipe(
            Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
          );
        if (projection !== null) {
          const result = yield* threads.forceStopThread({ threadId: child.threadId });
          if (result.outcome !== "killed" && result.outcome !== "released")
            return yield* failure(undefined);
        }
      });
      yield* gate.withLease(child.threadId, stop).pipe(
        // A busy startup may spawn after this kill, so acknowledgment still needs an exclusive stop.
        Effect.catchTags({
          AgentProfileError: () => stop.pipe(Effect.andThen(Effect.fail(failure(undefined)))),
        }),
      );
    }, Effect.mapError(failure));

    const requestFromPeer = Effect.fn("AgentDelegationCancellationService.requestFromPeer")(
      function* (input: AgentDelegationRequestCancelInput, caller: McpClientCaller) {
        if (!caller.linked || caller.access === "read-only") return yield* denied();
        const grant = yield* grants.byToken(input.token);
        if (grant === null || grant.reservation.root.environmentId !== here) return yield* denied();
        yield* requestSubtree(grant.reservation.child, input.commandId);
      },
      Effect.mapError(failure),
    );

    const cancelFromPeer = Effect.fn("AgentDelegationCancellationService.cancelFromPeer")(
      function* (input: AgentDelegationCancelInput, caller: McpClientCaller) {
        if (
          !caller.linked ||
          caller.access === "read-only" ||
          input.grant.reservation.child.environmentId !== here ||
          input.grant.reservation.root.environmentId === here
        )
          return yield* denied();
        const checked = yield* peers.call({
          environmentId: input.grant.reservation.root.environmentId,
          tool: names.status,
          arguments: { token: input.grant.token, forCancellation: true },
          limits,
          success: AgentDelegationGrant,
        });
        if (
          !checked.cancellationRequested ||
          checked.token !== input.grant.token ||
          !same(checked.reservation.child, input.grant.reservation.child) ||
          checked.reservation.commandId !== input.grant.reservation.commandId ||
          checked.snapshot.id !== input.grant.snapshot.id
        )
          return yield* denied();
        const inbound = yield* grants.inbound(checked.reservation.child);
        if (
          inbound !== null &&
          (inbound.grant.token !== checked.token ||
            !same(inbound.grant.reservation.root, checked.reservation.root) ||
            inbound.grant.reservation.commandId !== checked.reservation.commandId ||
            inbound.grant.snapshot.id !== checked.snapshot.id)
        )
          return yield* denied();
        if (inbound === null) {
          const existing = yield* projections
            .getThread(checked.reservation.child.threadId)
            .pipe(
              Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
            );
          if (existing !== null) return yield* denied();
        }
        const request = yield* cancellations.request(checked.reservation.child, input.commandId);
        yield* stopLocal(request.child);
        yield* admissions.mirror({ ...checked.reservation, status: "cancelled" });
        yield* cancellations.acknowledge(request);
      },
      Effect.mapError(failure),
    );

    const processRequest = Effect.fn("AgentDelegationCancellationService.processRequest")(
      function* (request: Cancellations.AgentDelegationCancellation) {
        const reservation = yield* admissions.get(request.child);
        if (request.child.environmentId === here) {
          yield* stopLocal(request.child);
          if (reservation !== null && reservation.root.environmentId !== here) {
            const inbound = yield* grants.inbound(request.child);
            if (inbound === null) return yield* denied();
            yield* peers.call({
              environmentId: reservation.root.environmentId,
              tool: names.requestCancel,
              arguments: { token: inbound.grant.token, commandId: request.commandId },
              limits,
              success: AgentDelegationAcknowledgement,
            });
            const closed = yield* peers.call({
              environmentId: reservation.root.environmentId,
              tool: names.transition,
              arguments: {
                token: inbound.grant.token,
                status: "cancelled",
                providerSuspended: true,
                forCancellation: true,
              },
              limits,
              success: AgentDelegationGrant,
            });
            if (
              !same(closed.reservation.child, request.child) ||
              closed.reservation.status !== "cancelled"
            )
              return yield* denied();
            yield* admissions.mirror(closed.reservation);
          } else if (reservation !== null) {
            yield* admissions.transition(request.child, "cancelled", true);
          }
        } else {
          if (reservation === null || reservation.root.environmentId !== here)
            return yield* denied();
          const grant = yield* grants.byChild(request.child);
          if (grant === null) return yield* denied();
          yield* peers.call({
            environmentId: request.child.environmentId,
            tool: names.cancel,
            arguments: { grant, commandId: request.commandId },
            limits,
            success: AgentDelegationAcknowledgement,
          });
          yield* admissions.transition(request.child, "cancelled", true);
        }
        yield* cancellations.acknowledge(request);
      },
      Effect.mapError(failure),
    );
    const reconcile = Effect.fn("AgentDelegationCancellationService.reconcile")(function* () {
      yield* Effect.forEach(
        yield* cancellations.pending(),
        (request) =>
          processRequest(request).pipe(
            Effect.timeout("10 seconds"),
            Effect.catchCause(() =>
              Effect.logWarning("Delegation cancellation will retry", { child: request.child }),
            ),
          ),
        { concurrency: 4, discard: true },
      );
    });
    return AgentDelegationCancellationService.of({
      requestSubtree,
      requestFromPeer,
      cancelFromPeer,
      reconcile: reconcile().pipe(
        Effect.catchCause(() => Effect.logWarning("Delegation cancellation scan will retry")),
      ),
    });
  }),
);

export const layerWorker = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* AgentDelegationCancellationService;
    yield* forkParked(service.reconcile.pipe(Effect.repeat(Schedule.spaced("5 seconds"))));
  }),
);
