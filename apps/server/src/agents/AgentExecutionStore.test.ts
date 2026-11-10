import { assert, it } from "@effect/vitest";
import { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentExecutionStore from "./AgentExecutionStore.ts";

it.layer(AgentExecutionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "AgentExecutionStore",
  (it) => {
    it.effect(
      "persists revisions, deduplicates retries, and queues human steering atomically",
      () =>
        Effect.gen(function* () {
          const store = yield* AgentExecutionStore.AgentExecutionStore;
          const threadId = ThreadId.make("execution-revisions");
          const input = {
            threadId,
            commandId: CommandId.make("execution-update-1"),
            expectedRevision: 0,
            objective: "Ship profile permissions",
            tasks: [{ id: "policy", title: "Enforce read-only", status: "in-progress" as const }],
            verifications: [],
          };
          const first = yield* store.update(input, "user");
          assert.strictEqual(first.record.revision, 1);
          assert.strictEqual(first.steeringRequired, true);
          assert.strictEqual((yield* store.update(input, "user")).duplicate, true);
          assert.strictEqual((yield* store.history(threadId)).length, 1);
          assert.strictEqual(
            (yield* store.pendingSteering()).filter((item) => item.threadId === threadId).length,
            1,
          );
          yield* store.acknowledgeSteering(threadId, 1);
          assert.strictEqual(
            (yield* store.pendingSteering()).some((item) => item.threadId === threadId),
            false,
          );
          const conflict = yield* store
            .update({ ...input, commandId: CommandId.make("stale-update") }, "agent")
            .pipe(Effect.flip);
          assert.strictEqual(conflict.reason, "revision-conflict");
          const reused = yield* store
            .update({ ...input, objective: "Different request" }, "user")
            .pipe(Effect.flip);
          assert.strictEqual(reused.reason, "command-conflict");
          assert.strictEqual(
            (yield* store.update(input, "server").pipe(Effect.flip)).reason,
            "command-conflict",
          );
          assert.strictEqual((yield* store.get(threadId))?.objective, input.objective);
          yield* Effect.gen(function* () {
            const reopened = yield* AgentExecutionStore.AgentExecutionStore;
            assert.deepStrictEqual(yield* reopened.get(threadId), first.record);
            assert.strictEqual((yield* reopened.update(input, "user")).duplicate, true);
          }).pipe(Effect.provide(AgentExecutionStore.layer));
          const competing = yield* Effect.forEach(
            ["first", "second"],
            (id) =>
              store
                .update(
                  {
                    ...input,
                    commandId: CommandId.make(`concurrent-${id}`),
                    expectedRevision: 1,
                    objective: id,
                  },
                  "agent",
                )
                .pipe(Effect.result),
            { concurrency: "unbounded" },
          );
          assert.strictEqual(competing.filter((result) => result._tag === "Success").length, 1);
          assert.strictEqual((yield* store.get(threadId))?.revision, 2);
        }),
    );

    it.effect(
      "requires evidence for a pass and preserves its attribution and historical freshness",
      () =>
        Effect.gen(function* () {
          const store = yield* AgentExecutionStore.AgentExecutionStore;
          const threadId = ThreadId.make("execution-verification");
          const verification = {
            id: "test",
            title: "Policy tests",
            status: "passed" as const,
            evidence: [],
            checkpoint: "commit-a",
          };
          const input = {
            threadId,
            commandId: CommandId.make("verification-1"),
            expectedRevision: 0,
            objective: "Verify policy",
            tasks: [],
            verifications: [verification],
          };
          assert.strictEqual(
            (yield* store.update(input, "agent").pipe(Effect.flip)).reason,
            "missing-evidence",
          );
          const first = yield* store.update(
            {
              ...input,
              verifications: [
                { ...verification, evidence: [{ kind: "test", summary: "12 tests passed" }] },
              ],
            },
            "agent",
          );
          assert.strictEqual(first.record.verifications[0]?.provenance, "agent-reported");
          assert.strictEqual(first.record.verifications[0]?.freshness, "unknown");
          const preserved = yield* store.update(
            {
              ...input,
              commandId: CommandId.make("verification-human-edit"),
              expectedRevision: 1,
              objective: "Review the evidence",
              verifications: first.record.verifications.map((item) => ({
                ...item,
                title: "Renamed check",
              })),
            },
            "user",
          );
          assert.strictEqual(preserved.record.verifications[0]?.provenance, "agent-reported");
          yield* store.updateCheckpoint({
            threadId,
            commandId: CommandId.make("checkpoint-a"),
            checkpoint: "commit-a",
          });
          assert.strictEqual((yield* store.get(threadId))?.verifications[0]?.freshness, "current");
          yield* store.updateCheckpoint({
            threadId,
            commandId: CommandId.make("checkpoint-b"),
            checkpoint: "commit-b",
          });
          const current = yield* store.get(threadId);
          assert.strictEqual(current?.verifications[0]?.status, "passed");
          assert.strictEqual(current?.verifications[0]?.freshness, "stale");
          assert.strictEqual(current?.verifications[0]?.provenance, "agent-reported");
          assert.strictEqual(
            (yield* store.history(threadId))[0]?.verifications[0]?.freshness,
            "unknown",
          );
          const confirmation = {
            ...input,
            commandId: CommandId.make("verification-confirm"),
            expectedRevision: current?.revision ?? 0,
            verifications: current?.verifications ?? [],
            confirmVerificationIds: ["test"],
          };
          assert.strictEqual(
            (yield* store.update(confirmation, "agent").pipe(Effect.flip)).reason,
            "invalid-input",
          );
          const confirmed = yield* store.update(confirmation, "user");
          assert.strictEqual(confirmed.record.verifications[0]?.provenance, "user-confirmed");
          const editedEvidence = {
            ...confirmation,
            commandId: CommandId.make("verification-edit-evidence"),
            expectedRevision: confirmed.record.revision,
            confirmVerificationIds: [],
            verifications: confirmed.record.verifications.map((item) => ({
              ...item,
              evidence: [{ kind: "manual" as const, summary: "Changed evidence" }],
            })),
          };
          assert.strictEqual(
            (yield* store.update(editedEvidence, "user").pipe(Effect.flip)).reason,
            "confirmation-required",
          );
        }),
    );

    it.effect("retains observable communication records without duplicating retry events", () =>
      Effect.gen(function* () {
        const store = yield* AgentExecutionStore.AgentExecutionStore;
        const source = {
          environmentId: EnvironmentId.make("source-env"),
          threadId: ThreadId.make("same-id"),
        };
        const target = {
          environmentId: EnvironmentId.make("target-env"),
          threadId: ThreadId.make("same-id"),
        };
        const input = {
          id: "handoff-1",
          source,
          target,
          kind: "dispatch" as const,
          status: "sent" as const,
          summary: "Implement policy",
        };
        const first = yield* store.recordCommunication(input);
        assert.deepStrictEqual(yield* store.recordCommunication(input), first);
        const otherSource = { ...source, environmentId: EnvironmentId.make("unrelated-env") };
        yield* store.recordCommunication({ ...input, source: otherSource, target: otherSource });
        const records = yield* store.communications([source]);
        assert.strictEqual(records.length, 1);
        assert.notStrictEqual(records[0]?.source.environmentId, records[0]?.target.environmentId);
        assert.strictEqual((yield* store.communications([target])).length, 1);
        assert.strictEqual((yield* store.communications([otherSource])).length, 1);
      }),
    );
  },
);
