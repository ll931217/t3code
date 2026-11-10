import { AgentProfile, ProviderDriverKind } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import { agentProfileAllowsClaudeTool } from "./claudeAgentProfile.ts";
import { codexAgentProfileConfig, codexAgentProfileContext } from "./codexAgentProfile.ts";
import { makeClaudeQueryOptions } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

import { assertAgentProfileCompatible } from "./agentProfilePolicy.ts";

const decode = Schema.decodeUnknownSync(AgentProfile);
const readOnly = decode({
  id: "personal/reviewer",
  name: "Reviewer",
  description: "Review work",
  prompt: "Review the assignment.",
  modelSelection: { instanceId: "claude", model: "test-model" },
  permissions: {
    filesystem: "read-only",
    commands: false,
    network: false,
    writablePaths: [],
    nativeTools: ["Read", "Glob", "Grep"],
    mcpTools: [],
    approvalPolicy: "never",
    integrations: { commit: false, merge: false, publish: false },
  },
  delegation: { profiles: [], maxConcurrent: 4, maxAgents: 16, maxDepth: 3 },
  isolation: "worktree",
});

it.effect("rejects guarantees the selected provider cannot enforce before launching", () =>
  Effect.gen(function* () {
    yield* assertAgentProfileCompatible(readOnly, ProviderDriverKind.make("claudeAgent"));
    for (const [candidate, driver] of [
      [readOnly, "cursor"],
      [readOnly, "codex"],
      [
        { ...readOnly, permissions: { ...readOnly.permissions, mcpTools: ["t3_thread_send"] } },
        "claudeAgent",
      ],
      [
        { ...readOnly, permissions: { ...readOnly.permissions, nativeTools: ["Agent"] } },
        "claudeAgent",
      ],
      [
        { ...readOnly, permissions: { ...readOnly.permissions, commands: true, network: true } },
        "claudeAgent",
      ],
      [
        { ...readOnly, permissions: { ...readOnly.permissions, nativeTools: ["Write"] } },
        "claudeAgent",
      ],
    ] as const) {
      expect(
        (yield* Effect.flip(
          assertAgentProfileCompatible(candidate, ProviderDriverKind.make(driver)),
        )).reason,
      ).toBe("unsupported");
    }
  }),
);

it.effect("rejects write escapes, symlinks, native spawning and unselected MCP tools", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const outside = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${root}/src`);
    yield* fs.symlink(outside, `${root}/src/escape`);
    yield* fs.symlink(`${outside}/missing`, `${root}/src/dangling`);
    const writer: AgentProfile = {
      ...readOnly,
      permissions: {
        ...readOnly.permissions,
        filesystem: "workspace-write",
        nativeTools: "capability-defaults",
        writablePaths: ["src"],
        mcpTools: ["delegate_task"],
      },
    };
    const allowed = (tool: string, file: string) =>
      agentProfileAllowsClaudeTool(writer, root, tool, { file_path: file });
    expect(yield* allowed("Write", "src/new.ts")).toBe(true);
    expect(yield* allowed("Write", "src/new/nested/file.ts")).toBe(true);
    for (const file of [
      "other.ts",
      "../outside.ts",
      "src/escape/new.ts",
      "src/dangling",
      "src/.git/config",
    ]) {
      expect(yield* allowed("Write", file)).toBe(false);
    }
    expect(yield* allowed("Agent", "")).toBe(false);
    expect(yield* allowed("Bash", "")).toBe(false);
    expect(yield* allowed("mcp__t3-code__delegate_task", "")).toBe(true);
    expect(yield* allowed("mcp__other__delegate_task", "")).toBe(false);
    expect(yield* allowed("mcp__t3-code__publish", "")).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("preserves an entire Unicode role prompt within Codex's per-entry byte cap", () => {
  const prompt = "🔒".repeat(3000) + "End of role instructions";
  const entries = Object.values(codexAgentProfileContext({ ...readOnly, prompt }));
  expect(entries.map((entry) => entry.value).join("")).toBe(prompt);
  expect(entries.every((entry) => new TextEncoder().encode(entry.value).length <= 4000)).toBe(true);
});

it("isolates profile tools and permissions from inherited Claude launch settings", () => {
  const options = makeClaudeQueryOptions({
    agentProfile: readOnly,
    projectInstructions: "Repository instructions remain active.",
    modelSelection: readOnly.modelSelection,
    nativeThreadId: "profile-test",
    resume: false,
    cwd: "/workspace",
    sdkSettings: { permissions: { allow: ["Bash", "Write"], defaultMode: "bypassPermissions" } },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools: ["Bash", "Write", "mcp__t3-code__*"],
  });
  expect(options.permissionMode).toBe("default");
  expect(options.allowDangerouslySkipPermissions).toBe(false);
  expect(options.tools).toEqual(["Read", "Glob", "Grep"]);
  expect(options.allowedTools).toEqual([]);
  expect(options.settingSources).toEqual([]);
  expect(options.strictMcpConfig).toBe(true);
  expect(options.settings).not.toHaveProperty("permissions");
  expect(options.systemPrompt).toMatchObject({ append: expect.stringContaining(readOnly.prompt) });
  expect(options.systemPrompt).toMatchObject({
    append: expect.stringContaining("Repository instructions remain active."),
  });
  expect(options.sandbox).toMatchObject({
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [], strictAllowlist: true },
  });
});

it("approves only explicitly selected Codex MCP tools", () => {
  const profile = {
    ...readOnly,
    permissions: {
      ...readOnly.permissions,
      mcpTools: ["agent_execution_read", "agent_execution_update"],
    },
  };
  const config = codexAgentProfileConfig(profile, {}, { url: "http://localhost/mcp" });
  expect(config.mcp_servers).toEqual({
    "t3-code": {
      url: "http://localhost/mcp",
      enabled: true,
      enabled_tools: ["agent_execution_read", "agent_execution_update"],
      default_tools_approval_mode: "prompt",
      tools: {
        agent_execution_read: { approval_mode: "approve" },
        agent_execution_update: { approval_mode: "approve" },
      },
    },
  });
});
