import { assert, it } from "@effect/vitest";
import { EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import * as Authority from "../../../agents/AgentDelegationAuthority.ts";
import * as Grants from "../../../agents/AgentDelegationAuthorityStore.ts";
import * as Launch from "../../../agents/AgentDelegationPeerLaunch.ts";
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
        for (const name of ["agent_delegation_status", "agent_delegation_transition"]) {
          const response = yield* mcp
            .callTool({
              name,
              arguments:
                name === "agent_delegation_status"
                  ? { token: "grant-token" }
                  : { token: "grant-token", status: "waiting", providerSuspended: true },
            })
            .pipe(Effect.provideService(Invocation.McpInvocationContext, scope));
          const outcome = yield* decode(
            response.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
          );
          if (access === "read-only" && name === "agent_delegation_transition")
            assert.equal(outcome.code, "capability_denied");
          else assert.deepEqual(outcome, { code: deniedGrant.code, message: deniedGrant.message });
        }
      }
    }).pipe(Effect.provideService(McpSchema.McpServerClient, mcpClient), Effect.provide(server)),
);
