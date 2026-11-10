import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_profile_stops (
    thread_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL CHECK (generation > 0),
    settled_generation INTEGER NOT NULL DEFAULT 0 CHECK (settled_generation >= 0)
  )`;
  yield* sql`CREATE INDEX agent_profile_stops_pending_idx ON agent_profile_stops(thread_id) WHERE generation > settled_generation`;
});
