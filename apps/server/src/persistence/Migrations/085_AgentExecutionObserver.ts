import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_execution_observer (id INTEGER PRIMARY KEY CHECK (id = 1), sequence INTEGER NOT NULL)`;
  yield* sql`INSERT INTO agent_execution_observer (id, sequence) VALUES (1, 0)`;
});
