import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { AgentProfileSnapshot, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Delegations from "./AgentDelegationStore.ts";
import * as AuthorityStore from "./AgentDelegationAuthorityStore.ts";

const snapshot = Schema.decodeSync(AgentProfileSnapshot)({
  id: "snapshot",
  root: {
    fingerprint: "version",
    sourceProjectId: null,
    profile: {
      id: "personal/worker",
      name: "Worker",
      description: "",
      prompt: "Task",
      modelSelection: { instanceId: "codex", model: "test" },
      permissions: {
        filesystem: "read-only",
        commands: false,
        network: false,
        writablePaths: [],
        nativeTools: [],
        mcpTools: [],
        approvalPolicy: "never",
        integrations: { commit: false, merge: false, publish: false },
      },
      delegation: { profiles: [], maxConcurrent: 4, maxAgents: 16, maxDepth: 3 },
      isolation: "shared",
    },
  },
  dependencies: [],
});
const root = { environmentId: EnvironmentId.make("root-env"), threadId: ThreadId.make("root") };
const reservation = {
  commandId: "reserve",
  root,
  parent: root,
  child: { environmentId: EnvironmentId.make("remote-env"), threadId: ThreadId.make("child") },
  snapshotId: snapshot.id,
  requestKey: "request",
  limits: { maxConcurrent: 4, maxAgents: 16, maxDepth: 3 },
  depth: 1,
  status: "queued" as const,
};
it.layer(
  Layer.merge(AuthorityStore.layer, Delegations.layer).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
  ),
)("AgentDelegationAuthorityStore", (it) => {
  it.effect(
    "keeps grants stable on retries and binds incoming grants to their authenticated link",
    () =>
      Effect.gen(function* () {
        const store = yield* AuthorityStore.AgentDelegationAuthorityStore;
        yield* (yield* Delegations.AgentDelegationStore).reserve(reservation);
        const first = yield* store.issue(reservation, snapshot);
        assert.strictEqual((yield* store.pendingNotifications())[0]?.generation, 1);
        yield* store.markNotified(first.token, false);
        yield* store.markNotified(first.token, true, 1);
        assert.strictEqual((yield* store.pendingNotifications())[0]?.generation, 2);
        yield* store.markNotified(first.token, true, 2);
        assert.deepStrictEqual(yield* store.pendingNotifications(), []);
        assert.deepStrictEqual(yield* store.issue(reservation, snapshot), first);
        assert.strictEqual(
          (yield* store
            .issue({ ...reservation, requestKey: "changed" }, snapshot)
            .pipe(Effect.flip)).reason,
          "command-conflict",
        );
        yield* store.accept(first, "peer-session", ProjectId.make("destination"));
        yield* store.accept(first, "peer-session", ProjectId.make("destination"));
        assert.strictEqual(
          (yield* store
            .accept(first, "other-peer", ProjectId.make("destination"))
            .pipe(Effect.flip)).reason,
          "authority-conflict",
        );
        yield* Effect.gen(function* () {
          const reopened = yield* AuthorityStore.AgentDelegationAuthorityStore;
          assert.deepStrictEqual(yield* reopened.byToken(first.token), first);
          assert.deepStrictEqual(yield* reopened.byChild(reservation.child), first);
          assert.strictEqual(
            yield* reopened.byChild({ ...reservation.child, environmentId: root.environmentId }),
            null,
          );
          assert.strictEqual(
            (yield* reopened.inbound(reservation.child))?.grant.token,
            first.token,
          );
        }).pipe(Effect.provide(AuthorityStore.layer));
      }),
  );
});
