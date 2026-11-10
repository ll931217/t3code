import {
  AgentProfile,
  CommandId,
  EnvironmentId,
  NodeId,
  RunId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentProfiles from "./AgentProfiles.ts";
import * as AgentProfileStops from "./AgentProfileStops.ts";
import * as AgentProfileDelegation from "./AgentProfileDelegation.ts";
import * as AgentDelegationStore from "./AgentDelegationStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";

const decodeProfile = Schema.decodeUnknownSync(AgentProfile);
const profile = (id: string, dependencies: string[] = []) =>
  decodeProfile({
    id,
    name: "Worker",
    description: "Assigned work",
    prompt: "Implement the task.",
    modelSelection: { instanceId: "codex", model: "test-model" },
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
    delegation: { profiles: dependencies, maxConcurrent: 4, maxAgents: 16, maxDepth: 3 },
    isolation: "worktree",
  });
const testLayer = () =>
  Layer.merge(AgentProfiles.layer, AgentProfileStops.layer).pipe(
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NodeCrypto.layer),
  );

it.effect(
  "trusts the reviewed dependency closure and keeps running threads pinned after edits",
  () =>
    Effect.gen(function* () {
      const profiles = yield* AgentProfiles.AgentProfiles;
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped();
      const scope = { projectId: ProjectId.make("project-a"), workspaceRoot };
      const orchestrator = profile("personal/orchestrator", ["project/worker"]);
      const worker = profile("project/worker");
      yield* profiles.savePersonal(orchestrator);
      yield* profiles.savePersonal(profile("personal/worker"));
      yield* profiles.saveRepository(scope, worker);
      expect((yield* profiles.list(scope)).map((entry) => entry.version.profile.id)).toEqual([
        "personal/orchestrator",
        "personal/worker",
        "project/worker",
      ]);
      expect((yield* Effect.flip(profiles.resolveSnapshot(scope, orchestrator.id))).reason).toBe(
        "untrusted",
      );
      const reviewed = yield* profiles.reviewTrust(scope, orchestrator.id);
      yield* profiles.trust(scope, orchestrator.id, reviewed.id);
      const snapshot = yield* profiles.resolveSnapshot(scope, orchestrator.id);
      const threadId = ThreadId.make("thread-pinned");
      yield* profiles.pinThread({ threadId, snapshotId: snapshot.id });
      yield* profiles.saveRepository(scope, { ...worker, prompt: "A changed role prompt." });
      expect((yield* Effect.flip(profiles.trust(scope, orchestrator.id, reviewed.id))).reason).toBe(
        "changed",
      );
      expect((yield* Effect.flip(profiles.resolveSnapshot(scope, orchestrator.id))).reason).toBe(
        "untrusted",
      );
      expect(yield* profiles.getThreadSnapshot(threadId)).toEqual(snapshot);
      yield* Effect.gen(function* () {
        const delegation = yield* AgentProfileDelegation.AgentProfileDelegation;
        const commandId = CommandId.make("profile-delegation");
        const childThreadId = derive.delegatedTaskThread({ commandId });
        const command = {
          type: "delegated_task.request" as const,
          commandId,
          parentThreadId: threadId,
          parentRunId: RunId.make("parent-run"),
          parentNodeId: NodeId.make("parent-node"),
          task: "Work",
          modelSelection: worker.modelSelection,
          runtimeMode: "approval-required" as const,
          interactionMode: "default" as const,
          createdBy: "agent" as const,
          creationSource: "mcp" as const,
        };
        expect((yield* delegation.assertCommand(command).pipe(Effect.flip)).code).toBe(
          "capability_denied",
        );
        const preparedInput = {
          parentThreadId: threadId,
          childThreadId,
          environmentId: EnvironmentId.make("local"),
          targetProjectId: scope.projectId,
          profileId: worker.id,
          commandId,
          requestKey: "review",
        };
        yield* delegation.prepare({ ...preparedInput, deferAdmission: true });
        expect(yield* profiles.getThreadSnapshot(childThreadId)).toBeNull();
        yield* delegation.prepare(preparedInput);
        yield* delegation.assertCommand(command);
        expect((yield* profiles.getThreadSnapshot(childThreadId))?.root.profile.prompt).toBe(
          worker.prompt,
        );
        const destinationScope = {
          projectId: ProjectId.make("destination"),
          workspaceRoot: yield* fs.makeTempDirectoryScoped(),
        };
        yield* profiles.saveRepository(destinationScope, {
          ...worker,
          prompt: "Destination-specific worker",
        });
        const destinationCommand = CommandId.make("cross-project");
        const destinationInput = {
          parentThreadId: threadId,
          childThreadId: derive.delegatedTaskThread({ commandId: destinationCommand }),
          environmentId: EnvironmentId.make("local"),
          targetProjectId: destinationScope.projectId,
          destinationScope,
          profileId: worker.id,
          commandId: destinationCommand,
          requestKey: "cross-project",
        };
        expect((yield* delegation.prepare(destinationInput).pipe(Effect.flip)).code).toBe(
          "invalid_request",
        );
        const destinationReview = yield* profiles.reviewTrust(destinationScope, worker.id);
        yield* profiles.trust(destinationScope, worker.id, destinationReview.id);
        const destinationSnapshot = yield* delegation.prepare(destinationInput);
        expect(destinationSnapshot?.root.profile.prompt).toBe("Destination-specific worker");
        yield* profiles.saveRepository(destinationScope, {
          ...worker,
          prompt: "New unreviewed destination instructions",
        });
        expect((yield* delegation.prepare(destinationInput))?.id).toBe(destinationSnapshot?.id);
        expect(
          (yield* delegation.assertRemoteAllowed(threadId, worker.id).pipe(Effect.flip)).code,
        ).toBe("capability_denied");
        expect(
          (yield* delegation
            .assertCommand({
              type: "thread.create",
              commandId: CommandId.make("hijack"),
              threadId: childThreadId,
              projectId: scope.projectId,
              title: "Hijack",
              modelSelection: worker.modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(Effect.flip)).code,
        ).toBe("capability_denied");
      }).pipe(
        Effect.provide(
          AgentProfileDelegation.layer.pipe(Layer.provide(AgentDelegationStore.layer)),
        ),
        Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("local")),
        }),
      );
      const inherited = yield* profiles.deriveSnapshot(snapshot.id, worker.id);
      const narrowed = yield* profiles.narrowSnapshot(inherited.id, ["src/agents"]);
      expect(narrowed.writablePaths).toEqual(["src/agents"]);
      expect((yield* profiles.narrowSnapshot(narrowed.id, []).pipe(Effect.flip)).reason).toBe(
        "invalid-document",
      );
      expect(narrowed.root.fingerprint).toBe(inherited.root.fingerprint);
      expect(
        (yield* profiles.narrowSnapshot(narrowed.id, ["src/other"]).pipe(Effect.flip)).reason,
      ).toBe("wrong-scope");
      expect(
        (yield* profiles.narrowSnapshot(narrowed.id, ["src/agents/store.ts"])).writablePaths,
      ).toEqual(["src/agents/store.ts"]);
      expect(inherited.root.profile.prompt).toBe(worker.prompt);
      expect(inherited.dependencies).toEqual([]);
      yield* profiles.pinThread({
        threadId: ThreadId.make("delegated-worker"),
        snapshotId: inherited.id,
      });
      expect(
        (yield* Effect.flip(profiles.deriveSnapshot(snapshot.id, "personal/worker"))).reason,
      ).toBe("wrong-scope");
      yield* profiles.revoke(inherited.id);
      expect((yield* profiles.assertSnapshotAllowed(narrowed.id).pipe(Effect.flip)).reason).toBe(
        "revoked",
      );
      expect((yield* Effect.flip(profiles.deriveSnapshot(snapshot.id, worker.id))).reason).toBe(
        "revoked",
      );
      const updated = yield* profiles.reviewTrust(scope, orchestrator.id);
      yield* profiles.trust(scope, orchestrator.id, updated.id);
      expect(
        (yield* Effect.flip(profiles.pinThread({ threadId, snapshotId: updated.id }))).reason,
      ).toBe("snapshot-conflict");
      expect(
        (yield* profiles
          .applyThreadSnapshot({ threadId, snapshotId: updated.id })
          .pipe(Effect.flip)).reason,
      ).toBe("snapshot-conflict");
      const stops = yield* AgentProfileStops.AgentProfileStops;
      const pendingStops = yield* stops.pending();
      expect(pendingStops.some((stop) => stop.threadId === threadId)).toBe(true);
      yield* Effect.forEach(pendingStops, stops.acknowledge);
      yield* profiles.applyThreadSnapshot({ threadId, snapshotId: updated.id });
      expect((yield* profiles.getThreadSnapshot(threadId))?.dependencies[0]?.profile.prompt).toBe(
        "A changed role prompt.",
      );
    }).pipe(Effect.provide(testLayer())),
);

it.effect(
  "persists revocation across service reconstruction and retains snapshots after profile deletion",
  () =>
    Effect.gen(function* () {
      const profiles = yield* AgentProfiles.AgentProfiles;
      const fs = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped();
      const scope = { projectId: ProjectId.make("project-b"), workspaceRoot };
      const worker = profile("personal/worker");
      const parent = profile("personal/orchestrator", [worker.id]);
      yield* profiles.savePersonal(worker);
      yield* profiles.savePersonal(parent);
      const workerReview = yield* profiles.reviewTrust(scope, worker.id);
      const parentReview = yield* profiles.reviewTrust(scope, parent.id);
      yield* profiles.trust(scope, worker.id, workerReview.id);
      yield* profiles.trust(scope, parent.id, parentReview.id);
      yield* profiles.pinThread({
        threadId: ThreadId.make("worker-thread"),
        snapshotId: workerReview.id,
      });
      yield* profiles.pinThread({
        threadId: ThreadId.make("parent-thread"),
        snapshotId: parentReview.id,
      });
      expect([...(yield* profiles.revoke(workerReview.id))].sort()).toEqual([
        "parent-thread",
        "worker-thread",
      ]);
      const stops = yield* AgentProfileStops.AgentProfileStops;
      expect((yield* stops.pending()).map((stop) => stop.threadId).sort()).toEqual([
        "parent-thread",
        "worker-thread",
      ]);
      yield* profiles.remove(scope, worker.id);
      yield* Effect.gen(function* () {
        const restarted = yield* AgentProfiles.AgentProfiles;
        expect((yield* Effect.flip(restarted.assertSnapshotAllowed(parentReview.id))).reason).toBe(
          "revoked",
        );
        expect(yield* restarted.getThreadSnapshot(ThreadId.make("worker-thread"))).toEqual(
          workerReview,
        );
        expect((yield* restarted.list(scope)).map((entry) => entry.version.profile.id)).toEqual([
          parent.id,
        ]);
      }).pipe(Effect.provide(Layer.fresh(AgentProfiles.layer)));
    }).pipe(Effect.provide(testLayer())),
);

it.effect("trusting a changed dependency closure does not revive an older revoked snapshot", () =>
  Effect.gen(function* () {
    const profiles = yield* AgentProfiles.AgentProfiles;
    const fs = yield* FileSystem.FileSystem;
    const scope = {
      projectId: ProjectId.make("project-c"),
      workspaceRoot: yield* fs.makeTempDirectoryScoped(),
    };
    const parent = profile("personal/orchestrator", ["personal/worker"]);
    const worker = profile("personal/worker");
    yield* profiles.savePersonal(parent);
    yield* profiles.savePersonal(worker);
    const original = yield* profiles.reviewTrust(scope, parent.id);
    yield* profiles.trust(scope, parent.id, original.id);
    yield* profiles.revoke(original.id);
    yield* profiles.savePersonal({ ...worker, prompt: "Changed worker instructions." });
    const updated = yield* profiles.reviewTrust(scope, parent.id);
    yield* profiles.trust(scope, parent.id, updated.id);
    yield* profiles.assertSnapshotAllowed(updated.id);
    expect((yield* Effect.flip(profiles.assertSnapshotAllowed(original.id))).reason).toBe(
      "revoked",
    );
  }).pipe(Effect.provide(testLayer())),
);

it.effect(
  "saves a new repository profile through a symlinked workspace without following an escaping file",
  () =>
    Effect.gen(function* () {
      const profiles = yield* AgentProfiles.AgentProfiles;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${directory}/repository`);
      yield* fs.symlink(`${directory}/repository`, `${directory}/linked`);
      const scope = {
        projectId: ProjectId.make("project-linked"),
        workspaceRoot: `${directory}/linked`,
      };
      yield* profiles.saveRepository(scope, profile("project/worker"));
      expect((yield* profiles.list(scope))[0]?.version.profile.id).toBe("project/worker");
      yield* fs.remove(`${directory}/repository/t3.profiles.json`);
      yield* fs.writeFileString(`${directory}/outside.json`, '{"version":1,"profiles":[]}');
      yield* fs.symlink(`${directory}/outside.json`, `${directory}/repository/t3.profiles.json`);
      expect(
        (yield* Effect.flip(profiles.saveRepository(scope, profile("project/worker")))).reason,
      ).toBe("wrong-scope");
      expect(yield* fs.readFileString(`${directory}/outside.json`)).toBe(
        '{"version":1,"profiles":[]}',
      );
      yield* fs.remove(`${directory}/repository/t3.profiles.json`);
      yield* fs.symlink(`${directory}/missing.json`, `${directory}/repository/t3.profiles.json`);
      expect(
        (yield* Effect.flip(profiles.saveRepository(scope, profile("project/worker")))).reason,
      ).toBe("wrong-scope");
      expect(yield* fs.exists(`${directory}/missing.json`)).toBe(false);
    }).pipe(Effect.provide(testLayer())),
);
