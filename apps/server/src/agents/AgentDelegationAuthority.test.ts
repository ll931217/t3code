import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AgentProfileSnapshot,
  CommandId,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Identity from "../environment/ServerEnvironment.ts";
import * as Peer from "../peer/PeerMcpClient.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Profiles from "./AgentProfiles.ts";
import * as Store from "./AgentDelegationStore.ts";
import * as Grants from "./AgentDelegationAuthorityStore.ts";
import * as Authority from "./AgentDelegationAuthority.ts";

const snapshot = Schema.decodeSync(AgentProfileSnapshot)({
  id: "snapshot",
  root: {
    fingerprint: "version",
    sourceProjectId: null,
    profile: {
      id: "personal/orchestrator",
      name: "Orchestrator",
      description: "",
      prompt: "Coordinate",
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
      delegation: {
        profiles: ["personal/orchestrator"],
        maxConcurrent: 1,
        maxAgents: 3,
        maxDepth: 2,
      },
      isolation: "shared",
    },
  },
  dependencies: [],
});
const root = { environmentId: EnvironmentId.make("root-env"), threadId: ThreadId.make("root") };
const child = (id: string) => ({
  environmentId: EnvironmentId.make("remote-env"),
  threadId: ThreadId.make(id),
});
const projectId = ProjectId.make("destination");
const storage = Layer.mergeAll(Store.layer, Grants.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(NodeCrypto.layer),
);
const base = Layer.mergeAll(
  storage,
  Layer.succeed(Identity.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(root.environmentId),
  }),
  Layer.mock(Profiles.AgentProfiles)({
    getThreadSnapshot: () => Effect.succeed(snapshot),
    assertSnapshotAllowed: () => Effect.void,
  }),
  Layer.mock(Projects.ProjectStoreV2)({ get: () => Effect.succeedNone }),
  Layer.mock(Peer.PeerMcpClient)({
    call: ({ success }) => Schema.decodeEffect(success)(snapshot).pipe(Effect.orDie),
  }),
);
it.layer(Authority.layer.pipe(Layer.provideMerge(base)))("AgentDelegationAuthority", (it) => {
  it.effect(
    "keeps remote descendants inside the original root limits and requires suspension before release",
    () =>
      Effect.gen(function* () {
        const authority = yield* Authority.AgentDelegationAuthority;
        const store = yield* Store.AgentDelegationStore;
        const input = {
          parent: root,
          child: child("first"),
          projectId,
          snapshot,
          commandId: CommandId.make("first"),
          requestKey: "first",
        };
        const first = yield* authority.reserve(input);
        assert.strictEqual(first.reservation.status, "active");
        assert.strictEqual((yield* authority.reserve(input)).token, first.token);
        const second = yield* authority.reserve({
          ...input,
          child: child("second"),
          commandId: CommandId.make("second"),
          requestKey: "second",
        });
        assert.strictEqual(second.reservation.status, "queued");
        yield* authority
          .transition({ token: first.token, status: "waiting", providerSuspended: false })
          .pipe(Effect.flip);
        assert.strictEqual((yield* authority.status(first.token)).reservation.status, "active");
        const nested = yield* authority.reserveFromPeer({
          parentToken: first.token,
          child: child("nested"),
          projectId,
          snapshot,
          commandId: CommandId.make("nested"),
          requestKey: "nested",
        });
        assert.deepStrictEqual(nested.reservation.root, root);
        assert.strictEqual(nested.reservation.depth, 2);
        assert.strictEqual(nested.reservation.status, "queued");
        yield* authority
          .reserveFromPeer({
            parentToken: "forged",
            child: child("forged"),
            projectId,
            snapshot,
            commandId: CommandId.make("forged"),
            requestKey: "forged",
          })
          .pipe(Effect.flip);
        yield* authority
          .reserve({
            ...input,
            child: child("overflow"),
            commandId: CommandId.make("overflow"),
            requestKey: "overflow",
          })
          .pipe(Effect.flip);
        assert.strictEqual((yield* store.list(root)).length, 3);
        yield* authority.transition({
          token: first.token,
          status: "waiting",
          providerSuspended: true,
        });
        yield* store.admitQueued(root);
        assert.strictEqual((yield* authority.status(second.token)).reservation.status, "active");
        assert.strictEqual((yield* authority.status(nested.token)).reservation.status, "queued");
        yield* authority.transition({
          token: first.token,
          status: "active",
          providerSuspended: true,
        });
        assert.strictEqual((yield* authority.status(first.token)).reservation.status, "queued");
      }),
  );
  it.effect("rejects a changed launch binding before storing an incoming grant", () =>
    Effect.gen(function* () {
      const grantStore = yield* Grants.AgentDelegationAuthorityStore;
      const remoteRoot = {
        environmentId: EnvironmentId.make("other-root"),
        threadId: ThreadId.make("other-root"),
      };
      const localChild = { environmentId: root.environmentId, threadId: ThreadId.make("incoming") };
      const grant = {
        snapshot,
        token: "incoming-token",
        reservation: {
          commandId: "original",
          requestKey: "original-request",
          root: remoteRoot,
          parent: remoteRoot,
          child: localChild,
          snapshotId: snapshot.id,
          limits: { maxConcurrent: 1, maxAgents: 3, maxDepth: 2 },
          depth: 1,
          status: "active" as const,
        },
      };
      const peer = Layer.mock(Peer.PeerMcpClient)({
        call: ({ success }) => Schema.decodeEffect(success)(grant).pipe(Effect.orDie),
      });
      yield* Effect.gen(function* () {
        const destination = yield* Authority.AgentDelegationAuthority;
        for (const reservation of [
          { ...grant.reservation, commandId: "changed" },
          { ...grant.reservation, requestKey: "changed" },
        ]) {
          const result = yield* destination
            .accept({ ...grant, reservation }, "peer-session", projectId)
            .pipe(Effect.flip);
          assert.strictEqual(result.code, "capability_denied");
          assert.strictEqual(yield* grantStore.inbound(localChild), null);
        }
      }).pipe(Effect.provide(Layer.fresh(Authority.layer.pipe(Layer.provide(peer)))));
    }),
  );
});
