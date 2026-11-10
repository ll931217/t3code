import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentProfileGate from "./AgentProfileGate.ts";
import * as AgentProfileStops from "./AgentProfileStops.ts";
import migrateStopGenerations from "../persistence/Migrations/088_AgentProfileStopGenerations.ts";

it.effect(
  "profile mutation and provider startup exclude each other without waiting on an active turn",
  () =>
    Effect.gen(function* () {
      const gate = yield* AgentProfileGate.AgentProfileGate;
      const threadId = ThreadId.make("profile-lease");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const running = yield* gate
        .withStart(
          threadId,
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      assert.strictEqual(
        yield* gate.withStart(threadId, Effect.succeed("background")),
        "background",
      );
      const blocked = yield* gate.withLease(threadId, Effect.succeed("changed")).pipe(Effect.flip);
      assert.strictEqual(blocked.reason, "snapshot-conflict");
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(running);
      const startDuringMutation = yield* gate.withLease(
        threadId,
        gate.withStart(threadId, Effect.void).pipe(Effect.flip),
      );
      assert.strictEqual(startDuringMutation.reason, "snapshot-conflict");
      yield* gate.withLease(threadId, Effect.fail("failed mutation")).pipe(Effect.flip);
      assert.strictEqual(yield* gate.withLease(threadId, Effect.succeed("started")), "started");
    }).pipe(Effect.scoped, Effect.provide(AgentProfileGate.layer)),
);

it.effect("durable revocation stops survive reconstruction and stale acknowledgments", () =>
  Effect.gen(function* () {
    const stops = yield* AgentProfileStops.AgentProfileStops;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("revoked-thread");
    yield* sql`INSERT INTO agent_profile_stops (thread_id, generation) VALUES (${threadId}, 1)`;
    const first = (yield* stops.pending())[0]!;
    assert.strictEqual(
      (yield* stops.assertSettled(threadId).pipe(Effect.flip)).reason,
      "snapshot-conflict",
    );
    yield* Effect.gen(function* () {
      const reopened = yield* AgentProfileStops.AgentProfileStops;
      assert.deepStrictEqual(yield* reopened.pending(), [first]);
      yield* sql`UPDATE agent_profile_stops SET generation = generation + 1 WHERE thread_id = ${threadId}`;
      yield* reopened.acknowledge(first);
      const next = (yield* reopened.pending())[0]!;
      assert.strictEqual(next.generation, 2);
      yield* reopened.acknowledge(next);
      yield* reopened.assertSettled(threadId);
      assert.deepStrictEqual(yield* reopened.pending(), []);
      yield* sql`INSERT INTO agent_profile_stops (thread_id, generation) VALUES (${threadId}, 1)
        ON CONFLICT(thread_id) DO UPDATE SET generation = generation + 1`;
      const third = (yield* reopened.pending())[0]!;
      assert.strictEqual(third.generation, 3);
      yield* reopened.acknowledge(next);
      assert.deepStrictEqual(yield* reopened.pending(), [third]);
    }).pipe(Effect.provide(Layer.fresh(AgentProfileStops.layer)));
  }).pipe(
    Effect.provide(AgentProfileStops.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
);

it.effect("upgrades pending stops from the original lifecycle schema without losing work", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const stops = yield* AgentProfileStops.AgentProfileStops;
    const threadId = ThreadId.make("legacy-stop");
    yield* sql`DROP TABLE agent_profile_stops`;
    yield* sql`CREATE TABLE agent_profile_stops (thread_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)`;
    yield* sql`INSERT INTO agent_profile_stops VALUES (${threadId}, 4)`;
    yield* migrateStopGenerations;
    yield* migrateStopGenerations;
    const pending = { threadId, generation: 4 };
    assert.deepStrictEqual(yield* stops.pending(), [pending]);
    yield* stops.acknowledge(pending);
    yield* stops.assertSettled(threadId);
  }).pipe(
    Effect.provide(AgentProfileStops.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
);
