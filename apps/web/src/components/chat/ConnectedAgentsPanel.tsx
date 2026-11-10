import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveAgentExecutionGraph } from "@t3tools/client-runtime/state/agent-execution-graph";
import { CommandId, type ScopedThreadRef } from "@t3tools/contracts";
import { createAgentWorkspaceAtoms } from "@t3tools/client-runtime/state/agent-workspace";
import { agentExecutionEnvironment } from "../../state/agentExecution";
import { useProjects, useQuietThreadProjection, useQuietThreadShells } from "../../state/entities";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { AgentsPanel } from "./AgentsPanel";
import { AgentProfileDetails } from "./AgentProfileDetails";
import { environmentThreadDetails } from "../../state/threads";
import { AgentProfilesPanel } from "../settings/AgentProfilesPanel";
import { Button } from "../ui/button";

const agentWorkspace = createAgentWorkspaceAtoms({
  detail: environmentThreadDetails.quietThreadAtom,
  snapshots: agentExecutionEnvironment.snapshots,
  writable: agentExecutionEnvironment.update.permissionAtom,
  stoppable: agentExecutionEnvironment.stop.permissionAtom,
});

export function ConnectedAgentsPanel(props: { threadRef: ScopedThreadRef; visible: boolean }) {
  const [showProfiles, setShowProfiles] = useState(false);
  const shells = useQuietThreadShells();
  const projects = useProjects();
  const projectNames = new Map(
    projects.map((project) => [JSON.stringify([project.environmentId, project.id]), project.title]),
  );
  const currentThread = shells.find(
    (thread) =>
      thread.environmentId === props.threadRef.environmentId &&
      thread.id === props.threadRef.threadId,
  );
  const projection = useQuietThreadProjection(props.threadRef)?.projection;
  const graphInput = {
    root: props.threadRef,
    threads: shells.map((thread) => ({
      ref: scopeThreadRef(thread.environmentId, thread.id),
      parent:
        thread.delegatedFrom ??
        (thread.lineage.relationshipToParent === "subagent" && thread.lineage.parentThreadId
          ? scopeThreadRef(thread.environmentId, thread.lineage.parentThreadId)
          : null),
      title: thread.title,
      status: thread.runtime?.status ?? thread.latestRun?.status ?? null,
      model: thread.modelSelection.model,
      projectName:
        projectNames.get(JSON.stringify([thread.environmentId, thread.projectId])) ?? null,
    })),
    projections: projection ? [{ owner: props.threadRef, subagents: projection.subagents }] : [],
  };
  const shellGraph = deriveAgentExecutionGraph(graphInput);
  const projections = useAtomValue(
    agentWorkspace.projections(
      JSON.stringify(shellGraph.nodes.flatMap((node) => (node.ref ? [node.ref] : []))),
    ),
  );
  const graph = deriveAgentExecutionGraph({ ...graphInput, projections });
  const refs = graph.nodes.flatMap((node) => (node.ref ? [node.ref] : []));
  const data = useAtomValue(agentWorkspace.execution(JSON.stringify(refs)));
  const update = useAtomCommand(agentExecutionEnvironment.update, { reportFailure: false });
  const stop = useAtomCommand(agentExecutionEnvironment.stop, { reportFailure: false });
  const stopAgent = async (ref: ScopedThreadRef, scope: "node" | "subtree") => {
    const result = await stop({
      environmentId: ref.environmentId,
      input: { commandId: CommandId.make(randomUUID()), threadId: ref.threadId, scope },
    });
    if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
  };
  return (
    <>
      {currentThread ? (
        <div className="border-b border-border p-2">
          <Button size="xs" variant="outline" onClick={() => setShowProfiles(!showProfiles)}>
            {showProfiles ? "Back to execution tree" : "Manage profiles"}
          </Button>
        </div>
      ) : null}
      {showProfiles && currentThread ? (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <AgentProfilesPanel
            environmentId={props.threadRef.environmentId}
            projectId={currentThread.projectId}
            threadRef={props.threadRef}
          />
        </div>
      ) : null}
      {data.errors.length ? (
        <p role="status" className="border-b border-border p-2 text-xs text-muted-foreground">
          Some agent details are unavailable: {[...new Set(data.errors)].join(" · ")}
        </p>
      ) : null}
      <AgentsPanel
        {...props}
        visible={props.visible && !showProfiles}
        graph={graph}
        renderMetadata={(ref) => <AgentProfileDetails key={scopedThreadKey(ref)} threadRef={ref} />}
        executionRecords={data.records}
        communications={data.communications}
        liveCommunications={data.liveCommunications}
        writableEnvironments={data.writable}
        stoppableEnvironments={data.stoppable}
        onStopNode={(ref) => stopAgent(ref, "node")}
        onCancelSubtree={(ref) => stopAgent(ref, "subtree")}
        onUpdate={async (ref, record, confirmVerificationIds) => {
          const result = await update({
            environmentId: ref.environmentId,
            input: {
              threadId: ref.threadId,
              commandId: CommandId.make(randomUUID()),
              expectedRevision: record.revision,
              objective: record.objective,
              tasks: record.tasks,
              verifications: record.verifications.map(
                ({ provenance: _provenance, freshness: _freshness, ...check }) => check,
              ),
              ...(confirmVerificationIds ? { confirmVerificationIds } : {}),
            },
          });
          if (result._tag === "Failure") throw new Error(formatEnvironmentQueryError(result.cause));
        }}
      />
    </>
  );
}
