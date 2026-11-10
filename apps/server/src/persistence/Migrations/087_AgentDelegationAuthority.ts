import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_delegation_grants (child_key TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL, payload_json TEXT NOT NULL, notified INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`CREATE TABLE agent_delegation_inbound (child_key TEXT PRIMARY KEY, peer_session_id TEXT NOT NULL, project_id TEXT NOT NULL, payload_json TEXT NOT NULL)`;
});
