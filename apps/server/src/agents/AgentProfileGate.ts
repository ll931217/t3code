import { AgentProfileError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ProviderTurnStartService from "../orchestration-v2/ProviderTurnStartService.ts";
import * as AgentProfileStops from "./AgentProfileStops.ts";
import * as Cancellations from "./AgentDelegationCancellations.ts";
import * as Identity from "../environment/ServerEnvironment.ts";

export class AgentProfileGate extends Context.Service<
  AgentProfileGate,
  {
    readonly withLease: <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | AgentProfileError, R>;
    readonly withStart: <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | AgentProfileError, R>;
  }
>()("t3/agents/AgentProfileGate") {}

export const layer = Layer.effect(
  AgentProfileGate,
  Effect.gen(function* () {
    const active = yield* Ref.make<ReadonlyMap<ThreadId, number>>(new Map());
    const withAccess = Effect.fn("AgentProfileGate.withAccess")(
      <A, E, R>(threadId: ThreadId, shared: boolean, effect: Effect.Effect<A, E, R>) =>
        Effect.acquireUseRelease(
          Ref.modify(active, (current) => {
            const readers = current.get(threadId);
            if (readers !== undefined && (!shared || readers === 0))
              return [false, current] as const;
            const next = new Map(current);
            next.set(threadId, shared ? (readers ?? 0) + 1 : 0);
            return [true, next] as const;
          }).pipe(
            Effect.flatMap((acquired) =>
              acquired
                ? Effect.void
                : Effect.fail(new AgentProfileError({ reason: "snapshot-conflict" })),
            ),
          ),
          () => effect,
          () =>
            Ref.update(active, (current) => {
              const next = new Map(current);
              const readers = current.get(threadId) ?? 0;
              if (readers > 1) next.set(threadId, readers - 1);
              else next.delete(threadId);
              return next;
            }),
        ),
    );
    return AgentProfileGate.of({
      withLease: Effect.fn("AgentProfileGate.withLease")(
        <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
          withAccess(threadId, false, effect),
      ),
      withStart: Effect.fn("AgentProfileGate.withStart")(
        <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
          withAccess(threadId, true, effect),
      ),
    });
  }),
);

export const layerProviderStart = Layer.effect(
  ProviderTurnStartService.ProviderTurnStartServiceV2,
  Effect.gen(function* () {
    const base = yield* ProviderTurnStartService.ProviderTurnStartServiceV2;
    const gate = yield* AgentProfileGate;
    const stops = yield* AgentProfileStops.AgentProfileStops;
    const cancellations = yield* Cancellations.AgentDelegationCancellations;
    const identity = yield* Identity.ServerEnvironmentIdentity;
    const environmentId = yield* identity.getEnvironmentId;
    return ProviderTurnStartService.ProviderTurnStartServiceV2.of({
      start: Effect.fn("AgentProfileGate.start")((input) =>
        gate
          .withStart(
            input.threadId,
            Effect.gen(function* () {
              const cancelled = yield* cancellations
                .requested({ environmentId, threadId: input.threadId })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderTurnStartService.ProviderTurnStartError({
                        runId: input.runId,
                        cause,
                      }),
                  ),
                );
              if (cancelled)
                return yield* new ProviderTurnStartService.ProviderTurnStartError({
                  runId: input.runId,
                  cause: new Error(
                    "This execution tree was cancelled. Launch a new profiled thread.",
                  ),
                });
              yield* stops.assertSettled(input.threadId);
              return yield* base.start(input);
            }),
          )
          .pipe(
            Effect.catchTags({
              AgentProfileError: (cause) =>
                Effect.fail(
                  new ProviderTurnStartService.ProviderTurnStartError({
                    runId: input.runId,
                    cause,
                  }),
                ),
            }),
          ),
      ),
    });
  }),
);
