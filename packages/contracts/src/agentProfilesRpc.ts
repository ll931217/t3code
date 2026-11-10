import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { CommandId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ScopedThreadRef } from "./environment.ts";
import {
  AgentProfileCatalogEntry,
  AgentProfileError,
  AgentProfileId,
  AgentProfileLookup,
  AgentProfileSaveInput,
  AgentProfileSnapshot,
  AgentProfileTrustInput,
} from "./agentProfiles.ts";
import {
  AgentCommunication,
  AgentExecutionError,
  AgentExecutionRecord,
  AgentExecutionUpdateInput,
  AgentExecutionUpdateResult,
} from "./agentExecution.ts";
import {
  OrchestrationV2ThreadLaunchInput,
  OrchestrationV2ThreadLaunchResult,
} from "./orchestrationV2.ts";

const ProfileError = Schema.Union([AgentProfileError, EnvironmentAuthorizationError]);
const ExecutionError = Schema.Union([AgentExecutionError, EnvironmentAuthorizationError]);
const ThreadInput = Schema.Struct({ threadId: ThreadId });
const ThreadListInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(1025)),
});
const ScopedThreadsInput = Schema.Struct({
  threads: Schema.Array(ScopedThreadRef).check(Schema.isMaxLength(1025)),
});

export const AgentExecutionSnapshot = Schema.Struct({
  records: Schema.Array(AgentExecutionRecord),
  communications: Schema.Array(AgentCommunication),
});
export type AgentExecutionSnapshot = typeof AgentExecutionSnapshot.Type;

export const AgentExecutionStopInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  scope: Schema.Literals(["node", "subtree"]),
});
export type AgentExecutionStopInput = typeof AgentExecutionStopInput.Type;

export const AgentProfileLaunchInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  profileId: AgentProfileId,
  title: TrimmedNonEmptyString,
  baseRef: Schema.optionalKey(TrimmedNonEmptyString),
  initialMessage: OrchestrationV2ThreadLaunchInput.fields.initialMessage,
});
export type AgentProfileLaunchInput = typeof AgentProfileLaunchInput.Type;

export const AgentProfileRpcs = [
  Rpc.make("agentProfiles.list", {
    payload: Schema.Struct({ projectId: ProjectId }),
    success: Schema.Array(AgentProfileCatalogEntry),
    error: ProfileError,
  }),
  Rpc.make("agentProfiles.save", {
    payload: AgentProfileSaveInput,
    success: Schema.Void,
    error: ProfileError,
  }),
  Rpc.make("agentProfiles.remove", {
    payload: AgentProfileLookup,
    success: Schema.Void,
    error: ProfileError,
  }),
  Rpc.make("agentProfiles.review", {
    payload: AgentProfileLookup,
    success: AgentProfileSnapshot,
    error: ProfileError,
  }),
  Rpc.make("agentProfiles.trust", {
    payload: AgentProfileTrustInput,
    success: AgentProfileSnapshot,
    error: ProfileError,
  }),
  Rpc.make("agentProfiles.threadSnapshot", {
    payload: ThreadInput,
    success: Schema.NullOr(AgentProfileSnapshot),
    error: ProfileError,
  }),
  Rpc.make("agentProfiles.launch", {
    payload: AgentProfileLaunchInput,
    success: OrchestrationV2ThreadLaunchResult,
    error: ProfileError,
  }),
  Rpc.make("agentProfiles.apply", {
    payload: Schema.Struct({ ...AgentProfileLookup.fields, threadId: ThreadId }),
    success: AgentProfileSnapshot,
    error: ProfileError,
  }),
  Rpc.make("agentProfiles.revoke", {
    payload: Schema.Struct({ snapshotId: TrimmedNonEmptyString }),
    success: Schema.Array(ThreadId),
    error: ProfileError,
  }),
  Rpc.make("agentExecution.list", {
    payload: ThreadListInput,
    success: Schema.Array(AgentExecutionRecord),
    error: ExecutionError,
  }),
  Rpc.make("agentExecution.update", {
    payload: AgentExecutionUpdateInput,
    success: AgentExecutionUpdateResult,
    error: ExecutionError,
  }),
  Rpc.make("agentExecution.stop", {
    payload: AgentExecutionStopInput,
    success: Schema.Void,
    error: ExecutionError,
  }),
  Rpc.make("agentExecution.history", {
    payload: ThreadInput,
    success: Schema.Array(AgentExecutionRecord),
    error: ExecutionError,
  }),
  Rpc.make("agentExecution.communications", {
    payload: ScopedThreadsInput,
    success: Schema.Array(AgentCommunication),
    error: ExecutionError,
  }),
  Rpc.make("agentExecution.subscribe", {
    payload: ScopedThreadsInput,
    success: AgentExecutionSnapshot,
    error: ExecutionError,
    stream: true,
  }),
] as const;
