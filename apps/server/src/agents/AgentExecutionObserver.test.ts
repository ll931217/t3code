import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { CommandId, EnvironmentId, OrchestrationV2StoredEvent, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentExecutionStore from "./AgentExecutionStore.ts";
import * as AgentExecutionObserver from "./AgentExecutionObserver.ts";

const database = SqlitePersistence.layerMemory;
const decodeStoredEvent = Schema.decodeEffect(OrchestrationV2StoredEvent);
const environmentId = EnvironmentId.make("local");
const testLayer = AgentExecutionObserver.layer.pipe(
  Layer.provideMerge(AgentExecutionStore.layer),
  Layer.provideMerge(database),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(Layer.mock(EventSink.EventSinkV2)({})),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
);

it.effect("records only observed delivery stages once and invalidates earlier evidence", () =>
  Effect.gen(function* () {
    const store = yield* AgentExecutionStore.AgentExecutionStore;
    const observer = yield* AgentExecutionObserver.AgentExecutionObserver;
    const threadId = ThreadId.make("parent");
    const now = yield* DateTime.now;
    const event = yield* decodeStoredEvent({
      sequence: 1,
      commandId: null,
      event: {
        id: "task-event",
        type: "subagent.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: "node:delegated-task:command%3Amcp%3A31e36a58-5977-47df-922e-812bc7f2fe5d%3Adelegate-task%3A2f00dc11-4e9c-40ba-a183-3caa1695fe18",
          threadId,
          runId: null,
          parentNodeId: "root",
          origin: "app_owned",
          createdBy: "agent",
          driver: "codex",
          providerInstanceId: "codex",
          providerThreadId: null,
          childThreadId: "child",
          nativeTaskRef: null,
          prompt: "Implement",
          title: "Worker",
          model: null,
          status: "pending",
          result: null,
          startedAt: null,
          completedAt: null,
          updatedAt: now,
        },
      },
    });
    yield* observer.consume(event);
    yield* observer.consume(event);
    const refs = [{ environmentId, threadId }];
    expect((yield* store.communications(refs)).map((item) => item.status)).toEqual(["sent"]);
    if (event.event.type !== "subagent.updated") return yield* Effect.die("Unexpected fixture");
    yield* observer.consume({
      ...event,
      sequence: 2,
      event: {
        ...event.event,
        payload: {
          ...event.event.payload,
          status: "completed",
          startedAt: now,
          completedAt: now,
          result: "Implemented",
          completionDelivery: { state: "delivered", observedByRunId: null },
        },
      },
    });
    expect((yield* store.communications(refs)).map((item) => [item.kind, item.status])).toEqual([
      ["dispatch", "sent"],
      ["dispatch", "delivered"],
      ["result", "sent"],
      ["result", "delivered"],
    ]);
    const sql = yield* SqlClient.SqlClient;
    expect(yield* sql`SELECT sequence FROM agent_execution_observer WHERE id = 1`).toEqual([
      { sequence: 2 },
    ]);
    yield* store.update(
      {
        threadId,
        commandId: CommandId.make("plan"),
        expectedRevision: 0,
        objective: "Verify",
        tasks: [],
        verifications: [
          {
            id: "check",
            title: "Tests",
            status: "passed",
            evidence: [{ kind: "test", summary: "Tests passed" }],
            checkpoint: "ref-a",
          },
        ],
      },
      "agent",
    );
    const checkpoint = yield* decodeStoredEvent({
      sequence: 3,
      commandId: null,
      event: {
        id: "checkpoint-event",
        type: "checkpoint.captured",
        threadId,
        occurredAt: now,
        payload: {
          id: "checkpoint",
          threadId,
          scopeId: "scope",
          runId: null,
          nodeId: "root",
          parentCheckpointId: null,
          ordinalWithinScope: 0,
          appRunOrdinal: null,
          ref: "ref-b",
          status: "ready",
          files: [],
          capturedAt: now,
        },
      },
    });
    yield* observer.consume(checkpoint);
    yield* observer.consume(checkpoint);
    expect((yield* store.get(threadId))?.verifications[0]?.freshness).toBe("stale");
    expect((yield* store.history(threadId)).length).toBe(2);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "seeds the first user objective and records addressed messages without replacing later plans",
  () =>
    Effect.gen(function* () {
      const store = yield* AgentExecutionStore.AgentExecutionStore;
      const observer = yield* AgentExecutionObserver.AgentExecutionObserver;
      const threadId = ThreadId.make("conversation");
      const now = yield* DateTime.now;
      const message = yield* decodeStoredEvent({
        sequence: 1,
        commandId: null,
        event: {
          id: "message-event",
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: "message:thread:thread%3Adelegated-task%3Acommand%253Amcp%253A31e36a58-5977-47df-922e-812bc7f2fe5d%253Adelegate-task%253A2f00dc11-4e9c-40ba-a183-3caa1695fe18:ordinal:1",
            threadId,
            runId: null,
            nodeId: null,
            role: "user",
            text: "Build the feature",
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
          },
        },
      });
      yield* observer.consume(message);
      expect((yield* store.get(threadId))?.objective).toBe("Build the feature");
      expect(yield* store.pendingSteering()).toEqual([]);
      if (message.event.type !== "message.updated") return yield* Effect.die("Unexpected fixture");
      const followup = {
        ...message,
        sequence: 2,
        event: {
          ...message.event,
          payload: {
            ...message.event.payload,
            id: message.event.payload.id,
            text: "Review the result",
            createdBy: "agent" as const,
            senderThreadId: ThreadId.make("sender"),
          },
        },
      };
      yield* observer.consume(followup);
      yield* observer.consume(followup);
      expect((yield* store.get(threadId))?.objective).toBe("Build the feature");
      expect(
        (yield* store.communications([{ environmentId, threadId }])).map((item) => [
          item.kind,
          item.status,
        ]),
      ).toEqual([["message", "delivered"]]);
    }).pipe(Effect.provide(testLayer)),
);
