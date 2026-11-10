import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentDelegationStore from "./AgentDelegationStore.ts";
import * as AgentDelegationRuntime from "./AgentDelegationRuntime.ts";
import * as Cancellations from "./AgentDelegationCancellations.ts";

const environmentId = EnvironmentId.make("local");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test-model" };
const database = SqlitePersistence.layerMemory;
const base = Layer.mergeAll(
  database,
  AgentDelegationStore.layer.pipe(Layer.provide(database)),
  Cancellations.layer.pipe(Layer.provide(database)),
  ProjectionStore.layer.pipe(Layer.provide(database)),
  EffectOutbox.layer.pipe(Layer.provide(database)),
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(environmentId),
  }),
  ProviderReplayHarness.layerWithRegistry(
    { name: "agent-admission" },
    ProviderAdapterRegistry.layerFromAdapters([
      {
        instanceId: modelSelection.instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
        openSession: () => Effect.die("Admission tests do not start a provider process"),
      },
    ]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);
const testLayer = AgentDelegationRuntime.layer.pipe(Layer.provideMerge(base));

it.effect(
  "keeps waiting work reserved until suspension and durably resumes queued starts exactly once",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const store = yield* AgentDelegationStore.AgentDelegationStore;
      const runtime = yield* AgentDelegationRuntime.AgentDelegationRuntime;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const root = { environmentId, threadId: ThreadId.make("root") };
      for (const id of ["first", "second"]) {
        const threadId = ThreadId.make(id);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create-${id}`),
          threadId,
          projectId: ProjectId.make("project"),
          title: id,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`start-${id}`),
          threadId,
          messageId: MessageId.make(`message-${id}`),
          text: "Task",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* store.reserve({
          commandId: id,
          root,
          parent: root,
          child: { environmentId, threadId },
          snapshotId: "pinned",
          requestKey: id,
          limits: { maxConcurrent: 1, maxAgents: 16, maxDepth: 3 },
        });
      }
      const first = { environmentId, threadId: ThreadId.make("first") };
      const second = { environmentId, threadId: ThreadId.make("second") };
      const firstRun = (yield* projections.getThreadProjection(first.threadId)).runs[0]!;
      const secondRun = (yield* projections.getThreadProjection(second.threadId)).runs[0]!;
      yield* store.deferStart({ child: second, runId: secondRun.id });
      const now = yield* DateTime.now;
      yield* projections.apply({
        id: EventId.make("waiting"),
        type: "run.updated",
        threadId: first.threadId,
        occurredAt: now,
        payload: { ...firstRun, status: "waiting" },
      });
      yield* runtime.reconcile;
      assert.strictEqual((yield* store.get(second))?.status, "queued");
      assert.strictEqual((yield* store.pendingStarts()).length, 1);
      yield* projections.apply({
        id: EventId.make("completed"),
        type: "run.updated",
        threadId: first.threadId,
        occurredAt: now,
        payload: { ...firstRun, status: "completed", completedAt: now },
      });
      yield* runtime.reconcile;
      yield* runtime.reconcile;
      assert.strictEqual((yield* store.get(second))?.status, "active");
      assert.deepStrictEqual(yield* store.pendingStarts(), []);
      const starts = yield* outbox.listByCommandId(
        CommandId.make(`agent-admission:${environmentId}:${secondRun.id}:1`),
      );
      assert.strictEqual(starts.length, 1);
      assert.strictEqual(starts[0]?.request.type, "provider-turn.start");
      yield* store.deferStart({ child: second, runId: secondRun.id });
      yield* runtime.reconcile;
      const resumed = yield* outbox.listByCommandId(
        CommandId.make(`agent-admission:${environmentId}:${secondRun.id}:2`),
      );
      assert.strictEqual(resumed.length, 1);
      assert.notStrictEqual(resumed[0]?.id, starts[0]?.id);
      const cancellations = yield* Cancellations.AgentDelegationCancellations;
      yield* cancellations.request(second, CommandId.make("cancel-second"));
      yield* store.deferStart({ child: second, runId: secondRun.id });
      yield* projections.apply({
        id: EventId.make("interrupted-second"),
        type: "run.updated",
        threadId: second.threadId,
        occurredAt: now,
        payload: { ...secondRun, status: "interrupted", completedAt: now },
      });
      yield* runtime.reconcile;
      assert.strictEqual((yield* store.get(second))?.status, "active");
      assert.strictEqual((yield* store.pendingStarts()).length, 1);
      assert.deepStrictEqual(
        yield* outbox.listByCommandId(
          CommandId.make(`agent-admission:${environmentId}:${secondRun.id}:3`),
        ),
        [],
      );
      const foreign = {
        environmentId: EnvironmentId.make("authority-elsewhere"),
        threadId: ThreadId.make("foreign-root"),
      };
      const remoteOwned = { environmentId, threadId: ThreadId.make("remote-owned") };
      yield* store.mirror({
        commandId: "foreign-reservation",
        root: foreign,
        parent: foreign,
        child: remoteOwned,
        snapshotId: "foreign-snapshot",
        requestKey: "foreign-request",
        limits: { maxConcurrent: 4, maxAgents: 16, maxDepth: 3 },
        depth: 1,
        status: "queued",
      });
      yield* store.deferStart({ child: remoteOwned, runId: secondRun.id });
      yield* runtime.reconcile;
      assert.strictEqual((yield* store.get(remoteOwned))?.status, "queued");
      assert.deepStrictEqual(yield* store.pendingStarts(), [
        { child: second, runId: secondRun.id, generation: 3 },
        { child: remoteOwned, runId: secondRun.id, generation: 1 },
      ]);
    }).pipe(Effect.provide(testLayer)),
);
