import { expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  type AgentExecutionRecord,
  type AgentExecutionSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { createAgentWorkspaceAtoms } from "./agentWorkspace.ts";
import { scopedThreadKey } from "../environment/index.ts";

it("keeps environment identities and permissions separate when one execution stream fails", () => {
  const local = { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("same-id") };
  const remote = { ...local, environmentId: EnvironmentId.make("remote") };
  const record: AgentExecutionRecord = {
    threadId: local.threadId,
    objective: "Local objective",
    revision: 1,
    tasks: [],
    verifications: [],
    checkpoint: null,
    updatedAt: "2026-11-09T00:00:00Z",
    updatedBy: "user",
  };
  const snapshots = Atom.family((id: EnvironmentId) =>
    Atom.make(
      AsyncResult.success({
        records: [
          {
            ...record,
            objective: id === local.environmentId ? "Local objective" : "Remote objective",
          },
        ],
        communications: [],
        liveCommunications: [],
      }) as AsyncResult.AsyncResult<AgentExecutionSnapshot & { liveCommunications: [] }, Error>,
    ),
  );
  const workspace = createAgentWorkspaceAtoms({
    detail: () => Atom.make(null),
    snapshots: ({ environmentId }) => snapshots(environmentId),
    writable: (id) => Atom.make(id === local.environmentId),
    stoppable: () => Atom.make(true),
  });
  const registry = AtomRegistry.make();
  try {
    const atom = workspace.execution(JSON.stringify([local, remote]));
    registry.mount(atom);
    expect(registry.get(atom).records.get(scopedThreadKey(local))?.objective).toBe(
      "Local objective",
    );
    expect(registry.get(atom).records.get(scopedThreadKey(remote))?.objective).toBe(
      "Remote objective",
    );
    expect([...registry.get(atom).writable]).toEqual([local.environmentId]);
    registry.set(
      snapshots(remote.environmentId),
      AsyncResult.failure(Cause.fail(new Error("Remote disconnected"))),
    );
    expect(registry.get(atom).errors).toEqual(["Remote disconnected"]);
    expect(registry.get(atom).records.get(scopedThreadKey(local))?.objective).toBe(
      "Local objective",
    );
  } finally {
    registry.dispose();
  }
});
