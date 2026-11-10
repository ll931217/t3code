import { assert, it } from "@effect/vitest";
import { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Cancellations from "./AgentDelegationCancellations.ts";

it.effect(
  "retains cancellation fences and pending delivery across reconstruction and stale acknowledgments",
  () =>
    Effect.gen(function* () {
      const store = yield* Cancellations.AgentDelegationCancellations;
      const child = { environmentId: EnvironmentId.make("peer"), threadId: ThreadId.make("child") };
      const other = { ...child, environmentId: EnvironmentId.make("other-peer") };
      assert.isFalse(yield* store.requested(child));
      const first = yield* store.request(child, CommandId.make("cancel-first"));
      assert.isTrue(yield* store.requested(child));
      assert.isFalse(yield* store.requested(other));
      assert.deepStrictEqual(yield* store.request(child, first.commandId), first);
      const second = yield* store.request(child, CommandId.make("cancel-second"));
      assert.strictEqual(second.generation, first.generation + 1);
      yield* store.acknowledge(first);
      assert.deepStrictEqual(yield* store.pending(), [second]);
      yield* Effect.gen(function* () {
        const reopened = yield* Cancellations.AgentDelegationCancellations;
        assert.deepStrictEqual(yield* reopened.pending(), [second]);
        yield* reopened.acknowledge(second);
        assert.deepStrictEqual(yield* reopened.pending(), []);
        assert.isTrue(yield* reopened.requested(child));
        assert.deepStrictEqual(yield* reopened.request(child, first.commandId), second);
        assert.deepStrictEqual(yield* reopened.pending(), []);
      }).pipe(Effect.provide(Layer.fresh(Cancellations.layer)));
    }).pipe(Effect.provide(Cancellations.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);
