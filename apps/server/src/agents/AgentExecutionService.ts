import {
  AgentExecutionError,
  CommandId,
  MessageId,
  type AgentExecutionActor,
  AgentExecutionRecord,
  type AgentExecutionSnapshot,
  type AgentExecutionStopInput,
  type AgentExecutionUpdateInput,
  type AgentExecutionUpdateResult,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import { forkParked } from "../serverActivation.ts";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentExecutionStore from "./AgentExecutionStore.ts";

export class AgentExecutionService extends Context.Service<
  AgentExecutionService,
  {
    readonly update: (
      input: AgentExecutionUpdateInput,
      actor: AgentExecutionActor,
    ) => Effect.Effect<AgentExecutionUpdateResult, AgentExecutionError>;
    readonly snapshot: (
      threads: ReadonlyArray<ScopedThreadRef>,
    ) => Effect.Effect<AgentExecutionSnapshot, AgentExecutionError>;
    readonly subscribe: (
      threads: ReadonlyArray<ScopedThreadRef>,
    ) => Stream.Stream<AgentExecutionSnapshot, AgentExecutionError>;
    readonly history: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<AgentExecutionRecord>, AgentExecutionError>;
    readonly drain: Effect.Effect<void>;
    readonly stop: (input: AgentExecutionStopInput) => Effect.Effect<void, AgentExecutionError>;
  }
>()("t3/agents/AgentExecutionService") {}

const isExecutionError = Schema.is(AgentExecutionError);
const encodeSteering = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      objective: AgentExecutionRecord.fields.objective,
      tasks: AgentExecutionRecord.fields.tasks,
      verifications: AgentExecutionRecord.fields.verifications,
    }),
  ),
);
const mapError = (cause: unknown) =>
  isExecutionError(cause) ? cause : new AgentExecutionError({ reason: "storage", cause });

const make = Effect.gen(function* () {
  const store = yield* AgentExecutionStore.AgentExecutionStore;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;

  const steering = yield* makeDrainableWorker(
    Effect.fn("AgentExecutionService.deliverSteering")(function* () {
      const blocked = new Set<ThreadId>();
      let after: { readonly threadId: ThreadId; readonly revision: number } | undefined;
      while (true) {
        const page = yield* store.pendingSteering(after);
        if (page.length === 0) break;
        for (const record of page) {
          if (blocked.has(record.threadId)) continue;
          yield* Effect.gen(function* () {
            const projection = yield* threads.getThreadProjection(record.threadId);
            const deliveryId = `execution-plan:${record.threadId}:${record.revision}`;
            const plan = yield* encodeSteering(record);
            yield* threads.sendToThread({
              projectId: projection.thread.projectId,
              commandId: CommandId.make(deliveryId),
              messageId: MessageId.make(deliveryId),
              threadId: record.threadId,
              text: `The user updated the objective and checklists (revision ${record.revision}). Treat these as user instructions, not permission changes.\n${plan}`,
              attachments: [],
              mode: "auto",
              createdBy: "user",
              creationSource: "server",
            });
            yield* store.acknowledgeSteering(record.threadId, record.revision);
          }).pipe(
            Effect.catch((error) => {
              blocked.add(record.threadId);
              return Effect.logWarning("Agent steering remains pending", {
                threadId: record.threadId,
                revision: record.revision,
                error,
              });
            }),
          );
        }
        after = page[page.length - 1]!;
      }
    }),
  );
  yield* forkParked(steering.enqueue(undefined).pipe(Effect.repeat(Schedule.spaced("5 seconds"))));

  const snapshot = Effect.fn("AgentExecutionService.snapshot")(function* (
    refs: ReadonlyArray<ScopedThreadRef>,
  ) {
    const localRefs = refs.filter((ref) => ref.environmentId === environmentId);
    return {
      records: yield* store.list(localRefs.map((ref) => ref.threadId)),
      communications: yield* store.communications(localRefs),
    };
  });

  return AgentExecutionService.of({
    update: Effect.fn("AgentExecutionService.update")(function* (input, actor) {
      yield* threads.getThreadProjection(input.threadId);
      const result = yield* store.update(input, actor);
      if (result.steeringRequired) yield* steering.enqueue(undefined);
      return result;
    }, Effect.mapError(mapError)),
    snapshot,
    subscribe: (refs) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const changes = yield* store.subscribeChanges;
          const initial = yield* snapshot(refs);
          return Stream.concat(
            Stream.make(initial),
            Stream.fromSubscription(changes).pipe(Stream.mapEffect(() => snapshot(refs))),
          );
        }),
      ),
    history: store.history,
    stop: Effect.fn("AgentExecutionService.stop")(function* (input) {
      const projection = yield* threads.getThreadProjection(input.threadId);
      yield* threads.interruptThread({
        projectId: projection.thread.projectId,
        threadId: input.threadId,
        commandId: input.commandId,
      });
      if (input.scope === "subtree") {
        yield* threads.stopDelegatedTasks({
          threadId: input.threadId,
          commandId: CommandId.make(`${input.commandId}:descendants`),
          reason: "The user cancelled this agent subtree.",
        });
      }
    }, Effect.mapError(mapError)),
    drain: steering.enqueue(undefined).pipe(Effect.andThen(steering.drain)),
  });
});

export const layer = Layer.effect(AgentExecutionService, make);
