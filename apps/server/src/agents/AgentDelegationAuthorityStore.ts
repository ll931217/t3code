import {
  AgentDelegationGrant,
  AgentDelegationReservation,
  AgentProfileSnapshot,
  ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { AgentDelegationError } from "./AgentDelegationStore.ts";

const encodeGrant = Schema.encodeEffect(Schema.fromJsonString(AgentDelegationGrant));
const decodeGrant = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentDelegationGrant));
const encodeRequest = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ reservation: AgentDelegationReservation, snapshot: AgentProfileSnapshot }),
  ),
);
const key = (ref: ScopedThreadRef) =>
  `${ref.environmentId.length}:${ref.environmentId}${ref.threadId}`;
const isError = Schema.is(AgentDelegationError);
const storageError = (cause: unknown) =>
  isError(cause) ? cause : new AgentDelegationError({ reason: "storage", cause });
export class AgentDelegationAuthorityStore extends Context.Service<
  AgentDelegationAuthorityStore,
  {
    readonly issue: (
      reservation: AgentDelegationReservation,
      snapshot: AgentProfileSnapshot,
    ) => Effect.Effect<AgentDelegationGrant, AgentDelegationError>;
    readonly byToken: (
      token: string,
    ) => Effect.Effect<AgentDelegationGrant | null, AgentDelegationError>;
    readonly byChild: (
      child: ScopedThreadRef,
    ) => Effect.Effect<AgentDelegationGrant | null, AgentDelegationError>;
    readonly accept: (
      grant: AgentDelegationGrant,
      peerSessionId: string,
      projectId: ProjectId,
    ) => Effect.Effect<void, AgentDelegationError>;
    readonly inbound: (child: ScopedThreadRef) => Effect.Effect<
      {
        readonly grant: AgentDelegationGrant;
        readonly peerSessionId: string;
        readonly projectId: ProjectId;
      } | null,
      AgentDelegationError
    >;
    readonly pendingNotifications: () => Effect.Effect<
      readonly { readonly grant: AgentDelegationGrant; readonly generation: number }[],
      AgentDelegationError
    >;
    readonly markNotified: (
      token: string,
      notified: boolean,
      generation?: number,
    ) => Effect.Effect<void, AgentDelegationError>;
  }
>()("t3/agents/AgentDelegationAuthorityStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const byToken = Effect.fn("AgentDelegationAuthorityStore.byToken")(function* (token: string) {
    const rows = yield* sql<{
      payload_json: string;
    }>`SELECT payload_json FROM agent_delegation_grants WHERE token = ${token}`;
    return rows[0] ? yield* decodeGrant(rows[0].payload_json) : null;
  }, Effect.mapError(storageError));
  return AgentDelegationAuthorityStore.of({
    byToken,
    byChild: Effect.fn("AgentDelegationAuthorityStore.byChild")(function* (child) {
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM agent_delegation_grants WHERE child_key = ${key(child)}`;
      return rows[0] ? yield* decodeGrant(rows[0].payload_json) : null;
    }, Effect.mapError(storageError)),
    issue: Effect.fn("AgentDelegationAuthorityStore.issue")(function* (reservation, snapshot) {
      if (reservation.snapshotId !== snapshot.id)
        return yield* new AgentDelegationError({ reason: "invalid-input" });
      const request = yield* encodeRequest({
        reservation: { ...reservation, status: "queued" },
        snapshot,
      });
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            request_json: string;
            payload_json: string;
          }>`SELECT request_json, payload_json FROM agent_delegation_grants WHERE child_key = ${key(reservation.child)}`;
          if (rows[0]) {
            if (rows[0].request_json !== request)
              return yield* new AgentDelegationError({ reason: "command-conflict" });
            return yield* decodeGrant(rows[0].payload_json);
          }
          const grant = { reservation, snapshot, token: yield* random.uuidV4() };
          const document = yield* encodeGrant(grant);
          yield* sql`INSERT INTO agent_delegation_grants (child_key, token, request_json, payload_json) VALUES (${key(reservation.child)}, ${grant.token}, ${request}, ${document})`;
          return grant;
        }),
      );
    }, Effect.mapError(storageError)),
    accept: Effect.fn("AgentDelegationAuthorityStore.accept")(function* (
      grant,
      peerSessionId,
      projectId,
    ) {
      const document = yield* encodeGrant(grant);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            peer_session_id: string;
            project_id: string;
            payload_json: string;
          }>`SELECT peer_session_id, project_id, payload_json FROM agent_delegation_inbound WHERE child_key = ${key(grant.reservation.child)}`;
          if (rows[0]) {
            const existing = yield* decodeGrant(rows[0].payload_json);
            if (
              rows[0].peer_session_id !== peerSessionId ||
              rows[0].project_id !== projectId ||
              existing.token !== grant.token ||
              existing.snapshot.id !== grant.snapshot.id
            )
              return yield* new AgentDelegationError({ reason: "authority-conflict" });
          }
          yield* sql`INSERT INTO agent_delegation_inbound (child_key, peer_session_id, project_id, payload_json) VALUES (${key(grant.reservation.child)}, ${peerSessionId}, ${projectId}, ${document}) ON CONFLICT(child_key) DO UPDATE SET payload_json = excluded.payload_json`;
        }),
      );
    }, Effect.mapError(storageError)),
    inbound: Effect.fn("AgentDelegationAuthorityStore.inbound")(function* (child) {
      const rows = yield* sql<{
        peer_session_id: string;
        project_id: string;
        payload_json: string;
      }>`SELECT peer_session_id, project_id, payload_json FROM agent_delegation_inbound WHERE child_key = ${key(child)}`;
      return rows[0]
        ? {
            grant: yield* decodeGrant(rows[0].payload_json),
            peerSessionId: rows[0].peer_session_id,
            projectId: ProjectId.make(rows[0].project_id),
          }
        : null;
    }, Effect.mapError(storageError)),
    pendingNotifications: Effect.fn("AgentDelegationAuthorityStore.pendingNotifications")(
      function* () {
        const rows = yield* sql<{
          payload_json: string;
          generation: number;
        }>`SELECT g.payload_json, g.generation FROM agent_delegation_grants g JOIN agent_delegation_reservations r ON r.child_key = g.child_key WHERE g.notified = 0 AND r.status = 'active' ORDER BY g.rowid`;
        return yield* Effect.forEach(rows, (row) =>
          decodeGrant(row.payload_json).pipe(
            Effect.map((grant) => ({ grant, generation: row.generation })),
          ),
        );
      },
      Effect.mapError(storageError),
    ),
    markNotified: Effect.fn("AgentDelegationAuthorityStore.markNotified")(function* (
      token,
      notified,
      generation,
    ) {
      if (!notified) {
        yield* sql`UPDATE agent_delegation_grants SET notified = 0, generation = generation + 1 WHERE token = ${token}`;
      } else {
        if (generation === undefined)
          return yield* new AgentDelegationError({ reason: "invalid-input" });
        yield* sql`UPDATE agent_delegation_grants SET notified = 1 WHERE token = ${token} AND generation = ${generation}`;
      }
    }, Effect.mapError(storageError)),
  });
});

export const layer = Layer.effect(AgentDelegationAuthorityStore, make);
