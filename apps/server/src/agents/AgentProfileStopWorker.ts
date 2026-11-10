import { CommandId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as AgentProfileStops from "./AgentProfileStops.ts";
import * as AgentProfileGate from "./AgentProfileGate.ts";

export class AgentProfileStopWorker extends Context.Service<
  AgentProfileStopWorker,
  { readonly drain: () => Effect.Effect<void> }
>()("t3/agents/AgentProfileStopWorker") {}

const make = Effect.gen(function* () {
  const stops = yield* AgentProfileStops.AgentProfileStops;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const gate = yield* AgentProfileGate.AgentProfileGate;
  const draining = yield* Semaphore.make(1);
  const stopThread = Effect.fn("AgentProfileStopWorker.stopThread")(function* (
    stop: AgentProfileStops.AgentProfileStop,
    acknowledge: boolean,
  ) {
    const descendants = yield* threads
      .stopDelegatedTasks({
        threadId: stop.threadId,
        commandId: CommandId.make(`profile-revoke:${stop.threadId}:${stop.generation}`),
        reason: "Agent profile access revoked.",
      })
      .pipe(Effect.result);
    const parent = yield* threads.forceStopThread({ threadId: stop.threadId }).pipe(Effect.result);
    if (
      acknowledge &&
      descendants._tag === "Success" &&
      parent._tag === "Success" &&
      (parent.success.outcome === "killed" || parent.success.outcome === "released")
    ) {
      yield* stops
        .acknowledge(stop)
        .pipe(
          Effect.catch(() =>
            Effect.logWarning("Profile revocation stop acknowledgment failed; retrying"),
          ),
        );
    }
  });
  const drain = Effect.fn("AgentProfileStopWorker.drain")(
    function* () {
      for (const stop of yield* stops.pending()) {
        yield* gate.withLease(stop.threadId, stopThread(stop, true)).pipe(
          // A busy startup may spawn after this kill; retain its obligation until final teardown owns the lease.
          Effect.catchTags({ AgentProfileError: () => stopThread(stop, false) }),
        );
      }
    },
    draining.withPermit,
    Effect.catch(() => Effect.logWarning("Profile revocation stop queue unavailable; retrying")),
  );
  return AgentProfileStopWorker.of({ drain });
});

export const layer = Layer.effect(AgentProfileStopWorker, make);
export const layerWorker = Layer.effectDiscard(
  Effect.flatMap(AgentProfileStopWorker, (worker) =>
    forkParked(worker.drain().pipe(Effect.repeat(Schedule.spaced("1 second")))),
  ),
);
