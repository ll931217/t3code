import { expect, it } from "@effect/vitest";
import {
  AgentProfile,
  AgentProfileError,
  ThreadId,
  ProjectId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as AgentWorktreeActions from "./AgentWorktreeActions.ts";
import * as AgentProfiles from "./AgentProfiles.ts";
import * as AgentProfileGate from "./AgentProfileGate.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ServerConfig from "../config.ts";

const threadId = ThreadId.make("worker");
const decodeProfile = Schema.decodeUnknownEffect(AgentProfile);

it.effect(
  "commits only authorized paths, preserving unrelated changes and refusing read-only or revoked actors",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* Git.GitVcsDriver;
      const cwd = yield* fs.makeTempDirectoryScoped();
      const execute = (args: string[]) =>
        git.execute({ cwd, args, operation: "test.profileAction" });
      for (const args of [
        ["init", "-b", "main"],
        ["config", "user.name", "Test"],
        ["config", "user.email", "test@example.com"],
      ])
        yield* execute(args);
      yield* fs.writeFileString(`${cwd}/owned.txt`, "owned");
      yield* fs.writeFileString(`${cwd}/other.txt`, "unrelated");
      let profile = yield* decodeProfile({
        id: "personal/worker",
        name: "Worker",
        description: "",
        prompt: "",
        modelSelection: { instanceId: "codex", model: "test" },
        permissions: {
          filesystem: "read-only",
          commands: false,
          network: false,
          writablePaths: [],
          nativeTools: [],
          mcpTools: ["agent_worktree_action"],
          approvalPolicy: "never",
          integrations: { commit: true, merge: false, publish: false },
        },
        delegation: { profiles: [], maxConcurrent: 4, maxAgents: 16, maxDepth: 3 },
        isolation: "worktree",
      });
      let revoked = false;
      let writablePaths: ReadonlyArray<string> | undefined = ["owned.txt"];
      const projection = {
        thread: {
          id: threadId,
          projectId: ProjectId.make("project"),
          deletedAt: null,
          worktreePath: cwd,
          lineage: { rootThreadId: threadId },
        },
        runs: [],
      } as unknown as OrchestrationV2ThreadProjection;
      let source = projection;
      const actionsLayer = AgentWorktreeActions.layer.pipe(
        Layer.provide(AgentProfileGate.layer),
        Layer.provide(
          Layer.mock(AgentProfiles.AgentProfiles)({
            getThreadSnapshot: () =>
              Effect.succeed({
                id: "snapshot",
                root: { profile, fingerprint: "version", sourceProjectId: null },
                dependencies: [],
                ...(writablePaths === undefined ? {} : { writablePaths }),
              }),
            assertSnapshotAllowed: () =>
              revoked ? Effect.fail(new AgentProfileError({ reason: "revoked" })) : Effect.void,
          }),
        ),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadRecords: (id) => Effect.succeed(id === threadId ? projection : source),
          }),
        ),
        Layer.provide(Layer.mock(ProjectStore.ProjectStoreV2)({})),
      );
      yield* Effect.gen(function* () {
        const actions = yield* AgentWorktreeActions.AgentWorktreeActions;
        const commit = { action: "commit" as const, paths: ["owned.txt"], message: "Owned change" };
        expect((yield* Effect.flip(actions.run(threadId, commit))).message).toContain("writable");
        profile = {
          ...profile,
          permissions: { ...profile.permissions, filesystem: "workspace-write" },
        };
        expect(
          (yield* Effect.flip(actions.run(threadId, { ...commit, paths: ["other.txt"] }))).message,
        ).toContain("ownership");
        expect(
          (yield* Effect.flip(actions.run(threadId, { action: "publish" }))).message,
        ).toContain("authorize");
        yield* execute(["config", "filter.unsafe.clean", "exit 1"]);
        expect((yield* Effect.flip(actions.run(threadId, commit))).message).toContain(
          "configured Git commands",
        );
        yield* execute(["config", "--unset", "filter.unsafe.clean"]);
        yield* fs.writeFileString(`${cwd}/.git/hooks/pre-commit`, "#!/bin/sh\nexit 1\n");
        yield* fs.chmod(`${cwd}/.git/hooks/pre-commit`, 0o755);
        yield* actions.run(threadId, commit);
        yield* fs.remove(`${cwd}/.git/hooks/pre-commit`);
        expect((yield* execute(["show", "--format=", "--name-only", "HEAD"])).stdout.trim()).toBe(
          "owned.txt",
        );
        expect((yield* execute(["status", "--porcelain"])).stdout).toContain("other.txt");
        expect(
          (yield* Effect.flip(
            actions.run(threadId, { ...commit, paths: ["safe\n/../.git/config"] }),
          )).message,
        ).toContain("repository path");
        const child = `${yield* fs.makeTempDirectoryScoped()}/child-worktree`;
        yield* execute(["worktree", "add", "-b", "result", child]);
        source = {
          ...projection,
          thread: { ...projection.thread, id: ThreadId.make("child"), worktreePath: child },
        };
        yield* fs.writeFileString(`${child}/result.txt`, "worker output");
        yield* git.execute({ cwd: child, args: ["add", "result.txt"], operation: "test.stage" });
        yield* git.execute({
          cwd: child,
          args: ["commit", "-m", "Worker result"],
          operation: "test.commit",
        });
        profile = {
          ...profile,
          permissions: {
            ...profile.permissions,
            writablePaths: [],
            integrations: { commit: true, merge: true, publish: true },
          },
        };
        writablePaths = undefined;
        const merge = { action: "merge" as const, sourceThreadId: source.thread.id };
        yield* execute(["config", "status.showUntrackedFiles", "no"]);
        expect((yield* Effect.flip(actions.run(threadId, merge))).message).toContain("clean");
        yield* fs.remove(`${cwd}/other.txt`);
        yield* execute(["config", "extensions.worktreeConfig", "true"]);
        yield* git.execute({
          cwd: child,
          args: ["config", "--worktree", "filter.unsafe.clean", "touch filter-executed; cat"],
          operation: "test.sourceFilter",
        });
        yield* fs.writeFileString(`${child}/.gitattributes`, "owned.txt filter=unsafe\n");
        yield* fs.writeFileString(`${child}/owned.txt`, "other");
        const refusedSource = yield* Effect.flip(actions.run(threadId, merge));
        expect(yield* fs.exists(`${child}/filter-executed`)).toBe(false);
        expect(refusedSource.message).toContain("configured Git commands");
        yield* git.execute({
          cwd: child,
          args: ["config", "--worktree", "--unset", "filter.unsafe.clean"],
          operation: "test.clearSourceFilter",
        });
        yield* fs.remove(`${child}/.gitattributes`);
        yield* fs.writeFileString(`${child}/owned.txt`, "owned");
        yield* actions.run(threadId, merge);
        expect(yield* fs.readFileString(`${cwd}/result.txt`)).toBe("worker output");
        expect(yield* fs.exists(child)).toBe(true);
        const remote = yield* fs.makeTempDirectoryScoped();
        yield* git.execute({ cwd: remote, args: ["init", "--bare"], operation: "test.remote" });
        yield* execute(["remote", "add", "origin", remote]);
        expect(
          (yield* Effect.flip(actions.run(threadId, { action: "publish" }))).message,
        ).toContain("network");
        profile = { ...profile, permissions: { ...profile.permissions, network: true } };
        const publishedBranch = (yield* execute(["symbolic-ref", "HEAD"])).stdout.trim();
        const published = yield* actions.run(threadId, { action: "publish" });
        const remoteResult = yield* git.execute({
          cwd: remote,
          args: ["--git-dir", remote, "rev-parse", publishedBranch],
          operation: "test.published",
        });
        expect(remoteResult.stdout.trim()).toBe(published.commitSha);
        revoked = true;
        expect((yield* Effect.flip(actions.run(threadId, commit))).message).toContain("revoked");
      }).pipe(Effect.provide(actionsLayer));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Git.layer.pipe(
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-profile-action-" }).pipe(
              Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
);
