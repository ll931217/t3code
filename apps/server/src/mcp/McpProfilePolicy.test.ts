import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AgentProfile,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as AgentProfiles from "../agents/AgentProfiles.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const decodeProfile = Schema.decodeEffect(AgentProfile);

it.effect("resolves pinned tool grants and refuses revoked credentials immediately", () =>
  Effect.gen(function* () {
    const profiles = yield* AgentProfiles.AgentProfiles;
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const fs = yield* FileSystem.FileSystem;
    const scope = {
      projectId: ProjectId.make("project"),
      workspaceRoot: yield* fs.makeTempDirectoryScoped(),
    };
    const profile = yield* decodeProfile({
      id: "personal/reviewer",
      name: "Reviewer",
      description: "Review changes",
      prompt: "Review only.",
      modelSelection: { instanceId: "codex", model: "test" },
      permissions: {
        filesystem: "read-only",
        commands: false,
        network: false,
        writablePaths: [],
        nativeTools: "capability-defaults",
        mcpTools: ["agent_execution_read"],
        approvalPolicy: "never",
        integrations: { commit: false, merge: false, publish: false },
      },
      delegation: { profiles: [], maxConcurrent: 4, maxAgents: 16, maxDepth: 3 },
      isolation: "worktree",
    });
    yield* profiles.savePersonal(profile);
    const reviewed = yield* profiles.reviewTrust(scope, profile.id);
    yield* profiles.trust(scope, profile.id, reviewed.id);
    const threadId = ThreadId.make("profiled");
    yield* profiles.pinThread({ threadId, snapshotId: reviewed.id });
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect((yield* registry.resolve(token))?.thread.allowedTools).toEqual(["agent_execution_read"]);
    yield* profiles.savePersonal({
      ...profile,
      permissions: { ...profile.permissions, mcpTools: ["delegate_task"] },
    });
    expect((yield* registry.resolve(token))?.thread.allowedTools).toEqual(["agent_execution_read"]);
    yield* profiles.revoke(reviewed.id);
    expect(yield* registry.resolve(token)).toBeUndefined();
    const legacy = yield* registry.issue({
      threadId: ThreadId.make("legacy"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(
      (yield* registry.resolve(legacy.config.authorizationHeader.replace(/^Bearer\s+/, "")))?.thread
        .allowedTools,
    ).toBeUndefined();
  }).pipe(
    Effect.provide(
      McpSessionRegistry.layerEnforcingProfiles.pipe(
        Layer.provide(McpSessionRegistry.layer),
        Layer.provideMerge(AgentProfiles.layer),
        Layer.provide(Layer.fresh(SqlitePersistence.layerMemory)),
        Layer.provide(
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
            getDescriptor: Effect.die("unused"),
          }),
        ),
        Layer.provide(
          Layer.succeed(HttpServer.HttpServer, {
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
            serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
          }),
        ),
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(NodeCrypto.layer),
      ),
    ),
  ),
);
