import {
  AgentCommunication,
  AgentCommunicationInput,
  AgentExecutionActor,
  AgentExecutionError,
  AgentExecutionRecord,
  AgentExecutionUpdateInput,
  AgentExecutionUpdateResult,
  AgentVerificationInput,
  type AgentVerification,
  CommandId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

export class AgentExecutionStore extends Context.Service<
  AgentExecutionStore,
  {
    readonly get: (
      threadId: ThreadId,
    ) => Effect.Effect<AgentExecutionRecord | null, AgentExecutionError>;
    readonly list: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<ReadonlyArray<AgentExecutionRecord>, AgentExecutionError>;
    readonly update: (
      input: AgentExecutionUpdateInput,
      actor: AgentExecutionActor,
    ) => Effect.Effect<AgentExecutionUpdateResult, AgentExecutionError>;
    readonly history: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<AgentExecutionRecord>, AgentExecutionError>;
    readonly updateCheckpoint: (input: {
      readonly threadId: ThreadId;
      readonly commandId: CommandId;
      readonly checkpoint: string | null;
    }) => Effect.Effect<AgentExecutionUpdateResult, AgentExecutionError>;
    readonly pendingSteering: (after?: {
      readonly threadId: ThreadId;
      readonly revision: number;
    }) => Effect.Effect<ReadonlyArray<AgentExecutionRecord>, AgentExecutionError>;
    readonly acknowledgeSteering: (
      threadId: ThreadId,
      revision: number,
    ) => Effect.Effect<void, AgentExecutionError>;
    readonly recordCommunication: (
      input: AgentCommunicationInput,
      observedAt?: DateTime.Utc,
    ) => Effect.Effect<AgentCommunication, AgentExecutionError>;
    readonly communications: (
      threads: ReadonlyArray<ScopedThreadRef>,
    ) => Effect.Effect<ReadonlyArray<AgentCommunication>, AgentExecutionError>;
    readonly changes: Stream.Stream<void>;
    readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
  }
>()("t3/agents/AgentExecutionStore") {}

const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentExecutionRecord));
const decodeResult = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentExecutionUpdateResult));
const decodeCommunication = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentCommunication));
const decodeUpdate = Schema.decodeUnknownEffect(AgentExecutionUpdateInput);
const decodeCommunicationInput = Schema.decodeUnknownEffect(AgentCommunicationInput);
const encodeVerificationResult = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      status: AgentVerificationInput.fields.status,
      evidence: AgentVerificationInput.fields.evidence,
      checkpoint: AgentVerificationInput.fields.checkpoint,
    }),
  ),
);
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(AgentExecutionRecord));
const encodeResult = Schema.encodeEffect(Schema.fromJsonString(AgentExecutionUpdateResult));
const encodeCommunication = Schema.encodeEffect(Schema.fromJsonString(AgentCommunication));
const encodeCommunicationInput = Schema.encodeEffect(
  Schema.fromJsonString(AgentCommunicationInput),
);
const encodeUpdateRequest = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("update"),
      actor: AgentExecutionActor,
      input: AgentExecutionUpdateInput,
    }),
  ),
);
const encodeCheckpointRequest = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("checkpoint"),
      input: Schema.Struct({
        threadId: ThreadId,
        commandId: CommandId,
        checkpoint: Schema.NullOr(Schema.String),
      }),
    }),
  ),
);
const isExecutionError = Schema.is(AgentExecutionError);

function storageError(cause: unknown): AgentExecutionError {
  return isExecutionError(cause) ? cause : new AgentExecutionError({ reason: "storage", cause });
}

function freshness(
  checkpoint: string | undefined,
  current: string | null,
): AgentVerification["freshness"] {
  return checkpoint === undefined || current === null
    ? "unknown"
    : checkpoint === current
      ? "current"
      : "stale";
}

const provenance = {
  user: "user-confirmed",
  agent: "agent-reported",
  server: "server-observed",
} as const;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.sliding<void>(1);

  const get = Effect.fn("AgentExecutionStore.get")(function* (threadId: ThreadId) {
    const rows = yield* sql<{
      readonly payload_json: string;
    }>`SELECT payload_json FROM agent_execution_records WHERE thread_id = ${threadId}`;
    return rows[0] === undefined ? null : yield* decodeRecord(rows[0].payload_json);
  }, Effect.mapError(storageError));

  const readReceipt = Effect.fn("AgentExecutionStore.readReceipt")(function* (
    commandId: CommandId,
    request: string,
  ) {
    const rows = yield* sql<{
      readonly request_json: string;
      readonly result_json: string;
    }>`SELECT request_json, result_json FROM agent_execution_receipts WHERE command_id = ${commandId}`;
    const row = rows[0];
    if (row === undefined) return null;
    if (row.request_json !== request)
      return yield* new AgentExecutionError({ reason: "command-conflict" });
    return { ...(yield* decodeResult(row.result_json)), duplicate: true };
  });

  const persist = Effect.fn("AgentExecutionStore.persist")(function* (input: {
    readonly commandId: CommandId;
    readonly request: string;
    readonly record: AgentExecutionRecord;
    readonly steeringRequired: boolean;
  }) {
    const { record } = input;
    const payload = yield* encodeRecord(record);
    yield* sql`INSERT INTO agent_execution_records (thread_id, revision, payload_json)
      VALUES (${record.threadId}, ${record.revision}, ${payload})
      ON CONFLICT(thread_id) DO UPDATE SET revision = excluded.revision, payload_json = excluded.payload_json`;
    yield* sql`INSERT INTO agent_execution_history (thread_id, revision, payload_json) VALUES (${record.threadId}, ${record.revision}, ${payload})`;
    if (input.steeringRequired) {
      yield* sql`INSERT INTO agent_execution_steering (thread_id, revision, payload_json) VALUES (${record.threadId}, ${record.revision}, ${payload})`;
    }
    const result: AgentExecutionUpdateResult = {
      record,
      duplicate: false,
      steeringRequired: input.steeringRequired,
    };
    const encodedResult = yield* encodeResult(result);
    yield* sql`INSERT INTO agent_execution_receipts (command_id, request_json, result_json) VALUES (${input.commandId}, ${input.request}, ${encodedResult})`;
    return result;
  });

  const publish = Effect.fn("AgentExecutionStore.publish")(function* (
    result: AgentExecutionUpdateResult,
  ) {
    if (!result.duplicate) yield* PubSub.publish(changes, undefined);
    return result;
  });

  const update = Effect.fn("AgentExecutionStore.update")(function* (
    raw: AgentExecutionUpdateInput,
    actor: AgentExecutionActor,
  ) {
    const input = yield* decodeUpdate(raw).pipe(
      Effect.mapError((cause) => new AgentExecutionError({ reason: "invalid-input", cause })),
    );
    const request = yield* encodeUpdateRequest({ type: "update", actor, input });
    const result = yield* sql.withTransaction(
      Effect.gen(function* () {
        const previous = yield* readReceipt(input.commandId, request);
        if (previous !== null) return previous;
        const current = yield* get(input.threadId);
        if ((current?.revision ?? 0) !== input.expectedRevision)
          return yield* new AgentExecutionError({ reason: "revision-conflict" });
        if (
          new Set(input.tasks.map((item) => item.id)).size !== input.tasks.length ||
          new Set(input.verifications.map((item) => item.id)).size !== input.verifications.length
        ) {
          return yield* new AgentExecutionError({ reason: "duplicate-item" });
        }
        if (
          input.verifications.some((item) => item.status === "passed" && item.evidence.length === 0)
        ) {
          return yield* new AgentExecutionError({ reason: "missing-evidence" });
        }
        const confirmations = new Set(input.confirmVerificationIds ?? []);
        if (
          confirmations.size > 0 &&
          (actor !== "user" ||
            [...confirmations].some(
              (id) =>
                !input.verifications.some((item) => item.id === id && item.status === "passed"),
            ))
        ) {
          return yield* new AgentExecutionError({ reason: "invalid-input" });
        }
        const checkpoint = current?.checkpoint ?? null;
        const verifications = yield* Effect.forEach(input.verifications, (item) =>
          Effect.gen(function* () {
            const previousItem = current?.verifications.find(
              (candidate) => candidate.id === item.id,
            );
            const unchanged =
              previousItem !== undefined &&
              (yield* encodeVerificationResult(previousItem)) ===
                (yield* encodeVerificationResult(item));
            const confirmed = confirmations.has(item.id);
            if (actor === "user" && item.status === "passed" && !unchanged && !confirmed) {
              return yield* new AgentExecutionError({ reason: "confirmation-required" });
            }
            return {
              ...item,
              provenance: confirmed
                ? ("user-confirmed" as const)
                : unchanged
                  ? previousItem.provenance
                  : provenance[actor],
              freshness: freshness(item.checkpoint, checkpoint),
            };
          }),
        );
        return yield* persist({
          commandId: input.commandId,
          request,
          steeringRequired: actor === "user",
          record: {
            threadId: input.threadId,
            objective: input.objective,
            revision: input.expectedRevision + 1,
            tasks: input.tasks,
            verifications,
            checkpoint,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
            updatedBy: actor,
          },
        });
      }),
    );
    return yield* publish(result);
  }, Effect.mapError(storageError));

  const updateCheckpoint = Effect.fn("AgentExecutionStore.updateCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly checkpoint: string | null;
  }) {
    const request = yield* encodeCheckpointRequest({ type: "checkpoint", input });
    const result = yield* sql.withTransaction(
      Effect.gen(function* () {
        const previous = yield* readReceipt(input.commandId, request);
        if (previous !== null) return previous;
        const current = yield* get(input.threadId);
        return yield* persist({
          commandId: input.commandId,
          request,
          steeringRequired: false,
          record: {
            threadId: input.threadId,
            objective: current?.objective ?? "",
            revision: (current?.revision ?? 0) + 1,
            tasks: current?.tasks ?? [],
            verifications: (current?.verifications ?? []).map((item) => ({
              ...item,
              freshness: freshness(item.checkpoint, input.checkpoint),
            })),
            checkpoint: input.checkpoint,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
            updatedBy: "server",
          },
        });
      }),
    );
    return yield* publish(result);
  }, Effect.mapError(storageError));

  const list = Effect.fn("AgentExecutionStore.list")(function* (
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    if (threadIds.length === 0) return [];
    const rows = yield* sql<{
      readonly payload_json: string;
    }>`SELECT payload_json FROM agent_execution_records WHERE ${sql.in("thread_id", threadIds)}`;
    return yield* Effect.forEach(rows, (row) => decodeRecord(row.payload_json));
  }, Effect.mapError(storageError));

  const history = Effect.fn("AgentExecutionStore.history")(function* (threadId: ThreadId) {
    const rows = yield* sql<{
      readonly payload_json: string;
    }>`SELECT payload_json FROM agent_execution_history WHERE thread_id = ${threadId} ORDER BY revision DESC LIMIT 100`;
    return yield* Effect.forEach(rows.toReversed(), (row) => decodeRecord(row.payload_json));
  }, Effect.mapError(storageError));

  const pendingSteering = Effect.fn("AgentExecutionStore.pendingSteering")(function* (after?: {
    readonly threadId: ThreadId;
    readonly revision: number;
  }) {
    const rows = yield* sql<{
      readonly payload_json: string;
    }>`SELECT payload_json FROM agent_execution_steering
      WHERE ${after === undefined ? sql`1 = 1` : sql`(thread_id, revision) > (${after.threadId}, ${after.revision})`}
      ORDER BY thread_id, revision LIMIT 100`;
    return yield* Effect.forEach(rows, (row) => decodeRecord(row.payload_json));
  }, Effect.mapError(storageError));

  const acknowledgeSteering = Effect.fn("AgentExecutionStore.acknowledgeSteering")(function* (
    threadId: ThreadId,
    revision: number,
  ) {
    yield* sql`DELETE FROM agent_execution_steering WHERE thread_id = ${threadId} AND revision = ${revision}`;
  }, Effect.mapError(storageError));

  const recordCommunication = Effect.fn("AgentExecutionStore.recordCommunication")(function* (
    raw: AgentCommunicationInput,
    observedAt?: DateTime.Utc,
  ) {
    const input = yield* decodeCommunicationInput(raw).pipe(
      Effect.mapError((cause) => new AgentExecutionError({ reason: "invalid-input", cause })),
    );
    const request = yield* encodeCommunicationInput(input);
    const result = yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly request_json: string;
          readonly payload_json: string;
        }>`SELECT request_json, payload_json FROM agent_communications WHERE source_environment_id = ${input.source.environmentId} AND source_thread_id = ${input.source.threadId} AND id = ${input.id}`;
        const row = rows[0];
        if (row !== undefined) {
          if (row.request_json !== request)
            return yield* new AgentExecutionError({ reason: "command-conflict" });
          return { communication: yield* decodeCommunication(row.payload_json), duplicate: true };
        }
        const communication: AgentCommunication = {
          ...input,
          occurredAt: DateTime.formatIso(observedAt ?? (yield* DateTime.now)),
        };
        const payload = yield* encodeCommunication(communication);
        yield* sql`INSERT INTO agent_communications (id, source_environment_id, source_thread_id, target_environment_id, target_thread_id, request_json, payload_json)
        VALUES (${input.id}, ${input.source.environmentId}, ${input.source.threadId}, ${input.target.environmentId}, ${input.target.threadId}, ${request}, ${payload})`;
        return { communication, duplicate: false };
      }),
    );
    if (!result.duplicate) yield* PubSub.publish(changes, undefined);
    return result.communication;
  }, Effect.mapError(storageError));

  const communications = Effect.fn("AgentExecutionStore.communications")(function* (
    threads: ReadonlyArray<ScopedThreadRef>,
  ) {
    if (threads.length === 0) return [];
    const rows = yield* sql<{
      readonly payload_json: string;
    }>`SELECT payload_json FROM agent_communications WHERE ${sql.or(
      threads.flatMap((thread) => [
        sql`source_environment_id = ${thread.environmentId} AND source_thread_id = ${thread.threadId}`,
        sql`target_environment_id = ${thread.environmentId} AND target_thread_id = ${thread.threadId}`,
      ]),
    )} ORDER BY rowid DESC LIMIT 500`;
    return yield* Effect.forEach(rows.toReversed(), (row) => decodeCommunication(row.payload_json));
  }, Effect.mapError(storageError));

  return AgentExecutionStore.of({
    get,
    list,
    update,
    history,
    updateCheckpoint,
    pendingSteering,
    acknowledgeSteering,
    recordCommunication,
    communications,
    changes: Stream.fromPubSub(changes),
    subscribeChanges: PubSub.subscribe(changes),
  });
});

export const layer = Layer.effect(AgentExecutionStore, make);
