import { assert, it } from "@effect/vitest";
import { EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import * as Authority from "../../../agents/AgentDelegationAuthority.ts";
import * as Grants from "../../../agents/AgentDelegationAuthorityStore.ts";
import * as Launch from "../../../agents/AgentDelegationPeerLaunch.ts";
import * as Cancellations from "../../../agents/AgentDelegationCancellationService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Http from "../../McpHttpServer.ts";
import * as Handlers from "./handlers.ts";
import { AgentDelegationToolkit } from "./tools.ts";

const deniedGrant = new OrchestratorMcpFailure({
  code: "invalid_request",
  message: "The authority rejected this test grant.",
});
const services = Layer.mergeAll(
  Layer.mock(Authority.AgentDelegationAuthority)({
    status: () => Effect.fail(deniedGrant),
    transition: () => Effect.fail(deniedGrant),
  }),
  Layer.mock(Grants.AgentDelegationAuthorityStore)({}),
  Layer.mock(Launch.AgentDelegationPeerLaunch)({}),
  Layer.mock(Cancellations.AgentDelegationCancellationService)({
    requestFromPeer: () => Effect.fail(deniedGrant),
    cancelFromPeer: () => Effect.fail(deniedGrant),
  }),
  Layer.mock(Threads.ThreadManagementService)({}),
);
const server = Http.toolkitRegistration(AgentDelegationToolkit, Handlers.layer).pipe(
  Layer.provideMerge(Http.layerInProcessMcpServer),
  Layer.provideMerge(services),
);
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "peer-handler-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "peer-handler-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const decode = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ code: Schema.String, message: Schema.String })),
);

it.effect(
  "accepts linked peer principals without a thread while enforcing read-only access and grant rejection",
  () =>
    Effect.gen(function* () {
      const mcp = yield* McpServer.McpServer;
      for (const access of ["full-access", "read-only"] as const) {
        const scope: Invocation.McpInvocationScope = {
          environmentId: EnvironmentId.make("destination"),
          requestNamespace: "peer:source",
          thread: undefined,
          client: { sessionId: "peer-session", label: "Source", linked: true, access },
          capabilities: new Set(["orchestration"]),
          issuedAt: 0,
        };
        for (const [name, input] of Object.entries({
          agent_delegation_status: { token: "grant-token", forCancellation: true },
          agent_delegation_transition: {
            token: "grant-token",
            status: "waiting",
            providerSuspended: true,
          },
          agent_delegation_request_cancel: { token: "grant-token", commandId: "cancel" },
          agent_delegation_cancel: {
            commandId: "cancel",
            grant: {
              token: "grant-token",
              reservation: {
                commandId: "reserved",
                requestKey: "request",
                snapshotId: "snapshot",
                depth: 1,
                status: "active",
                root: { environmentId: "source", threadId: "root" },
                parent: { environmentId: "source", threadId: "root" },
                child: { environmentId: "destination", threadId: "child" },
                limits: { maxConcurrent: 1, maxAgents: 2, maxDepth: 1 },
              },
              snapshot: {
                id: "snapshot",
                dependencies: [],
                root: {
                  fingerprint: "version",
                  sourceProjectId: null,
                  profile: {
                    id: "personal/worker",
                    name: "Worker",
                    description: "",
                    prompt: "Work",
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
                    delegation: { profiles: [], maxConcurrent: 1, maxAgents: 2, maxDepth: 1 },
                    isolation: "shared",
                  },
                },
              },
            },
          },
        })) {
          const response = yield* mcp
            .callTool({
              name,
              arguments: input,
            })
            .pipe(Effect.provideService(Invocation.McpInvocationContext, scope));
          const outcome = yield* decode(
            response.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
          );
          if (access === "read-only" && name !== "agent_delegation_status")
            assert.equal(outcome.code, "capability_denied");
          else assert.deepEqual(outcome, { code: deniedGrant.code, message: deniedGrant.message });
        }
      }
    }).pipe(Effect.provideService(McpSchema.McpServerClient, mcpClient), Effect.provide(server)),
);
