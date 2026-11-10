import { assert, it } from "@effect/vitest";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentDelegationStore from "./AgentDelegationStore.ts";

const ref = (thread: string) => ({
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make(thread),
});

it.layer(AgentDelegationStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "AgentDelegationStore",
  (it) => {
    it.effect(
      "persists FIFO admission, retries, suspension and reacquisition without oversubscription",
      () =>
        Effect.gen(function* () {
          const store = yield* AgentDelegationStore.AgentDelegationStore;
          const root = ref("root");
          const request = (id: string) => ({
            commandId: id,
            root,
            parent: root,
            child: ref(id),
            snapshotId: "pinned",
            requestKey: id,
            limits: { maxConcurrent: 1, maxAgents: 3, maxDepth: 2 },
          });
          const first = yield* store.reserve(request("first"));
          assert.strictEqual(first.status, "active");
          assert.deepStrictEqual(yield* store.reserve(request("first")), first);
          assert.strictEqual(
            (yield* store.reserve({ ...request("first"), requestKey: "changed" }).pipe(Effect.flip))
              .reason,
            "command-conflict",
          );
          assert.strictEqual((yield* store.reserve(request("second"))).status, "queued");
          const pending = { child: ref("second"), runId: RunId.make("queued-run") };
          yield* store.deferStart(pending);
          yield* store.deferStart(pending);
          assert.deepStrictEqual(yield* store.pendingStarts(), [{ ...pending, generation: 1 }]);
          assert.strictEqual(
            (yield* store.transition(ref("first"), "waiting", false).pipe(Effect.flip)).reason,
            "provider-not-suspended",
          );
          yield* store.transition(ref("first"), "waiting", true);
          assert.strictEqual((yield* store.admitQueued(root))[0]?.child.threadId, "second");
          assert.strictEqual(
            (yield* store.transition(ref("first"), "active", true)).status,
            "queued",
          );
          yield* store.transition(ref("second"), "completed", true);
          assert.strictEqual((yield* store.admitQueued(root))[0]?.child.threadId, "first");
          assert.strictEqual(
            (yield* store.transition(ref("second"), "active", true)).status,
            "queued",
          );
          yield* Effect.gen(function* () {
            const reopened = yield* AgentDelegationStore.AgentDelegationStore;
            assert.strictEqual((yield* reopened.get(ref("first")))?.status, "active");
            assert.deepStrictEqual(yield* reopened.pendingStarts(), [
              { ...pending, generation: 1 },
            ]);
            yield* reopened.acknowledgeStart({ ...pending, generation: 1 });
            assert.deepStrictEqual(yield* reopened.pendingStarts(), []);
            yield* reopened.deferStart(pending);
            yield* reopened.acknowledgeStart({ ...pending, generation: 1 });
            assert.deepStrictEqual(yield* reopened.pendingStarts(), [
              { ...pending, generation: 2 },
            ]);
            assert.strictEqual((yield* reopened.reserve(request("third"))).status, "queued");
            assert.strictEqual(
              (yield* reopened.reserve(request("fourth")).pipe(Effect.flip)).reason,
              "total-limit",
            );
          }).pipe(Effect.provide(AgentDelegationStore.layer));
          const competing = yield* Effect.forEach(
            ["race-one", "race-two", "race-three"],
            (id) =>
              store.reserve({
                ...request(id),
                root: ref("race-root"),
                parent: ref("race-root"),
              }),
            { concurrency: "unbounded" },
          );
          assert.strictEqual(competing.filter((item) => item.status === "active").length, 1);
          assert.strictEqual(competing.filter((item) => item.status === "queued").length, 2);
        }),
    );
    it.effect("derives depth from durable lineage and rejects changed tree authority", () =>
      Effect.gen(function* () {
        const store = yield* AgentDelegationStore.AgentDelegationStore;
        const root = ref("depth-root");
        const request = {
          commandId: "depth-one",
          root,
          parent: root,
          child: ref("one"),
          snapshotId: "pinned",
          requestKey: "one",
          limits: { maxConcurrent: 4, maxAgents: 16, maxDepth: 1 },
        };
        yield* store.reserve(request);
        assert.strictEqual(
          (yield* store
            .reserve({ ...request, commandId: "depth-two", parent: ref("one"), child: ref("two") })
            .pipe(Effect.flip)).reason,
          "depth-limit",
        );
        assert.strictEqual(
          (yield* store
            .reserve({
              ...request,
              commandId: "missing-parent",
              parent: ref("missing"),
              child: ref("three"),
            })
            .pipe(Effect.flip)).reason,
          "invalid-parent",
        );
        assert.strictEqual(
          (yield* store
            .reserve({
              ...request,
              commandId: "changed-limits",
              child: ref("four"),
              limits: { ...request.limits, maxDepth: 3 },
            })
            .pipe(Effect.flip)).reason,
          "authority-conflict",
        );
      }),
    );
  },
);
