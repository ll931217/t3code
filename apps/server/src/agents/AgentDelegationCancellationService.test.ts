import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AgentProfileSnapshot,
  CommandId,
  EnvironmentId,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Identity from "../environment/ServerEnvironment.ts";
import * as Peer from "../peer/PeerMcpClient.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Gate from "./AgentProfileGate.ts";
import * as Admissions from "./AgentDelegationStore.ts";
import * as Grants from "./AgentDelegationAuthorityStore.ts";
import * as Cancellations from "./AgentDelegationCancellations.ts";
import * as Service from "./AgentDelegationCancellationService.ts";

const root = { environmentId: EnvironmentId.make("here"), threadId: ThreadId.make("root") };
const child = { environmentId: EnvironmentId.make("there"), threadId: ThreadId.make("child") };
const snapshot = Schema.decodeSync(AgentProfileSnapshot)({
  id: "snapshot",
  root: {
    fingerprint: "version",
    sourceProjectId: null,
    profile: {
      id: "personal/worker",
      name: "Worker",
      description: "",
      prompt: "",
      modelSelection: { instanceId: "codex", model: "test" },
      permissions: {
        filesystem: "read-only",
        commands: false,
        network: false,
        writablePaths: [],
        nativeTools: "capability-defaults",
        mcpTools: [],
        approvalPolicy: "never",
        integrations: { commit: false, merge: false, publish: false },
      },
      delegation: { profiles: [], maxConcurrent: 1, maxAgents: 3, maxDepth: 2 },
      isolation: "worktree",
    },
  },
  dependencies: [],
});
const stores = Layer.mergeAll(Admissions.layer, Grants.layer, Cancellations.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeCrypto.layer),
);
it.effect(
  "retains an orphan's slot across unavailable peers and restart until cancellation is acknowledged",
  () =>
    Effect.gen(function* () {
      const admissions = yield* Admissions.AgentDelegationStore;
      const grants = yield* Grants.AgentDelegationAuthorityStore;
      const cancellations = yield* Cancellations.AgentDelegationCancellations;
      const reservation = yield* admissions.reserve({
        commandId: "launch",
        root,
        parent: root,
        child,
        snapshotId: snapshot.id,
        requestKey: "launch",
        limits: snapshot.root.profile.delegation,
      });
      yield* grants.issue(reservation, snapshot);
      let reachable = false;
      let calls = 0;
      const layer = Service.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Gate.layer,
            Layer.succeed(Identity.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(root.environmentId),
            }),
            Layer.mock(Threads.ThreadManagementService)({}),
            Layer.mock(Projections.ProjectionStoreV2)({
              getThread: (threadId) =>
                Effect.fail(new Projections.ProjectionStoreThreadNotFoundError({ threadId })),
            }),
            Layer.mock(Peer.PeerMcpClient)({
              call: () =>
                Effect.suspend(() => {
                  calls++;
                  return reachable
                    ? Effect.succeed(undefined as never)
                    : Effect.fail(
                        new OrchestratorMcpFailure({
                          code: "orchestration_error",
                          message: "Disconnected",
                        }),
                      );
                }),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* Service.AgentDelegationCancellationService;
        yield* service.requestSubtree(root, CommandId.make("cancel-tree"));
        assert.isTrue(yield* cancellations.requested(child));
        yield* service.reconcile;
        assert.strictEqual((yield* admissions.get(child))?.status, "active");
        assert.isTrue(
          (yield* cancellations.pending()).some(
            (request) => request.child.threadId === child.threadId,
          ),
        );
      }).pipe(Effect.provide(layer));
      reachable = true;
      yield* Effect.gen(function* () {
        const service = yield* Service.AgentDelegationCancellationService;
        yield* service.reconcile;
        assert.strictEqual((yield* admissions.get(child))?.status, "cancelled");
        assert.deepStrictEqual(yield* cancellations.pending(), []);
        assert.isTrue(yield* cancellations.requested(child));
        assert.strictEqual(calls, 2);
      }).pipe(Effect.provide(Layer.fresh(layer)));
    }).pipe(Effect.scoped, Effect.provide(stores)),
);

it.effect("interrupts a busy startup but retains its slot until an exclusive final stop", () =>
  Effect.gen(function* () {
    const admissions = yield* Admissions.AgentDelegationStore;
    const cancellations = yield* Cancellations.AgentDelegationCancellations;
    const localChild = { ...child, environmentId: root.environmentId };
    yield* admissions.reserve({
      commandId: "local-launch",
      root,
      parent: root,
      child: localChild,
      snapshotId: snapshot.id,
      requestKey: "local-launch",
      limits: snapshot.root.profile.delegation,
    });
    let stops = 0;
    const deps = Layer.mergeAll(
      Gate.layer,
      Layer.succeed(Identity.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(root.environmentId),
      }),
      Layer.mock(Projections.ProjectionStoreV2)({ getThread: () => Effect.succeed({} as never) }),
      Layer.mock(Peer.PeerMcpClient)({}),
      Layer.mock(Threads.ThreadManagementService)({
        forceStopThread: () =>
          Effect.sync(() => {
            stops++;
            return { outcome: "released" as const, sharedWithThreadIds: [] };
          }),
      }),
    );
    yield* Effect.gen(function* () {
      const service = yield* Service.AgentDelegationCancellationService;
      const gate = yield* Gate.AgentProfileGate;
      yield* service.requestSubtree(localChild, CommandId.make("stop-local"));
      yield* gate.withStart(localChild.threadId, service.reconcile);
      assert.strictEqual(stops, 1);
      assert.strictEqual((yield* admissions.get(localChild))?.status, "active");
      assert.strictEqual((yield* cancellations.pending()).length, 1);
      yield* service.reconcile;
      assert.strictEqual(stops, 2);
      assert.strictEqual((yield* admissions.get(localChild))?.status, "cancelled");
      assert.deepStrictEqual(yield* cancellations.pending(), []);
    }).pipe(Effect.provide(Service.layer.pipe(Layer.provideMerge(deps))));
  }).pipe(Effect.scoped, Effect.provide(stores)),
);

it.effect("refuses a peer cancellation aimed at an existing thread without its inbound grant", () =>
  Effect.gen(function* () {
    let stops = 0;
    const proof = {
      token: "unrelated-peer-token",
      snapshot,
      cancellationRequested: true,
      reservation: {
        commandId: "foreign-launch",
        root: child,
        parent: child,
        child: root,
        snapshotId: snapshot.id,
        requestKey: "foreign",
        limits: snapshot.root.profile.delegation,
        depth: 1,
        status: "active" as const,
      },
    };
    const layer = Service.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Gate.layer,
          Layer.succeed(Identity.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(root.environmentId),
          }),
          Layer.mock(Projections.ProjectionStoreV2)({
            getThread: () => Effect.succeed({} as never),
          }),
          Layer.mock(Peer.PeerMcpClient)({ call: () => Effect.succeed(proof as never) }),
          Layer.mock(Threads.ThreadManagementService)({
            forceStopThread: () =>
              Effect.sync(() => {
                stops++;
                return { outcome: "released" as const, sharedWithThreadIds: [] };
              }),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* Service.AgentDelegationCancellationService;
      const result = yield* service
        .cancelFromPeer(
          { grant: proof, commandId: CommandId.make("cancel-foreign") },
          { linked: true, sessionId: "unrelated", label: "Peer", access: "full-access" },
        )
        .pipe(Effect.flip);
      assert.strictEqual(result.code, "capability_denied");
      assert.strictEqual(stops, 0);
      assert.isFalse(yield* (yield* Cancellations.AgentDelegationCancellations).requested(root));
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(stores)),
);
