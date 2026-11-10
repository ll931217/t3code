import * as Schema from "effect/Schema";
import {
  AgentDelegationLimits,
  AgentDelegationWritablePaths,
  AgentProfileId,
  AgentProfileSnapshot,
} from "./agentProfiles.ts";
import { ScopedThreadRef } from "./environment.ts";
import { CommandId, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Identity = TrimmedNonEmptyString.check(Schema.isMaxLength(2000));
export const AgentDelegationReservation = Schema.Struct({
  commandId: Identity,
  root: ScopedThreadRef,
  parent: ScopedThreadRef,
  child: ScopedThreadRef,
  snapshotId: Identity,
  requestKey: Identity,
  limits: AgentDelegationLimits,
  depth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })),
  status: Schema.Literals(["active", "queued", "waiting", "completed", "cancelled"]),
});
export type AgentDelegationReservation = typeof AgentDelegationReservation.Type;
export const AgentDelegationGrant = Schema.Struct({
  reservation: AgentDelegationReservation,
  token: Identity,
  snapshot: AgentProfileSnapshot,
  cancellationRequested: Schema.optional(Schema.Boolean),
});
export type AgentDelegationGrant = typeof AgentDelegationGrant.Type;
export const AgentDelegationReviewInput = Schema.Struct({
  projectId: ProjectId,
  profileId: AgentProfileId,
  snapshotId: Schema.optional(Identity),
  writablePaths: Schema.optional(AgentDelegationWritablePaths),
});
export const AgentDelegationReserveInput = Schema.Struct({
  parentToken: Identity,
  commandId: CommandId,
  child: ScopedThreadRef,
  projectId: ProjectId,
  snapshot: AgentProfileSnapshot,
  requestKey: Identity,
});
export const AgentDelegationTokenInput = Schema.Struct({
  token: Identity,
  forCancellation: Schema.optional(Schema.Boolean),
});
export const AgentDelegationRequestCancelInput = Schema.Struct({
  token: Identity,
  commandId: CommandId,
});
export type AgentDelegationRequestCancelInput = typeof AgentDelegationRequestCancelInput.Type;
export const AgentDelegationCancelInput = Schema.Struct({
  grant: AgentDelegationGrant,
  commandId: CommandId,
});
export type AgentDelegationCancelInput = typeof AgentDelegationCancelInput.Type;
export const AgentDelegationStatusInput = Schema.Struct({
  token: Identity,
  status: Schema.Literals(["active", "waiting", "completed", "cancelled"]),
  providerSuspended: Schema.Boolean,
  forCancellation: Schema.optional(Schema.Boolean),
});
export const AgentDelegationLaunchInput = Schema.Struct({
  grant: AgentDelegationGrant,
  projectId: ProjectId,
  title: Identity,
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(100_000)),
  commandId: CommandId,
});
export type AgentDelegationLaunchInput = typeof AgentDelegationLaunchInput.Type;
export const AGENT_DELEGATION_PEER_TOOLS = {
  review: "agent_delegation_review",
  reserve: "agent_delegation_reserve",
  status: "agent_delegation_status",
  transition: "agent_delegation_transition",
  launch: "agent_delegation_launch",
  admit: "agent_delegation_admit",
  requestCancel: "agent_delegation_request_cancel",
  cancel: "agent_delegation_cancel",
} as const;
