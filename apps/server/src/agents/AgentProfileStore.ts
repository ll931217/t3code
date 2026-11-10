import {
  AgentProfile,
  AgentProfileError,
  AgentProfileSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentProfile));
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentProfileSnapshot));
const encodeProfile = Schema.encodeEffect(Schema.fromJsonString(AgentProfile));
const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(AgentProfileSnapshot));
const isProfileError = Schema.is(AgentProfileError);
const storageError = (cause: unknown) =>
  isProfileError(cause) ? cause : new AgentProfileError({ reason: "storage", cause });

export class AgentProfileStore extends Context.Service<
  AgentProfileStore,
  {
    readonly personal: () => Effect.Effect<ReadonlyArray<AgentProfile>, AgentProfileError>;
    readonly savePersonal: (profile: AgentProfile) => Effect.Effect<void, AgentProfileError>;
    readonly removePersonal: (profileId: string) => Effect.Effect<void, AgentProfileError>;
    readonly trust: (snapshot: AgentProfileSnapshot) => Effect.Effect<void, AgentProfileError>;
    readonly inherit: (
      parentId: string,
      snapshot: AgentProfileSnapshot,
    ) => Effect.Effect<void, AgentProfileError>;
    readonly getSnapshot: (
      id: string,
    ) => Effect.Effect<AgentProfileSnapshot | null, AgentProfileError>;
    readonly status: (
      id: string,
    ) => Effect.Effect<{ readonly trusted: boolean; readonly revoked: boolean }, AgentProfileError>;
    readonly pin: (
      threadId: ThreadId,
      snapshotId: string,
      replace: boolean,
    ) => Effect.Effect<void, AgentProfileError>;
    readonly forThread: (
      threadId: ThreadId,
    ) => Effect.Effect<AgentProfileSnapshot | null, AgentProfileError>;
    readonly revoke: (id: string) => Effect.Effect<ReadonlyArray<ThreadId>, AgentProfileError>;
  }
>()("t3/agents/AgentProfileStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const getSnapshot = Effect.fn("AgentProfileStore.getSnapshot")(function* (id: string) {
    const rows = yield* sql<{
      readonly document: string;
    }>`SELECT document FROM agent_profile_snapshots WHERE id = ${id}`;
    return rows[0] ? yield* decodeSnapshot(rows[0].document) : null;
  }, Effect.mapError(storageError));

  const status = Effect.fn("AgentProfileStore.status")(function* (id: string) {
    const rows = yield* sql<{ readonly revoked: number }>`
      SELECT MAX(v.revoked) AS revoked FROM agent_profile_snapshot_versions AS sv
      JOIN agent_profile_versions AS v ON v.fingerprint = sv.fingerprint
      WHERE sv.snapshot_id = ${id}`;
    const trusted = yield* sql<{
      readonly revoked: number;
    }>`SELECT revoked FROM agent_profile_snapshots WHERE id = ${id}`;
    return {
      trusted: trusted.length > 0,
      revoked: trusted[0]?.revoked === 1 || rows[0]?.revoked === 1,
    };
  }, Effect.mapError(storageError));

  return AgentProfileStore.of({
    personal: Effect.fn("AgentProfileStore.personal")(function* () {
      const rows = yield* sql<{
        readonly document: string;
      }>`SELECT document FROM agent_profiles ORDER BY id`;
      return yield* Effect.forEach(rows, (row) => decodeProfile(row.document));
    }, Effect.mapError(storageError)),
    savePersonal: Effect.fn("AgentProfileStore.savePersonal")(function* (profile) {
      const document = yield* encodeProfile(profile);
      yield* sql`INSERT INTO agent_profiles (id, document) VALUES (${profile.id}, ${document})
        ON CONFLICT(id) DO UPDATE SET document = excluded.document`;
    }, Effect.mapError(storageError)),
    removePersonal: Effect.fn("AgentProfileStore.removePersonal")(function* (profileId) {
      yield* sql`DELETE FROM agent_profiles WHERE id = ${profileId}`;
    }, Effect.mapError(storageError)),
    trust: Effect.fn("AgentProfileStore.trust")(function* (snapshot) {
      const document = yield* encodeSnapshot(snapshot);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const version of [snapshot.root, ...snapshot.dependencies]) {
            yield* sql`INSERT INTO agent_profile_versions (fingerprint, revoked) VALUES (${version.fingerprint}, 0)
            ON CONFLICT(fingerprint) DO NOTHING`;
          }
          yield* sql`UPDATE agent_profile_versions SET revoked = 0 WHERE fingerprint = ${snapshot.root.fingerprint}`;
          yield* sql`INSERT INTO agent_profile_snapshots (id, document) VALUES (${snapshot.id}, ${document})
          ON CONFLICT(id) DO UPDATE SET revoked = 0`;
          for (const version of [snapshot.root, ...snapshot.dependencies]) {
            yield* sql`INSERT INTO agent_profile_snapshot_versions (snapshot_id, fingerprint)
            VALUES (${snapshot.id}, ${version.fingerprint}) ON CONFLICT DO NOTHING`;
          }
        }),
      );
    }, Effect.mapError(storageError)),
    inherit: Effect.fn("AgentProfileStore.inherit")(function* (parentId, snapshot) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const parentStatus = yield* status(parentId);
          const childStatus = yield* status(snapshot.id);
          if (!parentStatus.trusted || parentStatus.revoked || childStatus.revoked)
            return yield* new AgentProfileError({
              reason: parentStatus.revoked || childStatus.revoked ? "revoked" : "untrusted",
            });
          const document = yield* encodeSnapshot(snapshot);
          yield* sql`INSERT INTO agent_profile_snapshots (id, document) VALUES (${snapshot.id}, ${document}) ON CONFLICT DO NOTHING`;
          for (const version of [snapshot.root, ...snapshot.dependencies]) {
            yield* sql`INSERT INTO agent_profile_snapshot_versions (snapshot_id, fingerprint) VALUES (${snapshot.id}, ${version.fingerprint}) ON CONFLICT DO NOTHING`;
          }
        }),
      );
    }, Effect.mapError(storageError)),
    getSnapshot,
    status,
    pin: Effect.fn("AgentProfileStore.pin")(function* (threadId, snapshotId, replace) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const currentStatus = yield* status(snapshotId);
          if (!currentStatus.trusted || currentStatus.revoked) {
            return yield* new AgentProfileError({
              reason: currentStatus.revoked ? "revoked" : "untrusted",
            });
          }
          if (replace) {
            const pending =
              yield* sql`SELECT thread_id FROM agent_profile_stops WHERE thread_id = ${threadId} AND generation > settled_generation`;
            if (pending.length > 0)
              return yield* new AgentProfileError({ reason: "snapshot-conflict" });
          }
          const rows = yield* sql<{
            readonly snapshot_id: string;
          }>`SELECT snapshot_id FROM agent_profile_threads WHERE thread_id = ${threadId}`;
          if (!replace && rows[0] && rows[0].snapshot_id !== snapshotId) {
            return yield* new AgentProfileError({ reason: "snapshot-conflict" });
          }
          if (!replace && rows.length === 0) {
            const existing =
              yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
            if (existing.length > 0)
              return yield* new AgentProfileError({ reason: "snapshot-conflict" });
          }
          yield* sql`INSERT INTO agent_profile_threads (thread_id, snapshot_id) VALUES (${threadId}, ${snapshotId})
          ON CONFLICT(thread_id) DO UPDATE SET snapshot_id = excluded.snapshot_id`;
        }),
      );
    }, Effect.mapError(storageError)),
    forThread: Effect.fn("AgentProfileStore.forThread")(function* (threadId) {
      const rows = yield* sql<{
        readonly snapshot_id: string;
      }>`SELECT snapshot_id FROM agent_profile_threads WHERE thread_id = ${threadId}`;
      return rows[0] ? yield* getSnapshot(rows[0].snapshot_id) : null;
    }, Effect.mapError(storageError)),
    revoke: Effect.fn("AgentProfileStore.revoke")(function* (id) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const snapshot = yield* getSnapshot(id);
          if (snapshot === null) return yield* new AgentProfileError({ reason: "not-found" });
          yield* sql`UPDATE agent_profile_versions SET revoked = 1 WHERE fingerprint = ${snapshot.root.fingerprint}`;
          yield* sql`UPDATE agent_profile_snapshots SET revoked = 1 WHERE id IN (
            SELECT snapshot_id FROM agent_profile_snapshot_versions WHERE fingerprint = ${snapshot.root.fingerprint}
          )`;
          const rows = yield* sql<{
            readonly thread_id: string;
          }>`SELECT DISTINCT t.thread_id FROM agent_profile_threads AS t
          JOIN agent_profile_snapshot_versions AS sv ON sv.snapshot_id = t.snapshot_id
          WHERE sv.fingerprint = ${snapshot.root.fingerprint}`;
          for (const row of rows) {
            yield* sql`INSERT INTO agent_profile_stops (thread_id, generation) VALUES (${row.thread_id}, 1)
              ON CONFLICT(thread_id) DO UPDATE SET generation = generation + 1`;
          }
          return rows.map((row) => ThreadId.make(row.thread_id));
        }),
      );
    }, Effect.mapError(storageError)),
  });
});

export const layer = Layer.effect(AgentProfileStore, make);
