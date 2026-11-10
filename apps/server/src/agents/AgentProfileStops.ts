import { AgentProfileError, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

export interface AgentProfileStop {
  readonly threadId: ThreadId;
  readonly generation: number;
}

export class AgentProfileStops extends Context.Service<
  AgentProfileStops,
  {
    readonly pending: () => Effect.Effect<ReadonlyArray<AgentProfileStop>, AgentProfileError>;
    readonly assertSettled: (threadId: ThreadId) => Effect.Effect<void, AgentProfileError>;
    readonly acknowledge: (stop: AgentProfileStop) => Effect.Effect<void, AgentProfileError>;
  }
>()("t3/agents/AgentProfileStops") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return AgentProfileStops.of({
    assertSettled: Effect.fn("AgentProfileStops.assertSettled")(function* (threadId) {
      const rows =
        yield* sql`SELECT thread_id FROM agent_profile_stops WHERE thread_id = ${threadId} AND generation > settled_generation`.pipe(
          Effect.mapError((cause) => new AgentProfileError({ reason: "storage", cause })),
        );
      if (rows.length > 0) return yield* new AgentProfileError({ reason: "snapshot-conflict" });
    }),
    pending: Effect.fn("AgentProfileStops.pending")(
      function* () {
        const rows = yield* sql<{ readonly thread_id: string; readonly generation: number }>`
        SELECT thread_id, generation FROM agent_profile_stops WHERE generation > settled_generation ORDER BY thread_id`;
        return rows.map((row) => ({
          threadId: ThreadId.make(row.thread_id),
          generation: row.generation,
        }));
      },
      Effect.mapError((cause) => new AgentProfileError({ reason: "storage", cause })),
    ),
    acknowledge: Effect.fn("AgentProfileStops.acknowledge")(
      function* (stop) {
        yield* sql`UPDATE agent_profile_stops SET settled_generation = ${stop.generation} WHERE thread_id = ${stop.threadId} AND generation = ${stop.generation}`;
      },
      Effect.mapError((cause) => new AgentProfileError({ reason: "storage", cause })),
    ),
  });
});

export const layer = Layer.effect(AgentProfileStops, make);
