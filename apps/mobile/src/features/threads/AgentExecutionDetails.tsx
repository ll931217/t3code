import { useState } from "react";
import { TextInput, View } from "react-native";
import type { AgentExecutionRecord, ScopedThreadRef } from "@t3tools/contracts";
import type { AgentGraphNode } from "@t3tools/client-runtime/state/agent-execution-graph";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { uuidv4 } from "../../lib/uuid";
import { agentProfileEnvironment } from "../../state/agentExecution";
import { useEnvironmentQuery } from "../../state/query";

function ProfileDetails({ threadRef }: { threadRef: ScopedThreadRef }) {
  const result = useEnvironmentQuery(
    agentProfileEnvironment.threadSnapshot({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  const profile = result.data?.root.profile;
  const writablePaths = result.data?.writablePaths ?? profile?.permissions.writablePaths ?? [];
  return profile ? (
    <View className="gap-1">
      <Text className="font-t3-bold text-foreground">Profile: {profile.name}</Text>
      <Text className="text-xs text-foreground-secondary">
        {profile.modelSelection.model} · {profile.permissions.filesystem} · {profile.isolation}
      </Text>
      {writablePaths.length > 0 ? (
        <Text selectable className="text-xs text-foreground-secondary">
          Writable paths: {writablePaths.join(", ")}
        </Text>
      ) : null}
      <Text selectable className="text-xs text-foreground-muted">
        Snapshot {result.data?.id}
      </Text>
    </View>
  ) : result.error ? (
    <Text className="text-xs text-danger-foreground">Profile unavailable: {result.error}</Text>
  ) : null;
}

export function AgentExecutionDetails(props: {
  node: AgentGraphNode;
  record: AgentExecutionRecord | undefined;
  onOpen: (ref: ScopedThreadRef) => void;
  onUpdate?: ((record: AgentExecutionRecord, confirmed: string[]) => Promise<void>) | undefined;
  onStop?: ((scope: "node" | "subtree") => Promise<void>) | undefined;
}) {
  const [draft, setDraft] = useState<AgentExecutionRecord | null>(null);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [checkTitle, setCheckTitle] = useState("");
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action failed.");
    }
    setBusy(false);
  };
  return (
    <View className="gap-3 border-t border-border pt-4">
      <Text accessibilityRole="header" className="font-t3-bold text-lg text-foreground">
        {props.node.title}
      </Text>
      <Text className="text-sm text-foreground-secondary">
        {props.node.status ?? "Unavailable"} · {props.node.model ?? "Model unavailable"}
      </Text>
      {props.node.projectName ? (
        <Text className="text-xs text-foreground-secondary">{props.node.projectName}</Text>
      ) : null}
      {props.node.missing ? (
        <Text className="text-xs text-foreground-muted">
          This agent is unavailable. Showing the last recorded delegation.
        </Text>
      ) : null}
      {props.node.ref ? <ProfileDetails threadRef={props.node.ref} /> : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      {draft ? (
        <View className="gap-3">
          <Text className="font-t3-bold text-foreground">Objective</Text>
          <TextInput
            accessibilityLabel="Objective"
            multiline
            value={draft.objective}
            onChangeText={(objective) => setDraft({ ...draft, objective })}
            className="min-h-20 rounded-lg border border-border p-3 text-foreground"
          />
          <Text className="font-t3-bold text-foreground">Tasks</Text>
          {draft.tasks.map((task) => (
            <View key={task.id} className="gap-2">
              <TextInput
                accessibilityLabel="Task title"
                value={task.title}
                onChangeText={(title) =>
                  setDraft({
                    ...draft,
                    tasks: draft.tasks.map((entry) =>
                      entry.id === task.id ? { ...entry, title } : entry,
                    ),
                  })
                }
                className="rounded-lg border border-border p-3 text-foreground"
              />
              <View className="flex-row flex-wrap gap-2">
                {(["pending", "in-progress", "blocked", "done"] as const).map((status) => (
                  <Button
                    key={status}
                    label={status}
                    size="compact"
                    tone={task.status === status ? "primary" : "secondary"}
                    onPress={() =>
                      setDraft({
                        ...draft,
                        tasks: draft.tasks.map((entry) =>
                          entry.id === task.id ? { ...entry, status } : entry,
                        ),
                      })
                    }
                  />
                ))}
                <Button
                  label="Remove task"
                  size="compact"
                  onPress={() =>
                    setDraft({
                      ...draft,
                      tasks: draft.tasks.filter((entry) => entry.id !== task.id),
                    })
                  }
                />
              </View>
            </View>
          ))}
          <Button
            label="Add task"
            size="compact"
            disabled={draft.tasks.length >= 200}
            onPress={() =>
              setDraft({
                ...draft,
                tasks: [...draft.tasks, { id: uuidv4(), title: "New task", status: "pending" }],
              })
            }
          />
          <Text className="font-t3-bold text-foreground">Record a manual verification</Text>
          <TextInput
            accessibilityLabel="Verification title"
            placeholder="Verification title"
            value={checkTitle}
            onChangeText={setCheckTitle}
            className="rounded-lg border border-border p-3 text-foreground"
          />
          <TextInput
            accessibilityLabel="Verification evidence"
            placeholder="What did you verify?"
            multiline
            value={evidence}
            onChangeText={setEvidence}
            className="rounded-lg border border-border p-3 text-foreground"
          />
          <Button
            label="Confirm passed with evidence"
            disabled={!checkTitle.trim() || !evidence.trim() || draft.verifications.length >= 200}
            onPress={() => {
              const id = uuidv4();
              setDraft({
                ...draft,
                verifications: [
                  ...draft.verifications,
                  {
                    id,
                    title: checkTitle.trim(),
                    status: "passed",
                    evidence: [{ kind: "manual", summary: evidence.trim() }],
                    provenance: "user-confirmed",
                    freshness: "unknown",
                  },
                ],
              });
              setConfirmed([...confirmed, id]);
              setCheckTitle("");
              setEvidence("");
            }}
          />
          <Text className="text-xs text-foreground-muted">
            {confirmed.length} manual verifications confirmed in this edit.
          </Text>
          <View className="flex-row gap-2">
            <Button
              label="Save and steer agent"
              loading={busy}
              onPress={() => {
                if (props.onUpdate) void run(() => props.onUpdate!(draft, confirmed));
              }}
            />
            <Button label="Cancel" disabled={busy} onPress={() => setDraft(null)} />
          </View>
        </View>
      ) : (
        <>
          <Text className="font-t3-bold text-foreground">Objective</Text>
          <Text selectable className="text-sm text-foreground-secondary">
            {props.record?.objective || props.node.objective || "No objective recorded."}
          </Text>
          {props.onUpdate && props.node.ref ? (
            <Button
              label="Edit objective and checklists"
              onPress={() => {
                setDraft(
                  props.record ?? {
                    threadId: props.node.ref!.threadId,
                    objective: props.node.objective ?? "",
                    revision: 0,
                    tasks: [],
                    verifications: [],
                    checkpoint: null,
                    updatedAt: new Date().toISOString(),
                    updatedBy: "user",
                  },
                );
                setConfirmed([]);
              }}
            />
          ) : null}
          <Text className="font-t3-bold text-foreground">Tasks</Text>
          {props.record?.tasks.length ? (
            props.record.tasks.map((task) => (
              <Text key={task.id} className="text-sm text-foreground-secondary">
                {task.status === "done" ? "☑" : "☐"} {task.title} · {task.status}
              </Text>
            ))
          ) : (
            <Text className="text-sm text-foreground-muted">No tasks recorded.</Text>
          )}
          <Text className="font-t3-bold text-foreground">Verification</Text>
          {props.record?.verifications.length ? (
            props.record.verifications.map((check) => (
              <View key={check.id} className="gap-1">
                <Text className="text-sm text-foreground">
                  {check.status === "passed" ? "☑" : "☐"} {check.title}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {check.status} · {check.provenance} · {check.freshness} evidence
                </Text>
                {check.evidence.map((item) => (
                  <Text
                    selectable
                    key={JSON.stringify(item)}
                    className="text-xs text-foreground-secondary"
                  >
                    {item.kind}: {item.summary}
                    {item.reference ? ` (${item.reference})` : ""}
                  </Text>
                ))}
              </View>
            ))
          ) : (
            <Text className="text-sm text-foreground-muted">No verification recorded.</Text>
          )}
        </>
      )}
      {props.node.progress ? (
        <Text selectable className="text-sm text-foreground-secondary">
          Activity: {props.node.progress}
        </Text>
      ) : null}
      {props.node.result ? (
        <Text selectable className="text-sm text-foreground-secondary">
          Result: {props.node.result}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {props.node.ref ? (
          <Button label="Open thread" onPress={() => props.onOpen(props.node.ref!)} />
        ) : null}
        {props.onStop ? (
          <>
            <Button
              label="Stop this agent"
              disabled={busy}
              onPress={() => void run(() => props.onStop!("node"))}
            />
            <Button
              label="Cancel subtree"
              tone="danger"
              disabled={busy}
              onPress={() => void run(() => props.onStop!("subtree"))}
            />
          </>
        ) : null}
      </View>
    </View>
  );
}
