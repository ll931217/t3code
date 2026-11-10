import {
  AgentWorktreeActionError,
  AgentWorktreeActionInput,
  type AgentWorktreeActionResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AgentProfiles from "./AgentProfiles.ts";
import * as AgentProfileGate from "./AgentProfileGate.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";

export class AgentWorktreeActions extends Context.Service<
  AgentWorktreeActions,
  {
    readonly run: (
      threadId: ThreadId,
      input: AgentWorktreeActionInput,
    ) => Effect.Effect<AgentWorktreeActionResult, AgentWorktreeActionError>;
  }
>()("t3/agents/AgentWorktreeActions") {}

const failure = (message: string) => new AgentWorktreeActionError({ message });
const decodeInput = Schema.decodeEffect(AgentWorktreeActionInput);
const isActionError = Schema.is(AgentWorktreeActionError);
const activeStatuses = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export const layer = Layer.effect(
  AgentWorktreeActions,
  Effect.gen(function* () {
    const profiles = yield* AgentProfiles.AgentProfiles;
    const gate = yield* AgentProfileGate.AgentProfileGate;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const git = yield* Git.GitVcsDriver;
    const fs = yield* FileSystem.FileSystem;

    const assertSafeCommandConfig = Effect.fn("AgentWorktreeActions.assertSafeCommandConfig")(
      function* (cwd: string, action: AgentWorktreeActionInput["action"]) {
        const commandConfig = yield* git.execute({
          cwd,
          operation: "AgentWorktreeActions.config",
          args: [
            "config",
            "--name-only",
            "--get-regexp",
            action === "publish"
              ? "^(core\\.(sshcommand|gitproxy)|remote\\..*\\.(uploadpack|receivepack))$"
              : "^filter\\..*\\.(clean|smudge|process)$",
          ],
          allowNonZeroExit: true,
        });
        if (commandConfig.exitCode !== 0 && commandConfig.exitCode !== 1)
          return yield* failure("Cannot inspect Git command configuration.");
        if (commandConfig.stdout.trim() !== "")
          return yield* failure(
            "Agent integration does not execute configured Git commands. Use an explicit user Git action for this repository.",
          );
      },
    );

    const perform = Effect.fn("AgentWorktreeActions.perform")(
      function* (threadId: ThreadId, raw: AgentWorktreeActionInput) {
        const input = yield* decodeInput(raw);
        const snapshot = yield* profiles.getThreadSnapshot(threadId);
        if (snapshot === null)
          return yield* failure("This operation requires a pinned agent profile.");
        yield* profiles.assertSnapshotAllowed(snapshot.id);
        const original = snapshot.root.profile.permissions;
        const permissions = {
          ...original,
          writablePaths: snapshot.writablePaths ?? original.writablePaths,
        };
        if (permissions.filesystem !== "workspace-write")
          return yield* failure("Repository operations require a writable agent profile.");
        if (
          !permissions.mcpTools.includes("agent_worktree_action") ||
          !permissions.integrations[input.action]
        )
          return yield* failure(`The agent profile does not authorize ${input.action}.`);
        const { thread } = yield* threads.getThreadRecords(threadId, []);
        if (thread.deletedAt !== null) return yield* failure("The acting thread no longer exists.");
        const project = thread.worktreePath === null ? yield* projects.get(thread.projectId) : null;
        const cwd =
          thread.worktreePath ??
          (project !== null && Option.isSome(project) ? project.value.workspaceRoot : null);
        if (cwd === null) return yield* failure("The acting workspace was not found.");
        const root = yield* fs.realPath(cwd);
        return yield* withWorkspaceLease(
          root,
          Effect.gen(function* () {
            const hooks = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-git-hooks-" });
            yield* assertSafeCommandConfig(root, input.action);
            const credentials = yield* git.execute({
              cwd: root,
              operation: "AgentWorktreeActions.credentials",
              args: ["config", "--name-only", "--get-regexp", "^credential(\\..*)?\\.helper$"],
              allowNonZeroExit: true,
            });
            if (credentials.exitCode !== 0 && credentials.exitCode !== 1)
              return yield* failure("Cannot inspect Git credential helpers.");
            const clearedHelpers = credentials.stdout
              .split(/\r?\n/)
              .filter(Boolean)
              .flatMap((key) => ["-c", `${key}=`]);
            const execute = (args: readonly string[]) =>
              git.execute({
                cwd: root,
                operation: `AgentWorktreeActions.${input.action}`,
                env: {
                  GIT_ASKPASS: "",
                  SSH_ASKPASS: "",
                  GIT_TERMINAL_PROMPT: "0",
                  GIT_SSH_COMMAND: "ssh -F none",
                },
                args: [
                  "--literal-pathspecs",
                  "-c",
                  `core.hooksPath=${hooks}`,
                  "-c",
                  "core.fsmonitor=false",
                  "-c",
                  "commit.gpgSign=false",
                  "-c",
                  "merge.verifySignatures=false",
                  "-c",
                  "submodule.recurse=false",
                  "-c",
                  "push.recurseSubmodules=no",
                  "-c",
                  "push.followTags=false",
                  "-c",
                  "core.askPass=",
                  "-c",
                  "credential.helper=",
                  ...clearedHelpers,
                  "-c",
                  "protocol.allow=never",
                  "-c",
                  "protocol.file.allow=always",
                  "-c",
                  "protocol.ssh.allow=always",
                  "-c",
                  "protocol.https.allow=always",
                  "-c",
                  "protocol.http.allow=always",
                  "-c",
                  "protocol.ext.allow=never",
                  ...args,
                ],
              });
            if (input.action === "commit") {
              if (
                permissions.writablePaths.length > 0 &&
                input.paths.some(
                  (file) =>
                    !permissions.writablePaths.some(
                      (prefix) => file === prefix || file.startsWith(`${prefix}/`),
                    ),
                )
              )
                return yield* failure("Commit paths exceed the profile's writable ownership.");
              yield* execute(["add", "--", ...input.paths]);
              yield* execute(["commit", "--only", "-m", input.message, "--", ...input.paths]);
            } else if (input.action === "merge") {
              if (permissions.writablePaths.length > 0)
                return yield* failure(
                  "Merging requires ownership of the entire destination workspace.",
                );
              const source = yield* threads.getThreadRecords(input.sourceThreadId, ["runs"]);
              if (
                source.thread.deletedAt !== null ||
                source.thread.worktreePath === null ||
                source.thread.id === thread.id ||
                source.thread.projectId !== thread.projectId ||
                source.thread.lineage.rootThreadId !== thread.lineage.rootThreadId
              )
                return yield* failure(
                  "Merge source must be another retained worktree in the same execution tree and project.",
                );
              if (source.runs.some((run) => activeStatuses.has(run.status)))
                return yield* failure("Stop the source thread before integrating its result.");
              const sourceRoot = yield* fs.realPath(source.thread.worktreePath);
              if (sourceRoot === root)
                return yield* failure("Source and destination must be different worktrees.");
              yield* assertSafeCommandConfig(sourceRoot, "merge");
              const sourceStatus = yield* git.execute({
                cwd: sourceRoot,
                operation: "AgentWorktreeActions.sourceStatus",
                args: [
                  "-c",
                  "core.fsmonitor=false",
                  "status",
                  "--porcelain",
                  "--untracked-files=all",
                ],
              });
              const targetStatus = yield* execute([
                "status",
                "--porcelain",
                "--untracked-files=all",
              ]);
              if (sourceStatus.stdout.trim() !== "" || targetStatus.stdout.trim() !== "")
                return yield* failure(
                  "Commit or preserve pending changes before merging; both worktrees must be clean.",
                );
              const sourceHead = yield* git.execute({
                cwd: sourceRoot,
                operation: "AgentWorktreeActions.sourceHead",
                args: ["rev-parse", "--verify", "HEAD"],
              });
              const sha = sourceHead.stdout.trim();
              if (!/^[0-9a-f]{40,64}$/.test(sha))
                return yield* failure("Source commit could not be resolved.");
              yield* execute(["merge", "--ff-only", "--no-edit", sha]);
            } else {
              if (!permissions.network)
                return yield* failure("Publishing requires network permission.");
              const branch = (yield* execute(["symbolic-ref", "--quiet", "HEAD"])).stdout.trim();
              if (!branch.startsWith("refs/heads/"))
                return yield* failure("Publishing requires an attached branch.");
              yield* execute(["push", "--porcelain", "origin", `HEAD:${branch}`]);
            }
            const head = yield* execute(["rev-parse", "--verify", "HEAD"]);
            return { action: input.action, commitSha: head.stdout.trim() };
          }).pipe(Effect.scoped),
        );
      },
      Effect.mapError((error) =>
        isActionError(error)
          ? error
          : failure(error instanceof Error ? error.message : String(error)),
      ),
    );
    return AgentWorktreeActions.of({
      run: Effect.fn("AgentWorktreeActions.run")((threadId, input) =>
        gate
          .withStart(
            threadId,
            input.action === "merge"
              ? gate.withLease(input.sourceThreadId, perform(threadId, input))
              : perform(threadId, input),
          )
          .pipe(
            Effect.mapError((error) => (isActionError(error) ? error : failure(error.message))),
          ),
      ),
    });
  }),
);
