import type {
  AgentCommunication,
  AgentExecutionRecord,
  AgentExecutionSnapshot,
  EnvironmentId,
  OrchestrationV2ThreadProjection,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom, AsyncResult } from "effect/reactivity";
import { scopedThreadKey, scopeThreadRef } from "../environment/index.ts";

export function createAgentWorkspaceAtoms<E>(input: {
  detail: (ref: ScopedThreadRef) => Atom.Atom<{
    readonly projection: { readonly subagents: OrchestrationV2ThreadProjection["subagents"] };
  } | null>;
  snapshots: (target: {
    environmentId: EnvironmentId;
    input: { threads: ReadonlyArray<ScopedThreadRef> };
  }) => Atom.Atom<
    AsyncResult.AsyncResult<
      AgentExecutionSnapshot & { liveCommunications: ReadonlyArray<AgentCommunication> },
      E
    >
  >;
  writable: (environmentId: EnvironmentId) => Atom.Atom<boolean>;
  stoppable: (environmentId: EnvironmentId) => Atom.Atom<boolean>;
}) {
  const projections = Atom.family((key: string) =>
    Atom.make((get) => {
      const queue = JSON.parse(key) as ScopedThreadRef[];
      const visited = new Set<string>();
      const values: Array<{
        owner: ScopedThreadRef;
        subagents: OrchestrationV2ThreadProjection["subagents"];
      }> = [];
      for (let index = 0; index < queue.length && visited.size < 1025; index++) {
        const owner = queue[index]!;
        if (visited.has(scopedThreadKey(owner))) continue;
        visited.add(scopedThreadKey(owner));
        const projection = get(input.detail(owner))?.projection;
        if (!projection) continue;
        values.push({ owner, subagents: projection.subagents });
        for (const agent of projection.subagents) {
          const child =
            agent.remoteChild ??
            (agent.childThreadId ? scopeThreadRef(owner.environmentId, agent.childThreadId) : null);
          if (child && !visited.has(scopedThreadKey(child))) queue.push(child);
        }
      }
      return values;
    }),
  );
  const execution = Atom.family((key: string) => {
    const refs = JSON.parse(key) as ScopedThreadRef[];
    const groups = new Map<EnvironmentId, ScopedThreadRef[]>();
    for (const ref of refs) {
      const group = groups.get(ref.environmentId) ?? [];
      group.push(ref);
      groups.set(ref.environmentId, group);
    }
    return Atom.make((get) => {
      const records = new Map<string, AgentExecutionRecord>();
      const communications = new Map<string, AgentCommunication>();
      const liveCommunications = new Map<string, AgentCommunication>();
      const writable = new Set<EnvironmentId>();
      const stoppable = new Set<EnvironmentId>();
      const errors: string[] = [];
      for (const [environmentId, threads] of groups) {
        const result = get(input.snapshots({ environmentId, input: { threads } }));
        const snapshot = AsyncResult.getOrElse(result, () => null);
        if (result._tag === "Failure") {
          const cause = Cause.squash(result.cause);
          errors.push(cause instanceof Error ? cause.message : "An environment is unavailable.");
        }
        for (const record of snapshot?.records ?? [])
          records.set(scopedThreadKey(scopeThreadRef(environmentId, record.threadId)), record);
        for (const entry of snapshot?.communications ?? [])
          communications.set(JSON.stringify([entry.source.environmentId, entry.id]), entry);
        for (const entry of snapshot?.liveCommunications ?? [])
          liveCommunications.set(JSON.stringify([entry.source.environmentId, entry.id]), entry);
        if (get(input.writable(environmentId))) writable.add(environmentId);
        if (get(input.stoppable(environmentId))) stoppable.add(environmentId);
      }
      return {
        records,
        communications: [...communications.values()],
        liveCommunications: [...liveCommunications.values()],
        writable,
        stoppable,
        errors,
      };
    });
  });
  return { projections, execution };
}
