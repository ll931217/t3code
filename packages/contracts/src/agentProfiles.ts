import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderApprovalPolicy } from "./providerPolicy.ts";

export const AgentProfileId = Schema.String.check(
  Schema.isPattern(/^(personal|project)\/[a-z0-9][a-z0-9_-]{0,63}$/),
);
export type AgentProfileId = typeof AgentProfileId.Type;

const AgentWritablePath = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      (!value.startsWith("/") &&
        !value.includes("\\") &&
        !value.includes(":") &&
        value.split("/").every((part) => part !== ".." && part !== "." && part.length > 0)) ||
      "Expected a relative workspace path without parent traversal.",
  ),
);

export const AgentDelegationWritablePaths = Schema.Array(AgentWritablePath).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
);

export const AgentProfilePermissions = Schema.Struct({
  filesystem: Schema.Literals(["read-only", "workspace-write"]),
  commands: Schema.Boolean,
  network: Schema.Boolean,
  writablePaths: Schema.Array(AgentWritablePath),
  nativeTools: Schema.Union([
    Schema.Literal("capability-defaults"),
    Schema.Array(TrimmedNonEmptyString),
  ]),
  mcpTools: Schema.Array(TrimmedNonEmptyString),
  approvalPolicy: ProviderApprovalPolicy,
  integrations: Schema.Struct({
    commit: Schema.Boolean,
    merge: Schema.Boolean,
    publish: Schema.Boolean,
  }),
});
export type AgentProfilePermissions = typeof AgentProfilePermissions.Type;

export const AgentDelegationLimits = Schema.Struct({
  maxConcurrent: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
  maxAgents: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 })),
  maxDepth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })),
});
export type AgentDelegationLimits = typeof AgentDelegationLimits.Type;
export const AgentProfile = Schema.Struct({
  id: AgentProfileId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  description: Schema.String.check(Schema.isMaxLength(2000)),
  prompt: Schema.String.check(Schema.isMaxLength(100_000)),
  modelSelection: ModelSelection,
  permissions: AgentProfilePermissions,
  delegation: Schema.Struct({
    profiles: Schema.Array(AgentProfileId),
    ...AgentDelegationLimits.fields,
  }),
  isolation: Schema.Literals(["worktree", "shared"]),
});
export type AgentProfile = typeof AgentProfile.Type;

export const AgentProfileRepositoryFile = Schema.Struct({
  version: Schema.Literal(1),
  profiles: Schema.Array(AgentProfile).check(
    Schema.isMaxLength(100),
    Schema.makeFilter(
      (profiles) =>
        profiles.every((profile) => profile.id.startsWith("project/")) ||
        "Repository profiles must use project-qualified identities.",
    ),
    Schema.makeFilter(
      (profiles) =>
        new Set(profiles.map((profile) => profile.id)).size === profiles.length ||
        "Profile identities must be unique.",
    ),
  ),
});
export type AgentProfileRepositoryFile = typeof AgentProfileRepositoryFile.Type;

export const AgentProfileVersion = Schema.Struct({
  profile: AgentProfile,
  fingerprint: TrimmedNonEmptyString,
  sourceProjectId: Schema.NullOr(ProjectId),
});
export type AgentProfileVersion = typeof AgentProfileVersion.Type;

export const AgentProfileSnapshot = Schema.Struct({
  id: TrimmedNonEmptyString,
  root: AgentProfileVersion,
  dependencies: Schema.Array(AgentProfileVersion),
  writablePaths: Schema.optional(AgentDelegationWritablePaths),
});
export type AgentProfileSnapshot = typeof AgentProfileSnapshot.Type;

export const AgentProfileCatalogEntry = Schema.Struct({
  version: AgentProfileVersion,
  reviewFingerprint: TrimmedNonEmptyString,
  trusted: Schema.Boolean,
  revoked: Schema.Boolean,
  unresolvedProfiles: Schema.Array(AgentProfileId),
});
export type AgentProfileCatalogEntry = typeof AgentProfileCatalogEntry.Type;

export const AgentProfileScope = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
});
export type AgentProfileScope = typeof AgentProfileScope.Type;

export const AgentProfileLookup = Schema.Struct({
  projectId: ProjectId,
  profileId: AgentProfileId,
});
export type AgentProfileLookup = typeof AgentProfileLookup.Type;

export const AgentProfileTrustInput = Schema.Struct({
  ...AgentProfileLookup.fields,
  expectedFingerprint: TrimmedNonEmptyString,
});
export type AgentProfileTrustInput = typeof AgentProfileTrustInput.Type;

export const AgentProfileSaveInput = Schema.Struct({ projectId: ProjectId, profile: AgentProfile });
export type AgentProfileSaveInput = typeof AgentProfileSaveInput.Type;

export const AgentProfilePinInput = Schema.Struct({
  threadId: ThreadId,
  snapshotId: TrimmedNonEmptyString,
});
export type AgentProfilePinInput = typeof AgentProfilePinInput.Type;

export class AgentProfileError extends Schema.TaggedError<AgentProfileError>()(
  "AgentProfileError",
  {
    reason: Schema.Literals([
      "not-found",
      "invalid-document",
      "untrusted",
      "revoked",
      "changed",
      "storage",
      "wrong-scope",
      "snapshot-conflict",
      "unsupported",
      "model-unavailable",
    ]),
    profileId: Schema.optional(AgentProfileId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return "The agent profile or snapshot was not found.";
      case "invalid-document":
        return "The agent profile document is invalid.";
      case "untrusted":
        return "Review and trust this exact agent profile configuration before running it.";
      case "revoked":
        return "Access to this agent profile configuration has been revoked.";
      case "changed":
        return "The agent profile changed after it was reviewed. Review the current configuration.";
      case "wrong-scope":
        return "The agent profile identity does not match its storage scope.";
      case "snapshot-conflict":
        return "This thread already uses another agent profile snapshot. Apply updates explicitly.";
      case "storage":
        return "The agent profile operation could not be persisted or loaded.";
      case "unsupported":
        return "This provider cannot enforce the agent profile's requested capabilities and tool restrictions.";
      case "model-unavailable":
        return "The agent profile's selected provider or model is unavailable.";
    }
  }
}
