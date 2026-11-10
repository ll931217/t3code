import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  MessageId,
  ThreadId,
  type AgentProfile,
  type AgentProfileCatalogEntry,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { createAgentProfileTemplate } from "@t3tools/client-runtime/state/agent-profiles";
import * as Cause from "effect/Cause";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { agentProfileEnvironment } from "../../state/agentExecution";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { uuidv4 } from "../../lib/uuid";
import { AgentProfileEditor } from "./AgentProfileEditor";

export function AgentProfilesPanel(props: {
  threadRef: ScopedThreadRef;
  projectId: ProjectId;
  onOpen: (ref: ScopedThreadRef) => void;
}) {
  const environmentId = props.threadRef.environmentId;
  const catalog = useEnvironmentQuery(
    agentProfileEnvironment.list({ environmentId, input: { projectId: props.projectId } }),
  );
  const providers =
    useAtomValue(environmentPresentations.providersByEnvironmentAtom).get(environmentId) ?? [];
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [reviewing, setReviewing] = useState<AgentProfileCatalogEntry | null>(null);
  const [role, setRole] = useState<"orchestrator" | "worker" | "reviewer" | "researcher" | null>(
    null,
  );
  const [objective, setObjective] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const review = useEnvironmentQuery(
    reviewing
      ? agentProfileEnvironment.review({
          environmentId,
          input: { projectId: props.projectId, profileId: reviewing.version.profile.id },
        })
      : null,
  );
  const save = useAtomCommand(agentProfileEnvironment.save, { reportFailure: false });
  const trust = useAtomCommand(agentProfileEnvironment.trust, { reportFailure: false });
  const launch = useAtomCommand(agentProfileEnvironment.launch, { reportFailure: false });
  const apply = useAtomCommand(agentProfileEnvironment.apply, { reportFailure: false });
  const revoke = useAtomCommand(agentProfileEnvironment.revoke, { reportFailure: false });
  const remove = useAtomCommand(agentProfileEnvironment.remove, { reportFailure: false });
  const canSave = useAtomValue(agentProfileEnvironment.save.permissionAtom(environmentId));
  const canTrust = useAtomValue(agentProfileEnvironment.trust.permissionAtom(environmentId));
  const canLaunch = useAtomValue(agentProfileEnvironment.launch.permissionAtom(environmentId));
  const canApply = useAtomValue(agentProfileEnvironment.apply.permissionAtom(environmentId));
  const canRevoke = useAtomValue(agentProfileEnvironment.revoke.permissionAtom(environmentId));
  const canRemove = useAtomValue(agentProfileEnvironment.remove.permissionAtom(environmentId));
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The profile action failed.");
    }
    setBusy(false);
  };
  return (
    <View className="gap-4">
      <Text className="font-t3-bold text-lg text-foreground">Agent profiles</Text>
      <Text className="text-sm text-foreground-secondary">
        Review permissions before trusting a configuration. Existing agents keep their snapshot
        until you apply a new one.
      </Text>
      {error || catalog.error || review.error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error ?? catalog.error ?? review.error} Check the selected model and provider capability
          restrictions.
        </Text>
      ) : null}
      {canSave ? (
        <View className="gap-2">
          <Text className="font-t3-bold text-foreground">Create from a starter</Text>
          <View className="flex-row flex-wrap gap-2">
            {(["orchestrator", "worker", "reviewer", "researcher"] as const).map((entry) => (
              <Button
                key={entry}
                label={entry}
                size="compact"
                disabled={busy}
                onPress={() => setRole(entry)}
              />
            ))}
          </View>
        </View>
      ) : null}
      {role ? (
        <View className="gap-2">
          <Text className="text-sm text-foreground">Choose the model for {role}</Text>
          <ScrollView style={{ maxHeight: 240 }} nestedScrollEnabled>
            {providers
              .filter(
                (provider) =>
                  provider.enabled &&
                  (provider.driver === "codex" || provider.driver === "claudeAgent"),
              )
              .flatMap((provider) =>
                provider.models.map((model) => (
                  <Button
                    key={JSON.stringify([provider.instanceId, model.slug])}
                    label={`${provider.displayName ?? provider.instanceId} · ${model.name}`}
                    onPress={() => {
                      setEditing(
                        createAgentProfileTemplate(role, {
                          instanceId: provider.instanceId,
                          model: model.slug,
                        }),
                      );
                      setRole(null);
                    }}
                  />
                )),
              )}
          </ScrollView>
          <Button label="Cancel" onPress={() => setRole(null)} />
        </View>
      ) : null}
      {editing ? (
        <AgentProfileEditor
          key={editing.id}
          profile={editing}
          providers={providers}
          onCancel={() => setEditing(null)}
          onSave={async (profile) => {
            const result = await save({
              environmentId,
              input: { projectId: props.projectId, profile },
            });
            if (result._tag === "Failure") throw Cause.squash(result.cause);
            setEditing(null);
          }}
        />
      ) : null}
      {reviewing ? (
        <View className="gap-3 rounded-lg border border-border p-3">
          <Text className="font-t3-bold text-foreground">
            Review {reviewing.version.profile.name} and its delegated profiles
          </Text>
          {review.data ? (
            [review.data.root, ...review.data.dependencies].map((version) => (
              <View key={version.profile.id}>
                <Text className="font-t3-bold text-foreground">{version.profile.id}</Text>
                <Text selectable className="font-mono text-xs text-foreground-secondary">
                  {JSON.stringify(version.profile, null, 2)}
                </Text>
              </View>
            ))
          ) : (
            <Text className="text-sm text-foreground-muted">Loading exact configuration…</Text>
          )}
          <Button
            label="Trust this exact configuration"
            disabled={!canTrust || !review.data || busy}
            onPress={() =>
              void run(async () => {
                if (!review.data) return;
                const result = await trust({
                  environmentId,
                  input: {
                    projectId: props.projectId,
                    profileId: reviewing.version.profile.id,
                    expectedFingerprint: review.data.id,
                  },
                });
                if (result._tag === "Failure") throw Cause.squash(result.cause);
                setReviewing(null);
              })
            }
          />
          <Button label="Close review" onPress={() => setReviewing(null)} />
        </View>
      ) : null}
      <Text className="font-t3-bold text-foreground">Objective for a new thread</Text>
      <TextInput
        accessibilityLabel="New agent objective"
        multiline
        value={objective}
        onChangeText={setObjective}
        className="min-h-20 rounded-lg border border-border p-3 text-foreground"
      />
      {catalog.data?.length === 0 ? (
        <Text className="text-sm text-foreground-muted">
          Create a worker first, then an orchestrator that delegates to it.
        </Text>
      ) : null}
      {catalog.data?.map((entry) => {
        const profile = entry.version.profile;
        const provider = providers.find(
          (candidate) => candidate.instanceId === profile.modelSelection.instanceId,
        );
        const available =
          provider?.enabled &&
          (provider.driver === "codex" || provider.driver === "claudeAgent") &&
          provider.models.some((model) => model.slug === profile.modelSelection.model);
        const runnable =
          available && entry.trusted && !entry.revoked && entry.unresolvedProfiles.length === 0;
        return (
          <View key={profile.id} className="gap-2 rounded-lg border border-border p-3">
            <Text className="font-t3-bold text-foreground">{profile.name}</Text>
            <Text className="text-xs text-foreground-secondary">
              {profile.id} · {profile.modelSelection.model} ·{" "}
              {entry.revoked ? "Revoked" : entry.trusted ? "Trusted snapshot" : "Review required"}
            </Text>
            {entry.unresolvedProfiles.length ? (
              <Text className="text-xs text-danger-foreground">
                Missing profiles: {entry.unresolvedProfiles.join(", ")}
              </Text>
            ) : null}
            {!available ? (
              <Text className="text-xs text-danger-foreground">
                Edit this profile to select an available Codex or Claude model, or enable its
                provider in Settings.
              </Text>
            ) : null}
            <View className="flex-row flex-wrap gap-2">
              <Button
                label="Review permissions"
                size="compact"
                disabled={busy}
                onPress={() => setReviewing(entry)}
              />
              <Button
                label="Edit"
                size="compact"
                disabled={!canSave || busy}
                onPress={() => setEditing(profile)}
              />
              <Button
                label="Launch thread"
                size="compact"
                disabled={!canLaunch || !runnable || busy || !objective.trim()}
                onPress={() =>
                  void run(async () => {
                    const threadId = ThreadId.make(uuidv4());
                    const result = await launch({
                      environmentId,
                      input: {
                        commandId: CommandId.make(uuidv4()),
                        threadId,
                        projectId: props.projectId,
                        profileId: profile.id,
                        title: objective.trim().slice(0, 120),
                        initialMessage: {
                          messageId: MessageId.make(uuidv4()),
                          text: objective,
                          attachments: [],
                        },
                      },
                    });
                    if (result._tag === "Failure") throw Cause.squash(result.cause);
                    props.onOpen({ environmentId, threadId });
                  })
                }
              />
              <Button
                label="Apply to this thread"
                size="compact"
                disabled={!canApply || !runnable || busy}
                onPress={() =>
                  void run(async () => {
                    const result = await apply({
                      environmentId,
                      input: {
                        projectId: props.projectId,
                        profileId: profile.id,
                        threadId: props.threadRef.threadId,
                      },
                    });
                    if (result._tag === "Failure") throw Cause.squash(result.cause);
                  })
                }
              />
              <Button
                label="Revoke and stop"
                size="compact"
                tone="danger"
                disabled={!canRevoke || !entry.trusted || entry.revoked || busy}
                onPress={() =>
                  void run(async () => {
                    const result = await revoke({
                      environmentId,
                      input: { snapshotId: entry.reviewFingerprint },
                    });
                    if (result._tag === "Failure") throw Cause.squash(result.cause);
                    catalog.refresh();
                  })
                }
              />
              <Button
                label="Delete definition"
                size="compact"
                disabled={!canRemove || busy}
                onPress={() =>
                  void run(async () => {
                    const result = await remove({
                      environmentId,
                      input: { projectId: props.projectId, profileId: profile.id },
                    });
                    if (result._tag === "Failure") throw Cause.squash(result.cause);
                  })
                }
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}
