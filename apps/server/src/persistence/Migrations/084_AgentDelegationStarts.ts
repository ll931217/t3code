import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_delegation_starts (child_key TEXT NOT NULL, run_id TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY (child_key, run_id))`;
});
