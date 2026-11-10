import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AgentProfileSnapshot,
  CommandId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type AgentDelegationGrant,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Authority from "./AgentDelegationAuthority.ts";
import * as PeerLaunch from "./AgentDelegationPeerLaunch.ts";
import * as Launcher from "../orchestration-v2/ThreadLaunchService.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Providers from "../provider/ProviderInstanceRegistry.ts";

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

it.effect(
  "checks launch task and command against the authority response, not caller-supplied grant fields",
  () =>
    Effect.gen(function* () {
      const task = "Changed work";
      const title = "Changed title";
      const projectId = ProjectId.make("destination");
      const digest = yield* Digest.Digest;
      const requestKey = Hex.encode(
        yield* digest.digest(
          Digest.sha256,
          new TextEncoder().encode(
            stableStringify({ task, title, projectId, profileId: snapshot.root.profile.id }),
          ),
        ),
      );
      const authoritative: AgentDelegationGrant = {
        snapshot,
        token: "token",
        reservation: {
          commandId: "original",
          requestKey: "original-task",
          root: { environmentId: EnvironmentId.make("root-env"), threadId: ThreadId.make("root") },
          parent: {
            environmentId: EnvironmentId.make("root-env"),
            threadId: ThreadId.make("root"),
          },
          child: {
            environmentId: EnvironmentId.make("destination-env"),
            threadId: ThreadId.make("child"),
          },
          snapshotId: snapshot.id,
          limits: { maxConcurrent: 1, maxAgents: 3, maxDepth: 2 },
          depth: 1,
          status: "queued",
        },
      };
      const layers = PeerLaunch.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Authority.AgentDelegationAuthority)({
              accept: () => Effect.succeed(authoritative),
            }),
            Layer.mock(Launcher.ThreadLaunchService)({}),
            Layer.mock(Projections.ProjectionStoreV2)({}),
            Layer.mock(Providers.ProviderInstanceRegistry)({ getInstance: () => Effect.undefined }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const launch = yield* PeerLaunch.AgentDelegationPeerLaunch;
        for (const commandId of ["changed-command", "original"]) {
          const supplied = {
            ...authoritative,
            reservation: { ...authoritative.reservation, commandId, requestKey },
          };
          const result = yield* launch
            .launch(
              { grant: supplied, commandId: CommandId.make(commandId), projectId, task, title },
              { linked: true, sessionId: "peer", label: "Peer", access: "full-access" },
            )
            .pipe(Effect.flip);
          assert.strictEqual(result.code, "capability_denied");
        }
      }).pipe(Effect.provide(layers));
    }).pipe(Effect.provide(NodeCrypto.layer)),
);
