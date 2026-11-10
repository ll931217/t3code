import { expect, it } from "@effect/vitest";
import { CommandId, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentExecutionStore from "./AgentExecutionStore.ts";
import * as AgentExecutionService from "./AgentExecutionService.ts";

it.effect(
  "recovers attributed steering independently and keeps node stops separate from subtree cancellation",
  () =>
    Effect.gen(function* () {
      const store = yield* AgentExecutionStore.AgentExecutionStore;
      const first = ThreadId.make("a-first");
      const second = ThreadId.make("b-second");
      let unavailable = true;
      const delivered = new Map<string, ThreadManagement.ThreadManagementSendInput>();
      const interrupted = new Set<ThreadId>();
      const cancelledSubtrees = new Set<ThreadId>();
      const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadProjection: (id) => Effect.succeed(idleThreadProjection(liveThreadShell(id))),
        sendToThread: (input) => {
          if (input.threadId === first && input.text.includes("revision 1") && unavailable)
            return Effect.fail(
              new ThreadManagement.ThreadManagementProviderInstanceDisabledError({
                projectId: input.projectId,
                instanceId: ProviderInstanceId.make("codex"),
              }),
            );
          delivered.set(input.commandId, input);
          return Effect.succeed({
            delivery: "queued",
          } as ThreadManagement.ThreadManagementSendResult);
        },
        interruptThread: ({ threadId }) =>
          Effect.sync(() => {
            interrupted.add(threadId);
            return { type: "no_active_run" as const };
          }),
        stopDelegatedTasks: ({ threadId }) =>
          Effect.sync(() => {
            cancelledSubtrees.add(threadId);
          }),
      });
      for (let revision = 0; revision < 100; revision++)
        yield* store.update(
          {
            threadId: first,
            commandId: CommandId.make(`edit:${first}:${revision}`),
            expectedRevision: revision,
            objective: "Verify the assigned changes",
            tasks: [],
            verifications: [],
          },
          "user",
        );
      yield* store.update(
        {
          threadId: second,
          commandId: CommandId.make("edit:second"),
          expectedRevision: 0,
          objective: "Verify the assigned changes again",
          tasks: [],
          verifications: [],
        },
        "user",
      );
      yield* Effect.gen(function* () {
        const service = yield* AgentExecutionService.AgentExecutionService;
        yield* service.drain;
        expect([...delivered.values()].map((input) => input.threadId)).toEqual([second]);
        expect((yield* store.pendingSteering()).map((record) => record.threadId)).toEqual(
          Array.from({ length: 100 }, () => first),
        );
        unavailable = false;
        yield* service.drain;
        yield* service.drain;
        expect(delivered.size).toBe(101);
        expect([...delivered.keys()]).toEqual([
          `execution-plan:${second}:1`,
          ...Array.from({ length: 100 }, (_, index) => `execution-plan:${first}:${index + 1}`),
        ]);
        expect(yield* store.pendingSteering()).toEqual([]);
        for (const message of delivered.values()) {
          expect(message.createdBy).toBe("user");
          expect(message.text).toContain("Verify the assigned changes");
        }
        yield* service.stop({
          threadId: first,
          commandId: CommandId.make("stop-node"),
          scope: "node",
        });
        expect(interrupted.has(first)).toBe(true);
        expect(cancelledSubtrees.size).toBe(0);
        yield* service.stop({
          threadId: second,
          commandId: CommandId.make("stop-tree"),
          scope: "subtree",
        });
        expect(cancelledSubtrees.has(second)).toBe(true);
      }).pipe(Effect.provide(AgentExecutionService.layer.pipe(Layer.provide(threads))));
    }).pipe(
      Effect.provide(
        AgentExecutionStore.layer.pipe(
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provideMerge(
            Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(EnvironmentId.make("local")),
            }),
          ),
        ),
      ),
    ),
);
