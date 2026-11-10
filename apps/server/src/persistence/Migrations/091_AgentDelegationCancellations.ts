import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_delegation_cancellations (child_key TEXT PRIMARY KEY, environment_id TEXT NOT NULL, thread_id TEXT NOT NULL, command_id TEXT NOT NULL, generation INTEGER NOT NULL, settled_generation INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`CREATE TABLE agent_delegation_cancellation_receipts (child_key TEXT NOT NULL, command_id TEXT NOT NULL, PRIMARY KEY (child_key, command_id))`;
  yield* sql`CREATE INDEX agent_delegation_cancellations_pending_idx ON agent_delegation_cancellations(child_key) WHERE generation > settled_generation`;
});
