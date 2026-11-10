import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import { CommandId, type OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { forkParked } from "../serverActivation.ts";
import * as AgentExecutionStore from "./AgentExecutionStore.ts";

const make = Effect.gen(function* () {
  const digest = yield* Digest.Digest;
  const communicationId = Effect.fn("AgentExecutionObserver.communicationId")(function* (
    id: string,
  ) {
    if (id.length <= 128) return id;
    return Hex.encode(yield* digest.digest(Digest.sha256, new TextEncoder().encode(id)));
  });
  const records = yield* AgentExecutionStore.AgentExecutionStore;
  const events = yield* EventSink.EventSinkV2;
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  const consume = Effect.fn("AgentExecutionObserver.consume")(function* ({
    event,
    sequence,
  }: OrchestrationV2StoredEvent) {
    if (event.type === "message.updated" && event.payload.role === "user") {
      const message = event.payload;
      if (
        message.createdBy === "user" &&
        message.text.trim() !== "" &&
        (yield* records.get(event.threadId)) === null
      ) {
        yield* records.update(
          {
            threadId: event.threadId,
            commandId: CommandId.make(`execution-objective:${message.id}`),
            expectedRevision: 0,
            objective: message.text.slice(0, 16_000),
            tasks: [],
            verifications: [],
          },
          "server",
        );
      }
      if (message.senderThreadId !== undefined) {
        yield* records.recordCommunication(
          {
            id: yield* communicationId(`${message.id}:delivered`),
            source: { environmentId, threadId: message.senderThreadId },
            target: { environmentId, threadId: event.threadId },
            kind: "message",
            status: "delivered",
            summary: "Agent message delivered to the thread.",
          },
          event.occurredAt,
        );
      }
    } else if (event.type === "checkpoint.captured" || event.type === "run.created") {
      if ((yield* records.get(event.threadId)) !== null) {
        yield* records.updateCheckpoint({
          threadId: event.threadId,
          commandId: CommandId.make(`execution-checkpoint:${sequence}`),
          checkpoint:
            event.type === "checkpoint.captured" && event.payload.status === "ready"
              ? event.payload.ref
              : null,
        });
      }
    } else if (event.type === "subagent.updated" && event.payload.origin === "app_owned") {
      const task = event.payload;
      const child =
        task.remoteChild ??
        (task.childThreadId === null ? null : { environmentId, threadId: task.childThreadId });
      if (child !== null) {
        const parent = { environmentId, threadId: task.threadId };
        const target = { environmentId: child.environmentId, threadId: child.threadId };
        if (
          target.environmentId === environmentId &&
          (yield* records.get(target.threadId)) === null
        ) {
          yield* records.update(
            {
              threadId: target.threadId,
              commandId: CommandId.make(`execution-objective:${task.id}`),
              expectedRevision: 0,
              objective: task.prompt.slice(0, 16_000),
              tasks: [],
              verifications: [],
            },
            "server",
          );
        }
        yield* records.recordCommunication(
          {
            id: yield* communicationId(`${task.id}:dispatch`),
            source: parent,
            target,
            kind: "dispatch",
            status: "sent",
            summary: "Delegated task sent.",
          },
          event.occurredAt,
        );
        if (task.startedAt !== null) {
          yield* records.recordCommunication(
            {
              id: yield* communicationId(`${task.id}:started`),
              source: parent,
              target,
              kind: "dispatch",
              status: "delivered",
              summary: "Worker started the delegated task.",
            },
            event.occurredAt,
          );
        }
        if (task.result !== null) {
          yield* records.recordCommunication(
            {
              id: yield* communicationId(`${task.id}:result`),
              source: target,
              target: parent,
              kind: "result",
              status: "sent",
              summary: "Worker result available.",
            },
            event.occurredAt,
          );
          const delivery = task.completionDelivery?.state;
          if (delivery === "delivered" || delivery === "acknowledged") {
            yield* records.recordCommunication(
              {
                id: yield* communicationId(`${task.id}:result:${delivery}`),
                source: target,
                target: parent,
                kind: "result",
                status: delivery,
                summary: "Parent received the worker result.",
              },
              event.occurredAt,
            );
          }
        }
      }
    }
    yield* sql`UPDATE agent_execution_observer SET sequence = MAX(sequence, ${sequence}) WHERE id = 1`;
  });
  const run = Effect.gen(function* () {
    const rows = yield* sql<{
      readonly sequence: number;
    }>`SELECT sequence FROM agent_execution_observer WHERE id = 1`;
    yield* events.stream({ afterSequence: rows[0]?.sequence ?? 0 }).pipe(
      Stream.filter(
        ({ event }) =>
          event.type === "checkpoint.captured" ||
          event.type === "run.created" ||
          event.type === "subagent.updated" ||
          (event.type === "message.updated" && event.payload.role === "user"),
      ),
      Stream.runForEach(consume),
    );
  });
  return { consume, run };
});

export class AgentExecutionObserver extends Context.Service<
  AgentExecutionObserver,
  Effect.Success<typeof make>
>()("t3/agents/AgentExecutionObserver") {}
export const layer = Layer.effect(AgentExecutionObserver, make);
export const layerWorker = Layer.effectDiscard(
  Effect.flatMap(AgentExecutionObserver, (observer) =>
    forkParked(
      observer.run.pipe(
        Effect.tapError((error) =>
          Effect.logWarning(
            "Agent execution observation failed; retrying from durable cursor",
            error,
          ),
        ),
        Effect.retry(Schedule.spaced("1 second")),
      ),
    ),
  ),
);
