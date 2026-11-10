import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

const OwnedPath = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (!value.includes("\\") &&
        !value.includes(":") &&
        value
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git")) ||
      "Expected a relative repository path without traversal or Git metadata.",
  ),
);

export const AgentWorktreeActionInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("commit"),
    message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000)),
    paths: Schema.Array(OwnedPath).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  }),
  Schema.Struct({ action: Schema.Literal("merge"), sourceThreadId: ThreadId }),
  Schema.Struct({ action: Schema.Literal("publish") }),
]);
export type AgentWorktreeActionInput = typeof AgentWorktreeActionInput.Type;

export const AgentWorktreeActionResult = Schema.Struct({
  action: Schema.Literals(["commit", "merge", "publish"]),
  commitSha: Schema.String,
});
export type AgentWorktreeActionResult = typeof AgentWorktreeActionResult.Type;

export class AgentWorktreeActionError extends Schema.TaggedError<AgentWorktreeActionError>()(
  "AgentWorktreeActionError",
  {
    message: Schema.String,
  },
) {}
