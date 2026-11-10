import { assert, it } from "@effect/vitest";
import {
  OrchestrationV2ForceStopThreadError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentProfileStops from "./AgentProfileStops.ts";
import * as AgentProfileStopWorker from "./AgentProfileStopWorker.ts";
import * as AgentProfileGate from "./AgentProfileGate.ts";

it.effect("retries failed or unfinished revocation stops without skipping other threads", () =>
  Effect.gen(function* () {
    const stops = yield* AgentProfileStops.AgentProfileStops;
    const sql = yield* SqlClient.SqlClient;
    const failed = ThreadId.make("a-failed");
    const releasing = ThreadId.make("b-releasing");
    const stopped = ThreadId.make("c-stopped");
    const descendantsFailed = ThreadId.make("d-descendants-failed");
    for (const threadId of [failed, releasing, stopped, descendantsFailed])
      yield* sql`INSERT INTO agent_profile_stops (thread_id, generation) VALUES (${threadId}, 1)`;
    let retry = false;
    const calls: ThreadId[] = [];
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      stopDelegatedTasks: ({ threadId }) =>
        !retry && threadId === descendantsFailed
          ? Effect.fail(
              new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                projectId: ProjectId.make("project"),
                instanceId: ProviderInstanceId.make("codex"),
              }),
            )
          : Effect.void,
      forceStopThread: ({ threadId }: { readonly threadId: ThreadId }) => {
        calls.push(threadId);
        if (!retry && threadId === failed)
          return Effect.fail(new OrchestrationV2ForceStopThreadError({ threadId }));
        return Effect.succeed({
          outcome: !retry && threadId === releasing ? ("releasing" as const) : ("killed" as const),
          sharedWithThreadIds: [],
        });
      },
    });
    yield* Effect.gen(function* () {
      const worker = yield* AgentProfileStopWorker.AgentProfileStopWorker;
      yield* worker.drain();
      assert.deepStrictEqual(calls, [failed, releasing, stopped, descendantsFailed]);
      assert.deepStrictEqual(
        (yield* stops.pending()).map((stop) => stop.threadId),
        [failed, releasing, descendantsFailed],
      );
      retry = true;
      yield* worker.drain();
      assert.deepStrictEqual(yield* stops.pending(), []);
    }).pipe(Effect.provide(AgentProfileStopWorker.layer.pipe(Layer.provide(threads))));
  }).pipe(
    Effect.provide(
      Layer.merge(AgentProfileStops.layer, AgentProfileGate.layer).pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
      ),
    ),
  ),
);

it.effect(
  "keeps revocation pending until an in-flight startup ends and final teardown is exclusive",
  () =>
    Effect.gen(function* () {
      const stops = yield* AgentProfileStops.AgentProfileStops;
      const gate = yield* AgentProfileGate.AgentProfileGate;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("late-start");
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      let alive = false;
      let kills = 0;
      const starting = yield* gate
        .withStart(
          threadId,
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(finish);
            alive = true;
          }),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* sql`INSERT INTO agent_profile_stops (thread_id, generation) VALUES (${threadId}, 1)`;
      const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
        stopDelegatedTasks: () => Effect.void,
        forceStopThread: () =>
          Effect.sync(() => {
            kills++;
            alive = false;
            return { outcome: "released" as const, sharedWithThreadIds: [] };
          }),
      });
      yield* Effect.gen(function* () {
        const worker = yield* AgentProfileStopWorker.AgentProfileStopWorker;
        yield* worker.drain();
        assert.strictEqual(kills, 1);
        assert.strictEqual((yield* stops.pending()).length, 1);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(starting);
        assert.strictEqual(alive, true);
        yield* worker.drain();
        assert.strictEqual(kills, 2);
        assert.strictEqual(alive, false);
        assert.deepStrictEqual(yield* stops.pending(), []);
      }).pipe(Effect.provide(AgentProfileStopWorker.layer.pipe(Layer.provide(threads))));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(AgentProfileStops.layer, AgentProfileGate.layer).pipe(
          Layer.provideMerge(SqlitePersistence.layerMemory),
        ),
      ),
    ),
);
