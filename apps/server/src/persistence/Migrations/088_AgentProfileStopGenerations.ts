import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(agent_profile_stops)`;
  if (!columns.some((column) => column.name === "settled_generation")) {
    yield* sql`ALTER TABLE agent_profile_stops ADD COLUMN settled_generation INTEGER NOT NULL DEFAULT 0 CHECK (settled_generation >= 0)`;
  }
  yield* sql`CREATE INDEX IF NOT EXISTS agent_profile_stops_pending_idx ON agent_profile_stops(thread_id) WHERE generation > settled_generation`;
});
