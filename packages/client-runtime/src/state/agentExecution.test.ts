import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type AgentCommunication } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { agentExecutionSnapshotsWithActivity } from "./agentExecution.ts";

it.effect("baselines each subscription and emits only changed communication statuses", () =>
  Effect.gen(function* () {
    const ref = { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("root") };
    const sent: AgentCommunication = {
      id: "dispatch",
      source: ref,
      target: { ...ref, threadId: ThreadId.make("worker") },
      kind: "dispatch",
      status: "sent",
      summary: "Parse",
      occurredAt: "2026-11-09T00:00:00Z",
    };
    const delivered = { ...sent, status: "delivered" as const };
    const snapshots = Stream.make(
      { records: [], communications: [sent] },
      { records: [], communications: [sent] },
      { records: [], communications: [delivered] },
      { records: [], communications: [delivered] },
    ).pipe(agentExecutionSnapshotsWithActivity);
    for (const values of [
      yield* Stream.runCollect(snapshots),
      yield* Stream.runCollect(snapshots),
    ]) {
      expect(values.map((snapshot) => snapshot.liveCommunications)).toEqual([
        [],
        [],
        [delivered],
        [],
      ]);
    }
  }),
);
