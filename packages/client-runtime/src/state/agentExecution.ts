import type { AgentExecutionSnapshot } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function agentExecutionSnapshotsWithActivity<E, R>(
  stream: Stream.Stream<AgentExecutionSnapshot, E, R>,
) {
  return stream.pipe(
    Stream.mapAccum(
      () => null as ReadonlyMap<string, string> | null,
      (previous, snapshot) => {
        const liveCommunications =
          previous === null
            ? []
            : snapshot.communications.filter((entry) => previous.get(entry.id) !== entry.status);
        return [
          new Map(snapshot.communications.map((entry) => [entry.id, entry.status])),
          [
            {
              ...snapshot,
              liveCommunications,
            } satisfies AgentExecutionSnapshot & {
              liveCommunications: typeof liveCommunications;
            },
          ],
        ] as const;
      },
    ),
    Stream.rechunk(1),
  );
}

export function createAgentExecutionEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    snapshots: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:agent-execution:snapshots",
      tag: "agentExecution.subscribe",
      idleTtlMs: 0,
      transform: agentExecutionSnapshotsWithActivity,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-execution:update",
      tag: "agentExecution.update",
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-execution:stop",
      tag: "agentExecution.stop",
    }),
  };
}
