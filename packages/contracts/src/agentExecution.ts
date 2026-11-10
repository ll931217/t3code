import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ScopedThreadRef } from "./environment.ts";

const ItemId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const Title = TrimmedNonEmptyString.check(Schema.isMaxLength(500));
const Summary = Schema.String.check(Schema.isMaxLength(16_000));

export const AgentExecutionActor = Schema.Literals(["user", "agent", "server"]);
export type AgentExecutionActor = typeof AgentExecutionActor.Type;

export const AgentExecutionTask = Schema.Struct({
  id: ItemId,
  title: Title,
  status: Schema.Literals(["pending", "in-progress", "blocked", "done"]),
  child: Schema.optionalKey(ScopedThreadRef),
});
export type AgentExecutionTask = typeof AgentExecutionTask.Type;

export const AgentVerificationEvidence = Schema.Struct({
  kind: Schema.Literals(["command", "test", "capture", "manual", "other"]),
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)),
  reference: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
});
export type AgentVerificationEvidence = typeof AgentVerificationEvidence.Type;

export const AgentVerificationInput = Schema.Struct({
  id: ItemId,
  title: Title,
  status: Schema.Literals(["pending", "running", "passed", "failed", "skipped"]),
  evidence: Schema.Array(AgentVerificationEvidence).check(Schema.isMaxLength(32)),
  checkpoint: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type AgentVerificationInput = typeof AgentVerificationInput.Type;

export const AgentVerification = Schema.Struct({
  ...AgentVerificationInput.fields,
  provenance: Schema.Literals(["agent-reported", "server-observed", "user-confirmed"]),
  freshness: Schema.Literals(["current", "stale", "unknown"]),
});
export type AgentVerification = typeof AgentVerification.Type;

export const AgentExecutionRecord = Schema.Struct({
  threadId: ThreadId,
  objective: Summary,
  revision: NonNegativeInt,
  tasks: Schema.Array(AgentExecutionTask).check(Schema.isMaxLength(200)),
  verifications: Schema.Array(AgentVerification).check(Schema.isMaxLength(200)),
  checkpoint: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
  updatedBy: AgentExecutionActor,
});
export type AgentExecutionRecord = typeof AgentExecutionRecord.Type;

export const AgentExecutionUpdateInput = Schema.Struct({
  threadId: ThreadId,
  commandId: CommandId,
  expectedRevision: NonNegativeInt,
  objective: Summary,
  tasks: Schema.Array(AgentExecutionTask).check(Schema.isMaxLength(200)),
  verifications: Schema.Array(AgentVerificationInput).check(Schema.isMaxLength(200)),
  confirmVerificationIds: Schema.optionalKey(Schema.Array(ItemId).check(Schema.isMaxLength(200))),
});
export type AgentExecutionUpdateInput = typeof AgentExecutionUpdateInput.Type;

export const AgentExecutionUpdateResult = Schema.Struct({
  record: AgentExecutionRecord,
  duplicate: Schema.Boolean,
  steeringRequired: Schema.Boolean,
});
export type AgentExecutionUpdateResult = typeof AgentExecutionUpdateResult.Type;

export const AgentCommunicationInput = Schema.Struct({
  id: ItemId,
  source: ScopedThreadRef,
  target: ScopedThreadRef,
  kind: Schema.Literals(["dispatch", "message", "result"]),
  status: Schema.Literals(["sent", "delivered", "acknowledged"]),
  summary: Summary,
});
export type AgentCommunicationInput = typeof AgentCommunicationInput.Type;

export const AgentCommunication = Schema.Struct({
  ...AgentCommunicationInput.fields,
  occurredAt: IsoDateTime,
});
export type AgentCommunication = typeof AgentCommunication.Type;

export class AgentExecutionError extends Schema.TaggedError<AgentExecutionError>()(
  "AgentExecutionError",
  {
    reason: Schema.Literals([
      "storage",
      "invalid-input",
      "revision-conflict",
      "command-conflict",
      "duplicate-item",
      "missing-evidence",
      "confirmation-required",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "storage":
        return "Unable to access agent execution records.";
      case "invalid-input":
        return "The agent execution update is invalid.";
      case "revision-conflict":
        return "The execution record changed. Reload it before editing.";
      case "command-conflict":
        return "This command identifier already belongs to a different operation.";
      case "duplicate-item":
        return "Checklist item identifiers must be unique.";
      case "missing-evidence":
        return "A passed verification requires supporting evidence.";
      case "confirmation-required":
        return "Explicitly confirm this verification before recording a manual pass.";
    }
  }
}
