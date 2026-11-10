import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_profiles (id TEXT PRIMARY KEY, document TEXT NOT NULL)`;
  yield* sql`CREATE TABLE agent_profile_versions (
    fingerprint TEXT PRIMARY KEY,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
  )`;
  yield* sql`CREATE TABLE agent_profile_snapshots (
    id TEXT PRIMARY KEY,
    document TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
  )`;
  yield* sql`CREATE TABLE agent_profile_snapshot_versions (
    snapshot_id TEXT NOT NULL REFERENCES agent_profile_snapshots(id),
    fingerprint TEXT NOT NULL REFERENCES agent_profile_versions(fingerprint),
    PRIMARY KEY (snapshot_id, fingerprint)
  )`;
  yield* sql`CREATE INDEX agent_profile_snapshot_version_lookup
    ON agent_profile_snapshot_versions(fingerprint, snapshot_id)`;
  yield* sql`CREATE TABLE agent_profile_threads (
    thread_id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES agent_profile_snapshots(id)
  )`;
  yield* sql`CREATE INDEX agent_profile_thread_snapshot_lookup ON agent_profile_threads(snapshot_id)`;
});
