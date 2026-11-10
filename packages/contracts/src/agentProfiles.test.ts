import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AgentProfile, AgentProfileId, AgentProfileRepositoryFile } from "./agentProfiles.ts";

const decodeId = Schema.decodeUnknownSync(AgentProfileId);
const decode = Schema.decodeUnknownSync(AgentProfile);
const decodeRepository = Schema.decodeUnknownSync(AgentProfileRepositoryFile);

describe("agent profile documents", () => {
  it("rejects ambiguous identities and writable paths outside the workspace", () => {
    expect(decodeId("personal/worker")).toBe("personal/worker");
    expect(decodeId("project/worker")).toBe("project/worker");
    for (const id of ["worker", "personal/../worker", "project/", "global/worker"]) {
      expect(() => decodeId(id)).toThrow();
    }
    const profile = {
      id: "personal/worker",
      name: "Worker",
      description: "Implement assigned work",
      prompt: "Complete the assignment.",
      modelSelection: { instanceId: "codex", model: "test-model" },
      permissions: {
        filesystem: "workspace-write",
        commands: true,
        network: false,
        writablePaths: ["src"],
        nativeTools: [],
        mcpTools: [],
        approvalPolicy: "never",
        integrations: { commit: false, merge: false, publish: false },
      },
      delegation: { profiles: [], maxConcurrent: 4, maxAgents: 16, maxDepth: 3 },
      isolation: "worktree",
    };
    expect(decode(profile).permissions.writablePaths).toEqual(["src"]);
    for (const path of ["../other", "/tmp", "C:\\outside", "src/../../other", "src\\..\\other"]) {
      expect(() =>
        decode({ ...profile, permissions: { ...profile.permissions, writablePaths: [path] } }),
      ).toThrow();
    }
    expect(() =>
      decode({ ...profile, delegation: { ...profile.delegation, maxConcurrent: 0 } }),
    ).toThrow();
    expect(() => decodeRepository({ version: 1, profiles: [profile] })).toThrow();
  });
});
