import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { CommandId, type ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveAgentExecutionGraph } from "@t3tools/client-runtime/state/agent-execution-graph";
import * as Cause from "effect/Cause";
import { useProjects } from "../../state/entities";
import { environmentThreadShells } from "../../state/threads";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { agentExecutionEnvironment, agentWorkspace } from "../../state/agentExecution";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { AppText as Text } from "../../components/ui/AppText";
import { AgentExecutionTree } from "./AgentExecutionTree";
import { AgentExecutionDetails } from "./AgentExecutionDetails";
import { AgentProfilesPanel } from "./AgentProfilesPanel";
import { Button } from "../../components/ui/Button";

export function AgentExecutionWorkspace(props: {
  threadRef: ScopedThreadRef;
  onOpen: (ref: ScopedThreadRef) => void;
}) {
  const [showProfiles, setShowProfiles] = useState(false);
  const shells = useAtomValue(environmentThreadShells.quietThreadShellsAtom);
  const projects = useProjects();
  const projectNames = new Map(
    projects.map((project) => [JSON.stringify([project.environmentId, project.id]), project.title]),
  );
  const currentThread = shells.find(
    (thread) =>
      thread.environmentId === props.threadRef.environmentId &&
      thread.id === props.threadRef.threadId,
  );
  const projection = useQuietThreadStructure(props.threadRef)?.projection;
  const input = {
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
  const shellGraph = deriveAgentExecutionGraph(input);
  const projections = useAtomValue(
    agentWorkspace.projections(
      JSON.stringify(shellGraph.nodes.flatMap((node) => (node.ref ? [node.ref] : []))),
    ),
  );
  const graph = deriveAgentExecutionGraph({ ...input, projections });
  const data = useAtomValue(
    agentWorkspace.execution(
      JSON.stringify(graph.nodes.flatMap((node) => (node.ref ? [node.ref] : []))),
    ),
  );
  const [selectedKey, setSelectedKey] = useState(graph.rootKey);
  const selected = graph.nodes.find((node) => node.key === selectedKey) ?? graph.nodes[0]!;
  const update = useAtomCommand(agentExecutionEnvironment.update, { reportFailure: false });
  const stop = useAtomCommand(agentExecutionEnvironment.stop, { reportFailure: false });
  return (
    <ScrollView
      className="flex-1"
      nestedScrollEnabled
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-4 p-5 pb-10"
      keyboardShouldPersistTaps="handled"
    >
      {currentThread ? (
        <Button
          label={showProfiles ? "Back to execution tree" : "Manage profiles"}
          onPress={() => setShowProfiles(!showProfiles)}
        />
      ) : null}
      {showProfiles && currentThread ? (
        <AgentProfilesPanel
          threadRef={props.threadRef}
          projectId={currentThread.projectId}
          onOpen={props.onOpen}
        />
      ) : null}
      <View style={showProfiles ? { display: "none" } : undefined} className="gap-4">
        {data.errors.length ? (
          <Text className="text-xs text-danger-foreground">
            Some details are unavailable: {[...new Set(data.errors)].join(" · ")}
          </Text>
        ) : null}
        <AgentExecutionTree
          graph={graph}
          liveCommunications={data.liveCommunications}
          visible={!showProfiles}
          records={data.records}
          selectedKey={selected.key}
          onSelect={(node) => setSelectedKey(node.key)}
        />
        <AgentExecutionDetails
          key={selected.key}
          node={selected}
          record={selected.ref ? data.records.get(scopedThreadKey(selected.ref)) : undefined}
          onOpen={props.onOpen}
          onUpdate={
            selected.ref && data.writable.has(selected.ref.environmentId)
              ? async (record, confirmed) => {
                  const ref = selected.ref!;
                  const result = await update({
                    environmentId: ref.environmentId,
                    input: {
                      commandId: CommandId.make(uuidv4()),
                      threadId: ref.threadId,
                      expectedRevision: record.revision,
                      objective: record.objective,
                      tasks: record.tasks,
                      verifications: record.verifications.map(
                        ({ provenance: _provenance, freshness: _freshness, ...check }) => check,
                      ),
                      confirmVerificationIds: confirmed,
                    },
                  });
                  if (result._tag === "Failure") throw Cause.squash(result.cause);
                }
              : undefined
          }
          onStop={
            selected.ref && data.stoppable.has(selected.ref.environmentId)
              ? async (scope) => {
                  const ref = selected.ref!;
                  const result = await stop({
                    environmentId: ref.environmentId,
                    input: { commandId: CommandId.make(uuidv4()), threadId: ref.threadId, scope },
                  });
                  if (result._tag === "Failure") throw Cause.squash(result.cause);
                }
              : undefined
          }
        />
        <View className="gap-2">
          <Text className="font-t3-bold text-foreground">Communication</Text>
          {data.communications
            .filter(
              (entry) =>
                selected.ref &&
                (scopedThreadKey(entry.source) === scopedThreadKey(selected.ref) ||
                  scopedThreadKey(entry.target) === scopedThreadKey(selected.ref)),
            )
            .map((entry) => (
              <Text
                key={JSON.stringify([entry.source.environmentId, entry.id])}
                className="text-xs text-foreground-secondary"
              >
                {entry.kind} · {entry.status}: {entry.summary}
              </Text>
            ))}
        </View>
      </View>
    </ScrollView>
  );
}
