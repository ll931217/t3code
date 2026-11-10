import type { AgentProfile } from "@t3tools/contracts";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { claudeAgentProfileTools } from "./agentProfilePolicy.ts";

export function claudeAgentProfileOptions(
  profile: AgentProfile,
  cwd: string,
): Pick<
  Options,
  | "tools"
  | "permissionMode"
  | "allowDangerouslySkipPermissions"
  | "allowedTools"
  | "disallowedTools"
  | "settingSources"
  | "strictMcpConfig"
  | "sandbox"
  | "plugins"
> {
  return {
    tools: [...claudeAgentProfileTools(profile)],
    permissionMode: "default",
    allowDangerouslySkipPermissions: false,
    allowedTools: [],
    disallowedTools: ["Agent", "Task"],
    settingSources: [],
    strictMcpConfig: true,
    plugins: [],
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      filesystem: {
        allowWrite: profile.permissions.filesystem === "workspace-write" ? [cwd] : [],
        denyWrite:
          profile.permissions.filesystem === "read-only"
            ? ["/"]
            : [`${cwd}/.git`, "/tmp", "/var/tmp"],
      },
      network: {
        strictAllowlist: true,
        allowedDomains: profile.permissions.network ? ["*"] : [],
        allowAllUnixSockets: false,
        allowUnixSockets: [],
        allowLocalBinding: false,
      },
    },
  };
}

export const agentProfileAllowsClaudeTool = Effect.fn("AgentProfilePolicy.allowClaudeTool")(
  function* (
    profile: AgentProfile,
    cwd: string | null,
    tool: string,
    input: Record<string, unknown>,
  ) {
    if (tool.startsWith("mcp__t3-code__"))
      return profile.permissions.mcpTools.includes(tool.slice("mcp__t3-code__".length));
    if (!claudeAgentProfileTools(profile).includes(tool)) return false;
    if (!["Write", "Edit", "NotebookEdit"].includes(tool)) return true;
    if (cwd === null || profile.permissions.filesystem !== "workspace-write") return false;
    const file = tool === "NotebookEdit" ? input.notebook_path : input.file_path;
    if (typeof file !== "string") return false;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.realPath(cwd);
    const target = path.resolve(root, file);
    const resolved = yield* fs.realPath(target).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag !== "NotFound"
            ? Effect.fail(error)
            : Effect.gen(function* () {
                let ancestor = target;
                const missing: string[] = [];
                while (true) {
                  const stat = yield* fs.lstat(ancestor).pipe(
                    Effect.catchTags({
                      PlatformError: (failure) =>
                        failure.reason._tag === "NotFound"
                          ? Effect.succeed(null)
                          : Effect.fail(failure),
                    }),
                  );
                  if (stat !== null) {
                    if (stat.type === "SymbolicLink") return "";
                    return path.join(yield* fs.realPath(ancestor), ...missing);
                  }
                  missing.unshift(path.basename(ancestor));
                  const parent = path.dirname(ancestor);
                  if (parent === ancestor) return "";
                  ancestor = parent;
                }
              }),
      }),
    );
    const relative = path.relative(root, resolved);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).includes(".git")
    )
      return false;
    return (
      profile.permissions.writablePaths.length === 0 ||
      profile.permissions.writablePaths.some(
        (prefix) => relative === prefix || relative.startsWith(`${prefix}${path.sep}`),
      )
    );
  },
  Effect.orElseSucceed(() => false),
);
