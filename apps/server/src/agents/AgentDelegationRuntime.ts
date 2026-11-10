import { CommandId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Authority from "./AgentDelegationAuthority.ts";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as AgentDelegationStore from "./AgentDelegationStore.ts";
import * as Cancellations from "./AgentDelegationCancellations.ts";

export class AgentDelegationRuntime extends Context.Service<
  AgentDelegationRuntime,
  {
    readonly reconcile: Effect.Effect<
      void,
      AgentDelegationStore.AgentDelegationError | EffectOutbox.EffectOutboxError | SqlError.SqlError
    >;
    readonly run: Effect.Effect<void, AgentDelegationStore.AgentDelegationError>;
  }
>()("t3/agents/AgentDelegationRuntime") {}

const make = Effect.gen(function* () {
  const store = yield* AgentDelegationStore.AgentDelegationStore;
  const cancellations = yield* Cancellations.AgentDelegationCancellations;
  const authority = yield* Effect.serviceOption(Authority.AgentDelegationAuthority);
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const events = yield* EventSink.EventSinkV2;
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const reconcile = Effect.fn("AgentDelegationRuntime.reconcile")(function* () {
    const live = yield* store.live();
    const transition = Effect.fn("AgentDelegationRuntime.transition")(function* (
      reservation: (typeof live)[number],
      status: "active" | "waiting" | "completed" | "cancelled",
    ) {
      if (reservation.root.environmentId === environmentId) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            if (yield* cancellations.requested(reservation.child)) return;
            yield* store.transition(reservation.child, status, true);
          }),
        );
        return;
      }
      if (Option.isSome(authority))
        yield* authority.value
          .refresh(reservation.child, status)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Remote delegation transition pending", cause),
            ),
          );
    });
    for (const reservation of live) {
      if (
        reservation.child.environmentId !== environmentId ||
        (yield* cancellations.requested(reservation.child))
      )
        continue;
      const projection = yield* threads
        .getThreadRecords(reservation.child.threadId, ["runs", "providerTurns"])
        .pipe(Effect.option);
      if (projection._tag === "None") continue;
      const latest = projection.value.runs.toSorted(
        (left, right) => right.ordinal - left.ordinal,
      )[0];
      if (
        latest === undefined ||
        projection.value.providerTurns.some(
          (turn) => turn.status === "running" || turn.status === "pending",
        )
      )
        continue;
      if (
        latest.status === "completed" ||
        latest.status === "failed" ||
        latest.status === "interrupted" ||
        latest.status === "cancelled"
      ) {
        yield* transition(reservation, latest.status === "cancelled" ? "cancelled" : "completed");
      } else if (
        reservation.status === "active" &&
        latest.status === "waiting" &&
        projection.value.providerTurns.length > 0
      ) {
        yield* transition(reservation, "waiting");
      }
    }
    const pending = (yield* store.pendingStarts()).filter(
      (item) => item.child.environmentId === environmentId,
    );
    for (const request of pending) {
      if (yield* cancellations.requested(request.child)) continue;
      const reservation = yield* store.get(request.child);
      if (reservation?.status === "waiting") yield* transition(reservation, "active");
    }
    const roots = new Map(
      live
        .filter((item) => item.root.environmentId === environmentId)
        .map((item) => [`${item.root.environmentId}:${item.root.threadId}`, item.root]),
    );
    for (const root of roots.values()) {
      if (!(yield* cancellations.requested(root))) yield* store.admitQueued(root);
    }
    if (Option.isSome(authority))
      yield* authority.value.notify.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Remote delegation notification pending", cause),
        ),
      );
    for (const request of pending) {
      if (yield* cancellations.requested(request.child)) continue;
      const reservation = yield* store.get(request.child);
      if (
        reservation === null ||
        reservation.status === "completed" ||
        reservation.status === "cancelled"
      ) {
        yield* store.acknowledgeStart(request);
        continue;
      }
      if (reservation.status !== "active") continue;
      const id = `agent-admission:${request.child.environmentId}:${request.runId}:${request.generation}`;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (yield* cancellations.requested(request.child)) return;
          yield* outbox.enqueue([
            {
              id,
              commandId: CommandId.make(id),
              threadId: request.child.threadId,
              request: { type: "provider-turn.start", runId: request.runId },
            },
          ]);
          yield* store.acknowledgeStart(request);
        }),
      );
      yield* outbox.notifyAvailable();
    }
  });
  const run = Effect.scoped(
    Effect.gen(function* () {
      const wake = yield* PubSub.sliding<void>(1);
      const subscription = yield* PubSub.subscribe(wake);
      const changes = yield* store.subscribeChanges;
      const sequence = yield* events.latestSequence();
      yield* Stream.fromSubscription(changes).pipe(
        Stream.merge(
          events.stream({ afterSequence: sequence }).pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "provider-turn.updated" ||
                event.type === "run.updated" ||
                event.type === "run.created",
            ),
            Stream.map(() => undefined),
          ),
        ),
        Stream.runForEach(() => PubSub.publish(wake, undefined)),
        Effect.catchCause((cause) => Effect.logError("Delegation notifications failed", cause)),
        Effect.forkScoped,
      );
      if (Option.isSome(authority))
        yield* Effect.repeat(PubSub.publish(wake, undefined), Schedule.spaced("10 seconds")).pipe(
          Effect.forkScoped,
        );
      yield* PubSub.publish(wake, undefined);
      yield* Stream.fromSubscription(subscription).pipe(
        Stream.runForEach(() =>
          reconcile().pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Delegation reconciliation failed", cause),
            ),
          ),
        ),
      );
    }),
  );
  return AgentDelegationRuntime.of({
    reconcile: reconcile(),
    run: run.pipe(
      Effect.mapError(
        (cause) => new AgentDelegationStore.AgentDelegationError({ reason: "storage", cause }),
      ),
    ),
  });
});

export const layer = Layer.effect(AgentDelegationRuntime, make);
