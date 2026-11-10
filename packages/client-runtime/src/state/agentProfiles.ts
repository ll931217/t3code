import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
export { createAgentProfileTemplate } from "./agentProfileTemplates.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createAgentProfileEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const threadSnapshot = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:agent-profiles:thread-snapshot",
    tag: "agentProfiles.threadSnapshot",
    staleTimeMs: 0,
    idleTtlMs: 0,
  });
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:agent-profiles:list",
    tag: "agentProfiles.list",
    staleTimeMs: 0,
    idleTtlMs: 0,
  });
  return {
    list,
    threadSnapshot,
    review: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agent-profiles:review",
      tag: "agentProfiles.review",
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    save: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-profiles:save",
      tag: "agentProfiles.save",
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() =>
          registry.refresh(list({ environmentId, input: { projectId: input.projectId } })),
        ),
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-profiles:remove",
      tag: "agentProfiles.remove",
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() =>
          registry.refresh(list({ environmentId, input: { projectId: input.projectId } })),
        ),
    }),
    trust: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-profiles:trust",
      tag: "agentProfiles.trust",
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() =>
          registry.refresh(list({ environmentId, input: { projectId: input.projectId } })),
        ),
    }),
    revoke: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-profiles:revoke",
      tag: "agentProfiles.revoke",
    }),
    launch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-profiles:launch",
      tag: "agentProfiles.launch",
    }),
    apply: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-profiles:apply",
      tag: "agentProfiles.apply",
      onSuccess: ({ environmentId, input }, registry) =>
        Effect.sync(() =>
          registry.refresh(threadSnapshot({ environmentId, input: { threadId: input.threadId } })),
        ),
    }),
  };
}
