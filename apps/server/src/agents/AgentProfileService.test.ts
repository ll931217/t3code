import { assert, it } from "@effect/vitest";
import {
  AgentProfile,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ServerProvider,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Launcher from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Providers from "../provider/ProviderInstanceRegistry.ts";
import * as Profiles from "./AgentProfiles.ts";
import * as Gate from "./AgentProfileGate.ts";
import * as Stops from "./AgentProfileStopWorker.ts";
import * as Service from "./AgentProfileService.ts";

const decodeProfile = Schema.decodeSync(AgentProfile);
const decodeProvider = Schema.decodeSync(ServerProvider);

it.effect("reapplying a previous profile updates both its snapshot and model", () =>
  Effect.gen(function* () {
    const projection = idleThreadProjection(liveThreadShell(ThreadId.make("apply-repeat")));
    const profile = decodeProfile({
      id: "personal/worker",
      name: "Worker",
      description: "",
      prompt: "Work",
      modelSelection: { instanceId: "codex", model: "a" },
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
      delegation: { profiles: [], maxConcurrent: 4, maxAgents: 16, maxDepth: 3 },
      isolation: "worktree",
    });
    let model = "";
    let pinned = "";
    const receipts = new Set<string>();
    const layer = Service.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Gate.layer,
          Layer.mock(Stops.AgentProfileStopWorker)({}),
          Layer.mock(Launcher.ThreadLaunchService)({}),
          Layer.mock(Profiles.AgentProfiles)({
            resolveSnapshot: (_scope, id) =>
              Effect.succeed({
                id,
                root: {
                  profile: {
                    ...profile,
                    id,
                    modelSelection: { ...profile.modelSelection, model: id },
                  },
                  fingerprint: id,
                  sourceProjectId: null,
                },
                dependencies: [],
              }),
            applyThreadSnapshot: (input) =>
              Effect.sync(() => {
                pinned = input.snapshotId;
              }),
          }),
          Layer.mock(Projects.ProjectStoreV2)({
            get: () =>
              Effect.succeedSome({
                projectId: projection.thread.projectId,
                title: "Project",
                hasCustomTitle: false,
                workspaceRoot: "/project",
                defaultModelSelection: null,
                defaultThreadEnvMode: null,
                autoPull: false,
                faviconPath: null,
                projectIcon: null,
                scripts: [],
                pinnedAt: null,
                archivedAt: null,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                deletedAt: null,
              }),
          }),
          Layer.mock(Providers.ProviderInstanceRegistry)({
            getInstance: () =>
              Effect.succeed({
                instanceId: ProviderInstanceId.make("codex"),
                driverKind: ProviderDriverKind.make("codex"),
                enabled: true,
                snapshot: {
                  getSnapshot: Effect.succeed(
                    decodeProvider({
                      instanceId: "codex",
                      driver: "codex",
                      enabled: true,
                      installed: true,
                      version: "1.0.0",
                      status: "ready",
                      auth: { status: "authenticated" },
                      checkedAt: "2026-01-01T00:00:00.000Z",
                      models: ["personal/a", "personal/b"].map((slug) => ({
                        slug,
                        name: slug,
                        isCustom: false,
                        capabilities: null,
                      })),
                    }),
                  ),
                },
              } as ProviderInstance),
          }),
          Layer.mock(Threads.ThreadManagementService)({
            getThreadProjection: () => Effect.succeed(projection),
            forceStopThread: () => Effect.succeed({ outcome: "released", sharedWithThreadIds: [] }),
            dispatch: (command) =>
              Effect.sync(() => {
                if (!receipts.has(command.commandId)) {
                  receipts.add(command.commandId);
                  if (command.type === "thread.model-selection.set")
                    model = command.modelSelection.model;
                }
                return { sequence: receipts.size } as Orchestrator.OrchestratorV2DispatchResult;
              }),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* Service.AgentProfileService;
      for (const profileId of ["personal/a", "personal/b", "personal/a", "personal/b"]) {
        yield* service.apply({
          threadId: projection.thread.id,
          projectId: projection.thread.projectId,
          profileId,
        });
        assert.strictEqual(pinned, profileId);
        assert.strictEqual(model, profileId);
      }
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(Layer.merge(NodeCrypto.layer, NodeServices.layer))),
);
