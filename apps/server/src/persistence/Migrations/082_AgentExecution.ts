import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_execution_records (
    thread_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE agent_execution_history (
    thread_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (thread_id, revision)
  )`;
  yield* sql`CREATE TABLE agent_execution_receipts (
    command_id TEXT PRIMARY KEY,
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE agent_execution_steering (
    thread_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (thread_id, revision)
  )`;
  yield* sql`CREATE TABLE agent_communications (
    id TEXT NOT NULL,
    source_environment_id TEXT NOT NULL,
    source_thread_id TEXT NOT NULL,
    target_environment_id TEXT NOT NULL,
    target_thread_id TEXT NOT NULL,
    request_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (source_environment_id, source_thread_id, id)
  )`;
  yield* sql`CREATE INDEX agent_communications_source ON agent_communications (source_environment_id, source_thread_id)`;
  yield* sql`CREATE INDEX agent_communications_target ON agent_communications (target_environment_id, target_thread_id)`;
});
