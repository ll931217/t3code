import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_delegation_trees (root_key TEXT PRIMARY KEY, limits_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE agent_delegation_reservations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    command_key TEXT NOT NULL UNIQUE,
    child_key TEXT NOT NULL UNIQUE,
    root_key TEXT NOT NULL,
    request_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    queue_order INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX agent_delegation_queue ON agent_delegation_reservations (root_key, status, queue_order)`;
});
