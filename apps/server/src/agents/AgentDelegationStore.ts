import {
  AgentDelegationLimits,
  AgentDelegationReservation,
  ScopedThreadRef,
  RunId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";

const PendingStart = Schema.Struct({ child: ScopedThreadRef, runId: RunId });
type PendingStart = typeof PendingStart.Type;
type PendingStartReceipt = PendingStart & { readonly generation: number };
const encodeStart = Schema.encodeEffect(Schema.fromJsonString(PendingStart));
const decodeStart = Schema.decodeUnknownEffect(Schema.fromJsonString(PendingStart));

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000));
const ReservationInput = Schema.Struct({
  commandId: Text,
  root: ScopedThreadRef,
  parent: ScopedThreadRef,
  child: ScopedThreadRef,
  snapshotId: Text,
  requestKey: Text,
  limits: AgentDelegationLimits,
});
const Reservation = AgentDelegationReservation;
type Reservation = typeof Reservation.Type;
const encode = Schema.encodeEffect(Schema.fromJsonString(Reservation));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Reservation));
const encodeInput = Schema.encodeEffect(Schema.fromJsonString(ReservationInput));
const decodeInput = Schema.decodeEffect(ReservationInput);
const encodeLimits = Schema.encodeEffect(Schema.fromJsonString(AgentDelegationLimits));
const decodeLimits = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentDelegationLimits));
const key = (ref: ScopedThreadRef) =>
  `${ref.environmentId.length}:${ref.environmentId}${ref.threadId}`;

export class AgentDelegationError extends Schema.TaggedError<AgentDelegationError>()(
  "AgentDelegationError",
  {
    reason: Schema.Literals([
      "storage",
      "invalid-input",
      "command-conflict",
      "authority-conflict",
      "invalid-parent",
      "depth-limit",
      "total-limit",
      "provider-not-suspended",
      "invalid-transition",
      "not-found",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Agent delegation failed: ${this.reason}.`;
  }
}
const isDelegationError = Schema.is(AgentDelegationError);
const mapError = (cause: unknown) =>
  isDelegationError(cause) ? cause : new AgentDelegationError({ reason: "storage", cause });

export class AgentDelegationStore extends Context.Service<
  AgentDelegationStore,
  {
    readonly reserve: (
      input: typeof ReservationInput.Type,
    ) => Effect.Effect<Reservation, AgentDelegationError>;
    readonly get: (
      child: ScopedThreadRef,
    ) => Effect.Effect<Reservation | null, AgentDelegationError>;
    readonly list: (
      root: ScopedThreadRef,
    ) => Effect.Effect<readonly Reservation[], AgentDelegationError>;
    readonly transition: (
      child: ScopedThreadRef,
      status: "active" | "waiting" | "completed" | "cancelled",
      providerSuspended: boolean,
    ) => Effect.Effect<Reservation, AgentDelegationError>;
    readonly admitQueued: (
      root: ScopedThreadRef,
    ) => Effect.Effect<readonly Reservation[], AgentDelegationError>;
    readonly live: () => Effect.Effect<readonly Reservation[], AgentDelegationError>;
    readonly mirror: (reservation: Reservation) => Effect.Effect<void, AgentDelegationError>;
    readonly deferStart: (input: PendingStart) => Effect.Effect<void, AgentDelegationError>;
    readonly pendingStarts: () => Effect.Effect<
      readonly PendingStartReceipt[],
      AgentDelegationError
    >;
    readonly acknowledgeStart: (
      input: PendingStartReceipt,
    ) => Effect.Effect<void, AgentDelegationError>;
    readonly changes: Stream.Stream<void>;
    readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
  }
>()("t3/agents/AgentDelegationStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.sliding<void>(1);
  const get = Effect.fn("AgentDelegationStore.get")(function* (child: ScopedThreadRef) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM agent_delegation_reservations WHERE child_key = ${key(child)}`;
    return rows[0] ? yield* decode(rows[0].payload_json) : null;
  }, Effect.mapError(mapError));
  const list = Effect.fn("AgentDelegationStore.list")(function* (root: ScopedThreadRef) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM agent_delegation_reservations WHERE root_key = ${key(root)} ORDER BY queue_order, sequence`;
    return yield* Effect.forEach(rows, (row) => decode(row.payload_json));
  }, Effect.mapError(mapError));
  const persist = Effect.fn("AgentDelegationStore.persist")(function* (
    record: Reservation,
    requeue = false,
  ) {
    const document = yield* encode(record);
    yield* sql`UPDATE agent_delegation_reservations SET payload_json = ${document}, status = ${record.status},
      queue_order = CASE WHEN ${requeue ? 1 : 0} = 1 THEN (SELECT COALESCE(MAX(queue_order), 0) + 1 FROM agent_delegation_reservations) ELSE queue_order END
      WHERE child_key = ${key(record.child)}`;
    return record;
  });
  const reserve = Effect.fn("AgentDelegationStore.reserve")(function* (
    raw: typeof ReservationInput.Type,
  ) {
    const input = yield* decodeInput(raw).pipe(
      Effect.mapError((cause) => new AgentDelegationError({ reason: "invalid-input", cause })),
    );
    const request = yield* encodeInput(input);
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const parentKey = key(input.parent);
        const commandKey = `${parentKey.length}:${parentKey}${input.commandId}`;
        const receipts = yield* sql<{
          request_json: string;
          payload_json: string;
        }>`SELECT request_json, payload_json FROM agent_delegation_reservations WHERE command_key = ${commandKey}`;
        if (receipts[0]) {
          if (receipts[0].request_json !== request)
            return yield* new AgentDelegationError({ reason: "command-conflict" });
          return yield* decode(receipts[0].payload_json);
        }
        if (key(input.child) === key(input.root) || (yield* get(input.child)) !== null)
          return yield* new AgentDelegationError({ reason: "invalid-input" });
        const parent = key(input.parent) === key(input.root) ? null : yield* get(input.parent);
        if (
          key(input.parent) !== key(input.root) &&
          (parent === null || key(parent.root) !== key(input.root) || parent.status !== "active")
        )
          return yield* new AgentDelegationError({ reason: "invalid-parent" });
        if (key(input.parent) === key(input.root) && (yield* get(input.root)) !== null)
          return yield* new AgentDelegationError({ reason: "authority-conflict" });
        const limitsJson = yield* encodeLimits(input.limits);
        const trees = yield* sql<{
          limits_json: string;
        }>`SELECT limits_json FROM agent_delegation_trees WHERE root_key = ${key(input.root)}`;
        if (trees[0] && trees[0].limits_json !== limitsJson)
          return yield* new AgentDelegationError({ reason: "authority-conflict" });
        const depth = (parent?.depth ?? 0) + 1;
        if (depth > input.limits.maxDepth)
          return yield* new AgentDelegationError({ reason: "depth-limit" });
        const existing = yield* list(input.root);
        if (existing.length >= input.limits.maxAgents)
          return yield* new AgentDelegationError({ reason: "total-limit" });
        const status =
          existing.filter((item) => item.status === "active").length < input.limits.maxConcurrent &&
          !existing.some((item) => item.status === "queued")
            ? "active"
            : "queued";
        const record: Reservation = { ...input, depth, status };
        const document = yield* encode(record);
        yield* sql`INSERT INTO agent_delegation_trees (root_key, limits_json) VALUES (${key(input.root)}, ${limitsJson}) ON CONFLICT DO NOTHING`;
        yield* sql`INSERT INTO agent_delegation_reservations (command_key, child_key, root_key, request_json, payload_json, status, queue_order)
        VALUES (${commandKey}, ${key(input.child)}, ${key(input.root)}, ${request}, ${document}, ${status}, (SELECT COALESCE(MAX(queue_order), 0) + 1 FROM agent_delegation_reservations))`;
        return record;
      }),
    );
  }, Effect.mapError(mapError));
  const transition = Effect.fn("AgentDelegationStore.transition")(function* (
    child: ScopedThreadRef,
    status: "active" | "waiting" | "completed" | "cancelled",
    providerSuspended: boolean,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* get(child);
        if (current === null) return yield* new AgentDelegationError({ reason: "not-found" });
        if (current.status === status) return current;
        if (
          current.status === "cancelled" ||
          (current.status === "completed" && status !== "active" && status !== "cancelled")
        )
          return yield* new AgentDelegationError({ reason: "invalid-transition" });
        if (
          (current.status === "active" ||
            (current.status === "completed" && status === "cancelled")) &&
          !providerSuspended
        )
          return yield* new AgentDelegationError({ reason: "provider-not-suspended" });
        if (status === "active") {
          const records = yield* list(current.root);
          const available =
            records.filter((item) => item.status === "active").length <
            current.limits.maxConcurrent;
          const firstQueued = records.find((item) => item.status === "queued");
          const mayRun =
            available && (firstQueued === undefined || key(firstQueued.child) === key(child));
          return yield* persist(
            { ...current, status: mayRun ? "active" : "queued" },
            current.status !== "queued",
          );
        }
        return yield* persist({ ...current, status });
      }),
    );
  }, Effect.mapError(mapError));
  const admitQueued = Effect.fn("AgentDelegationStore.admitQueued")(function* (
    root: ScopedThreadRef,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const trees = yield* sql<{
          limits_json: string;
        }>`SELECT limits_json FROM agent_delegation_trees WHERE root_key = ${key(root)}`;
        if (!trees[0]) return [];
        const limits = yield* decodeLimits(trees[0].limits_json);
        const records = yield* list(root);
        const available = Math.max(
          0,
          limits.maxConcurrent - records.filter((item) => item.status === "active").length,
        );
        return yield* Effect.forEach(
          records.filter((item) => item.status === "queued").slice(0, available),
          (item) => persist({ ...item, status: "active" }),
        );
      }),
    );
  }, Effect.mapError(mapError));
  return AgentDelegationStore.of({
    reserve,
    get,
    list,
    transition,
    admitQueued,
    mirror: Effect.fn("AgentDelegationStore.mirror")(function* (record) {
      const document = yield* encode(record);
      const request = yield* encodeInput(record);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* get(record.child);
          if (current !== null && (yield* encodeInput(current)) !== request)
            return yield* new AgentDelegationError({ reason: "authority-conflict" });
          yield* sql`INSERT INTO agent_delegation_reservations (command_key, child_key, root_key, request_json, payload_json, status, queue_order) VALUES (${`remote:${key(record.child)}`}, ${key(record.child)}, ${key(record.root)}, ${request}, ${document}, ${record.status}, (SELECT COALESCE(MAX(queue_order), 0) + 1 FROM agent_delegation_reservations)) ON CONFLICT(child_key) DO UPDATE SET payload_json = excluded.payload_json, status = excluded.status`;
        }),
      );
      yield* PubSub.publish(changes, undefined);
    }, Effect.mapError(mapError)),
    live: Effect.fn("AgentDelegationStore.live")(function* () {
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM agent_delegation_reservations WHERE status IN ('active', 'queued', 'waiting') ORDER BY sequence`;
      return yield* Effect.forEach(rows, (row) => decode(row.payload_json));
    }, Effect.mapError(mapError)),
    deferStart: Effect.fn("AgentDelegationStore.deferStart")(function* (input) {
      const document = yield* encodeStart(input);
      yield* sql`INSERT INTO agent_delegation_starts (child_key, run_id, payload_json) VALUES (${key(input.child)}, ${input.runId}, ${document}) ON CONFLICT(child_key, run_id) DO UPDATE SET generation = CASE WHEN agent_delegation_starts.generation = agent_delegation_starts.settled_generation THEN agent_delegation_starts.generation + 1 ELSE agent_delegation_starts.generation END`;
      yield* PubSub.publish(changes, undefined);
    }, Effect.mapError(mapError)),
    pendingStarts: Effect.fn("AgentDelegationStore.pendingStarts")(function* () {
      const rows = yield* sql<{
        payload_json: string;
        generation: number;
      }>`SELECT payload_json, generation FROM agent_delegation_starts WHERE generation > settled_generation ORDER BY rowid`;
      return yield* Effect.forEach(rows, (row) =>
        decodeStart(row.payload_json).pipe(
          Effect.map((input) => ({ ...input, generation: row.generation })),
        ),
      );
    }, Effect.mapError(mapError)),
    acknowledgeStart: Effect.fn("AgentDelegationStore.acknowledgeStart")(function* (input) {
      yield* sql`UPDATE agent_delegation_starts SET settled_generation = ${input.generation} WHERE child_key = ${key(input.child)} AND run_id = ${input.runId} AND generation = ${input.generation}`;
    }, Effect.mapError(mapError)),
    changes: Stream.fromPubSub(changes),
    subscribeChanges: PubSub.subscribe(changes),
  });
});

export const layer = Layer.effect(AgentDelegationStore, make);
