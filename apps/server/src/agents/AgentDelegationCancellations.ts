import { CommandId, EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { AgentDelegationError } from "./AgentDelegationStore.ts";

export interface AgentDelegationCancellation {
  readonly child: ScopedThreadRef;
  readonly commandId: CommandId;
  readonly generation: number;
}
export class AgentDelegationCancellations extends Context.Service<
  AgentDelegationCancellations,
  {
    readonly request: (
      child: ScopedThreadRef,
      commandId: CommandId,
    ) => Effect.Effect<AgentDelegationCancellation, AgentDelegationError>;
    readonly requested: (child: ScopedThreadRef) => Effect.Effect<boolean, AgentDelegationError>;
    readonly pending: () => Effect.Effect<
      readonly AgentDelegationCancellation[],
      AgentDelegationError
    >;
    readonly acknowledge: (
      request: AgentDelegationCancellation,
    ) => Effect.Effect<void, AgentDelegationError>;
  }
>()("t3/agents/AgentDelegationCancellations") {}

const key = (child: ScopedThreadRef) => JSON.stringify([child.environmentId, child.threadId]);
const failure = (cause: unknown) => new AgentDelegationError({ reason: "storage", cause });
interface Row {
  readonly environment_id: string;
  readonly thread_id: string;
  readonly command_id: string;
  readonly generation: number;
}
const fromRow = (row: Row): AgentDelegationCancellation => ({
  child: {
    environmentId: EnvironmentId.make(row.environment_id),
    threadId: ThreadId.make(row.thread_id),
  },
  commandId: CommandId.make(row.command_id),
  generation: row.generation,
});
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return AgentDelegationCancellations.of({
    request: Effect.fn("AgentDelegationCancellations.request")(function* (child, commandId) {
      const childKey = key(child);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const receipts =
            yield* sql`SELECT command_id FROM agent_delegation_cancellation_receipts WHERE child_key = ${childKey} AND command_id = ${commandId}`;
          if (receipts.length === 0) {
            yield* sql`INSERT INTO agent_delegation_cancellations (child_key, environment_id, thread_id, command_id, generation) VALUES (${childKey}, ${child.environmentId}, ${child.threadId}, ${commandId}, 1) ON CONFLICT(child_key) DO UPDATE SET command_id = excluded.command_id, generation = generation + 1`;
            yield* sql`INSERT INTO agent_delegation_cancellation_receipts (child_key, command_id) VALUES (${childKey}, ${commandId})`;
          }
          const rows =
            yield* sql<Row>`SELECT environment_id, thread_id, command_id, generation FROM agent_delegation_cancellations WHERE child_key = ${childKey}`;
          return fromRow(rows[0]!);
        }),
      );
    }, Effect.mapError(failure)),
    requested: Effect.fn("AgentDelegationCancellations.requested")(function* (child) {
      const rows =
        yield* sql`SELECT child_key FROM agent_delegation_cancellations WHERE child_key = ${key(child)}`;
      return rows.length > 0;
    }, Effect.mapError(failure)),
    pending: Effect.fn("AgentDelegationCancellations.pending")(function* () {
      const rows =
        yield* sql<Row>`SELECT environment_id, thread_id, command_id, generation FROM agent_delegation_cancellations WHERE generation > settled_generation ORDER BY child_key`;
      return rows.map(fromRow);
    }, Effect.mapError(failure)),
    acknowledge: Effect.fn("AgentDelegationCancellations.acknowledge")(function* (request) {
      yield* sql`UPDATE agent_delegation_cancellations SET settled_generation = ${request.generation} WHERE child_key = ${key(request.child)} AND generation = ${request.generation}`;
    }, Effect.mapError(failure)),
  });
});
export const layer = Layer.effect(AgentDelegationCancellations, make);
