import { expect, it } from "@effect/vitest";
import { CommandId, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Service from "../../../agents/AgentExecutionService.ts";
import * as Cancellation from "../../../agents/AgentDelegationCancellationService.ts";
import * as Store from "../../../agents/AgentExecutionStore.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { AgentExecutionToolkit } from "./tools.ts";

it.effect("keeps execution updates on the authenticated thread with agent provenance", () =>
  Effect.gen(function* () {
    const store = yield* Store.AgentExecutionStore;
    const caller = ThreadId.make("worker");
    const parent = ThreadId.make("parent");
    const dependencies = Layer.mergeAll(
      Service.layer,
      Layer.succeed(Invocation.McpInvocationContext, {
        environmentId: EnvironmentId.make("local"),
        requestNamespace: "worker-session",
        issuedAt: 0,
        thread: {
          threadId: caller,
          providerSessionId: "worker-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set<Invocation.McpCapability>(["orchestration"]),
      }),
    ).pipe(
      Layer.provide(Layer.mock(Cancellation.AgentDelegationCancellationService)({})),
      Layer.provideMerge(
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          getThreadProjection: (id) => Effect.succeed(idleThreadProjection(liveThreadShell(id))),
        }),
      ),
    );
    const toolkit = yield* AgentExecutionToolkit.pipe(
      Effect.provide(Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies))),
    );
    const payload = {
      threadId: parent,
      commandId: CommandId.make("worker-update"),
      expectedRevision: 0,
      objective: "Verify my assigned change",
      tasks: [],
      verifications: [
        {
          id: "tests",
          title: "Focused tests",
          status: "passed" as const,
          evidence: [{ kind: "test" as const, summary: "Focused test command passed" }],
        },
      ],
      confirmVerificationIds: ["tests"],
    };
    yield* toolkit
      .handle("agent_execution_update", payload)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(yield* store.get(parent)).toBeNull();
    expect((yield* store.get(caller))?.verifications[0]?.provenance).toBe("agent-reported");
    expect(yield* store.pendingSteering()).toEqual([]);
  }).pipe(
    Effect.provide(
      Store.layer.pipe(
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provideMerge(
          Layer.succeed(Environment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("local")),
          }),
        ),
      ),
    ),
  ),
);
