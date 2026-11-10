import {
  AgentProfileError,
  CommandId,
  type AgentProfileLaunchInput,
  type AgentProfileCatalogEntry,
  type AgentProfileLookup,
  type AgentProfileSaveInput,
  type AgentProfileSnapshot,
  type AgentProfileTrustInput,
  type OrchestrationV2ThreadLaunchResult,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as AgentProfiles from "./AgentProfiles.ts";
import * as AgentProfileGate from "./AgentProfileGate.ts";
import * as AgentProfileStopWorker from "./AgentProfileStopWorker.ts";
import { assertAgentProfileCompatible } from "./agentProfilePolicy.ts";

export class AgentProfileService extends Context.Service<
  AgentProfileService,
  {
    readonly list: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<AgentProfileCatalogEntry>, AgentProfileError>;
    readonly save: (input: AgentProfileSaveInput) => Effect.Effect<void, AgentProfileError>;
    readonly remove: (input: AgentProfileLookup) => Effect.Effect<void, AgentProfileError>;
    readonly review: (
      input: AgentProfileLookup,
    ) => Effect.Effect<AgentProfileSnapshot, AgentProfileError>;
    readonly trust: (
      input: AgentProfileTrustInput,
    ) => Effect.Effect<AgentProfileSnapshot, AgentProfileError>;
    readonly threadSnapshot: (
      threadId: ThreadId,
    ) => Effect.Effect<AgentProfileSnapshot | null, AgentProfileError>;
    readonly launch: (
      input: AgentProfileLaunchInput,
    ) => Effect.Effect<OrchestrationV2ThreadLaunchResult, AgentProfileError>;
    readonly apply: (
      input: AgentProfileLookup & { readonly threadId: ThreadId },
    ) => Effect.Effect<AgentProfileSnapshot, AgentProfileError>;
    readonly revoke: (
      snapshotId: string,
    ) => Effect.Effect<ReadonlyArray<ThreadId>, AgentProfileError>;
  }
>()("t3/agents/AgentProfileService") {}

const isProfileError = Schema.is(AgentProfileError);
const mapError = (cause: unknown) =>
  isProfileError(cause) ? cause : new AgentProfileError({ reason: "storage", cause });
const activeStatuses = new Set(["preparing", "queued", "starting", "running", "waiting"]);

const make = Effect.gen(function* () {
  const profiles = yield* AgentProfiles.AgentProfiles;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const gate = yield* AgentProfileGate.AgentProfileGate;
  const stopWorker = yield* AgentProfileStopWorker.AgentProfileStopWorker;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;

  const scope = Effect.fn("AgentProfileService.scope")(function* (projectId: ProjectId) {
    const project = yield* projects.get(projectId);
    if (Option.isNone(project)) return yield* new AgentProfileError({ reason: "not-found" });
    return { projectId, workspaceRoot: project.value.workspaceRoot };
  }, Effect.mapError(mapError));

  const resolve = Effect.fn("AgentProfileService.resolve")(function* (input: AgentProfileLookup) {
    const snapshot = yield* profiles.resolveSnapshot(
      yield* scope(input.projectId),
      input.profileId,
    );
    const profile = snapshot.root.profile;
    const instance = yield* providers.getInstance(profile.modelSelection.instanceId);
    if (instance === undefined || !instance.enabled)
      return yield* new AgentProfileError({ reason: "not-found", profileId: input.profileId });
    const catalog = yield* instance.snapshot.getSnapshot;
    if (!catalog.models.some((model) => model.slug === profile.modelSelection.model))
      return yield* new AgentProfileError({ reason: "not-found", profileId: input.profileId });
    yield* assertAgentProfileCompatible(profile, instance.driverKind);
    return snapshot;
  });

  return AgentProfileService.of({
    list: Effect.fn("AgentProfileService.list")(function* (projectId) {
      return yield* profiles.list(yield* scope(projectId));
    }),
    save: Effect.fn("AgentProfileService.save")(function* (input) {
      const destination = yield* scope(input.projectId);
      if (input.profile.id.startsWith("personal/")) yield* profiles.savePersonal(input.profile);
      else yield* profiles.saveRepository(destination, input.profile);
    }),
    remove: Effect.fn("AgentProfileService.remove")(function* (input) {
      yield* profiles.remove(yield* scope(input.projectId), input.profileId);
    }),
    review: Effect.fn("AgentProfileService.review")(function* (input) {
      return yield* profiles.reviewTrust(yield* scope(input.projectId), input.profileId);
    }),
    trust: Effect.fn("AgentProfileService.trust")(function* (input) {
      return yield* profiles.trust(
        yield* scope(input.projectId),
        input.profileId,
        input.expectedFingerprint,
      );
    }),
    threadSnapshot: profiles.getThreadSnapshot,
    launch: Effect.fn("AgentProfileService.launch")(
      function* (input) {
        const snapshot = yield* resolve(input);
        const profile = snapshot.root.profile;
        yield* profiles.pinThread({ threadId: input.threadId, snapshotId: snapshot.id });
        return yield* launcher.launch({
          commandId: input.commandId,
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          modelSelection: profile.modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          workspaceStrategy:
            profile.isolation === "worktree"
              ? { type: "worktree", baseRef: input.baseRef ?? "HEAD" }
              : { type: "root" },
          ...(input.initialMessage === undefined
            ? {}
            : {
                initialMessage: {
                  text: input.initialMessage.text,
                  attachments: input.initialMessage.attachments,
                  ...(input.initialMessage.messageId === undefined
                    ? {}
                    : { messageId: input.initialMessage.messageId }),
                  ...(input.initialMessage.context === undefined
                    ? {}
                    : { context: input.initialMessage.context }),
                },
              }),
          createdBy: "user",
          creationSource: "web",
        });
      },
      (effect, input) => gate.withLease(input.threadId, effect),
      Effect.mapError(mapError),
    ),
    apply: Effect.fn("AgentProfileService.apply")(
      function* (input) {
        const projection = yield* threads.getThreadProjection(input.threadId);
        if (projection.thread.projectId !== input.projectId)
          return yield* new AgentProfileError({ reason: "wrong-scope" });
        if (projection.runs.some((run) => activeStatuses.has(run.status)))
          return yield* new AgentProfileError({ reason: "snapshot-conflict" });
        const snapshot = yield* resolve(input);
        const apply = Effect.gen(function* () {
          const commandId = CommandId.make(`profile-apply:${yield* random.uuidV4()}`);
          const stopped = yield* threads.forceStopThread({ threadId: input.threadId });
          if (stopped.outcome !== "killed" && stopped.outcome !== "released")
            return yield* new AgentProfileError({ reason: "snapshot-conflict" });
          yield* profiles.applyThreadSnapshot({
            threadId: input.threadId,
            snapshotId: snapshot.id,
          });
          yield* threads.dispatch({
            type: "thread.model-selection.set",
            commandId,
            threadId: input.threadId,
            modelSelection: snapshot.root.profile.modelSelection,
          });
        });
        yield* projection.thread.worktreePath === null
          ? apply
          : withWorkspaceLease(path.resolve(projection.thread.worktreePath), apply);
        return snapshot;
      },
      (effect, input) => gate.withLease(input.threadId, effect),
      Effect.mapError(mapError),
    ),
    revoke: Effect.fn("AgentProfileService.revoke")(function* (snapshotId) {
      const affected = yield* profiles.revoke(snapshotId);
      yield* stopWorker.drain();
      return affected;
    }, Effect.mapError(mapError)),
  });
});

export const layer = Layer.effect(AgentProfileService, make);
