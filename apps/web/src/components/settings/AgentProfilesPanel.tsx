import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  MessageId,
  ThreadId,
  type AgentProfile,
  type AgentProfileCatalogEntry,
  type EnvironmentId,
  type ProjectId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { createAgentProfileTemplate } from "@t3tools/client-runtime/state/agent-profiles";
import { agentProfileEnvironment } from "../../state/agentProfiles";
import { useEnvironmentProviders } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { AgentProfileEditor } from "./AgentProfileEditor";
import { AgentProfileReview } from "./AgentProfileReview";

export function AgentProfilesPanel(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadRef?: ScopedThreadRef;
}) {
  const navigate = useNavigate();
  const catalog = useEnvironmentQuery(
    agentProfileEnvironment.list({
      environmentId: props.environmentId,
      input: { projectId: props.projectId },
    }),
  );
  const providers = useEnvironmentProviders().get(props.environmentId) ?? [];
  const save = useAtomCommand(agentProfileEnvironment.save, { reportFailure: false });
  const remove = useAtomCommand(agentProfileEnvironment.remove, { reportFailure: false });
  const revoke = useAtomCommand(agentProfileEnvironment.revoke, { reportFailure: false });
  const launch = useAtomCommand(agentProfileEnvironment.launch, { reportFailure: false });
  const apply = useAtomCommand(agentProfileEnvironment.apply, { reportFailure: false });
  const canSave = useAtomValue(agentProfileEnvironment.save.permissionAtom(props.environmentId));
  const canRemove = useAtomValue(
    agentProfileEnvironment.remove.permissionAtom(props.environmentId),
  );
  const canRevoke = useAtomValue(
    agentProfileEnvironment.revoke.permissionAtom(props.environmentId),
  );
  const canLaunch = useAtomValue(
    agentProfileEnvironment.launch.permissionAtom(props.environmentId),
  );
  const canApply = useAtomValue(agentProfileEnvironment.apply.permissionAtom(props.environmentId));
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [reviewing, setReviewing] = useState<AgentProfileCatalogEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [objective, setObjective] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [role, setRole] = useState<"orchestrator" | "worker" | "reviewer" | "researcher">("worker");
  const selectedModel = providers
    .flatMap((provider) => provider.models.map((model) => ({ provider, model })))
    .find(({ provider, model }) => JSON.stringify([provider.instanceId, model.slug]) === modelKey);
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
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Profiles pin a model, instructions, permissions, and delegation limits to each agent.
        Existing threads keep their snapshot until you explicitly apply an update.
      </p>
      {error || catalog.error ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? catalog.error} Check the selected provider, model, and capability restrictions
          in the profile editor.
        </p>
      ) : null}
      {canSave ? (
        <section className="space-y-2 rounded-lg border border-border p-4">
          <h3 className="font-medium">Create from a starter</h3>
          <label className="block text-sm">
            Role
            <select
              className="ml-2 rounded border border-input bg-background p-1"
              value={role}
              onChange={(event) => setRole(event.target.value as typeof role)}
            >
              {["orchestrator", "worker", "reviewer", "researcher"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            Model
            <select
              className="ml-2 max-w-full rounded border border-input bg-background p-1"
              value={modelKey}
              onChange={(event) => setModelKey(event.target.value)}
            >
              <option value="">Select an available model</option>
              {providers
                .filter(
                  (provider) =>
                    provider.enabled &&
                    (provider.driver === "codex" || provider.driver === "claudeAgent"),
                )
                .map((provider) => (
                  <optgroup
                    key={provider.instanceId}
                    label={provider.displayName ?? provider.instanceId}
                  >
                    {provider.models.map((model) => (
                      <option
                        key={model.slug}
                        value={JSON.stringify([provider.instanceId, model.slug])}
                      >
                        {model.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
            </select>
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={!selectedModel || busy}
            onClick={() => {
              if (selectedModel)
                setEditing(
                  createAgentProfileTemplate(role, {
                    instanceId: selectedModel.provider.instanceId,
                    model: selectedModel.model.slug,
                  }),
                );
            }}
          >
            Customize starter
          </Button>
        </section>
      ) : null}
      {editing ? (
        <AgentProfileEditor
          key={editing.id}
          profile={editing}
          providers={providers}
          onCancel={() => setEditing(null)}
          onSave={async (profile) => {
            const result = await save({
              environmentId: props.environmentId,
              input: { projectId: props.projectId, profile },
            });
            if (result._tag === "Failure")
              throw new Error(formatEnvironmentQueryError(result.cause));
            setEditing(null);
          }}
        />
      ) : null}
      {reviewing ? (
        <AgentProfileReview
          key={reviewing.reviewFingerprint}
          entry={reviewing}
          environmentId={props.environmentId}
          projectId={props.projectId}
          onClose={() => setReviewing(null)}
        />
      ) : null}
      <label className="block space-y-1 text-sm">
        Objective for a new thread
        <Textarea
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          placeholder="Describe the work to delegate"
        />
      </label>
      {catalog.isPending && !catalog.data ? (
        <p className="text-sm text-muted-foreground">Loading profiles…</p>
      ) : null}
      {catalog.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No profiles yet. Start with a worker, then add an orchestrator that can delegate to it.
        </p>
      ) : null}
      {catalog.data?.map((entry) => {
        const profile = entry.version.profile;
        const provider = providers.find(
          (item) => item.instanceId === profile.modelSelection.instanceId,
        );
        const configurationReason = entry.revoked
          ? "This configuration was revoked. Review and trust it again before launching."
          : !entry.trusted
            ? "Review and trust this exact configuration before launching."
            : entry.unresolvedProfiles.length > 0
              ? `Resolve missing profiles: ${entry.unresolvedProfiles.join(", ")}.`
              : !provider
                ? `Connect the configured provider (${profile.modelSelection.instanceId}) or select another model.`
                : !provider.enabled
                  ? "Enable this profile's provider in Settings before launching."
                  : provider.driver !== "codex" && provider.driver !== "claudeAgent"
                    ? "Select a Codex or Claude Agent provider for this profile."
                    : !provider.models.some((model) => model.slug === profile.modelSelection.model)
                      ? `Select an available model; ${profile.modelSelection.model} is unavailable.`
                      : null;
        const runnable = configurationReason === null;
        const launchReason = !canLaunch
          ? "This connection cannot launch agents. Reconnect with orchestration permission."
          : (configurationReason ??
            (busy
              ? "Wait for the current profile action to finish."
              : !objective.trim()
                ? "Enter an objective for the new thread above."
                : null));
        return (
          <section key={profile.id} className="space-y-3 rounded-lg border border-border p-4">
            <div>
              <h3 className="font-semibold">{profile.name}</h3>
              <p className="text-xs text-muted-foreground">
                {profile.id} · {profile.modelSelection.model} ·{" "}
                {entry.revoked ? "Revoked" : entry.trusted ? "Trusted snapshot" : "Review required"}
              </p>
            </div>
            {profile.description ? <p className="text-sm">{profile.description}</p> : null}
            {entry.unresolvedProfiles.length ? (
              <p className="text-xs text-destructive">
                Missing profiles: {entry.unresolvedProfiles.join(", ")}
              </p>
            ) : null}
            {launchReason ? (
              <p id={`launch-reason-${profile.id}`} className="text-xs text-muted-foreground">
                {launchReason}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => setReviewing(entry)}
              >
                Review permissions
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={!canSave || busy}
                onClick={() => setEditing(profile)}
              >
                Edit
              </Button>
              <Button
                size="xs"
                disabled={launchReason !== null}
                aria-describedby={launchReason ? `launch-reason-${profile.id}` : undefined}
                onClick={() =>
                  void run(async () => {
                    const threadId = ThreadId.make(randomUUID());
                    const result = await launch({
                      environmentId: props.environmentId,
                      input: {
                        commandId: CommandId.make(randomUUID()),
                        threadId,
                        projectId: props.projectId,
                        profileId: profile.id,
                        title: objective.trim().slice(0, 120),
                        initialMessage: {
                          messageId: MessageId.make(randomUUID()),
                          text: objective,
                          attachments: [],
                        },
                      },
                    });
                    if (result._tag === "Failure")
                      throw new Error(formatEnvironmentQueryError(result.cause));
                    await navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams({
                        environmentId: props.environmentId,
                        threadId,
                      }),
                    });
                  })
                }
              >
                Launch thread
              </Button>
              {props.threadRef ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canApply || !runnable || busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await apply({
                        environmentId: props.environmentId,
                        input: {
                          projectId: props.projectId,
                          profileId: profile.id,
                          threadId: props.threadRef!.threadId,
                        },
                      });
                      if (result._tag === "Failure")
                        throw new Error(formatEnvironmentQueryError(result.cause));
                    })
                  }
                >
                  Apply to this thread
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="destructive-outline"
                disabled={!canRevoke || !entry.trusted || entry.revoked || busy}
                onClick={() =>
                  void run(async () => {
                    const result = await revoke({
                      environmentId: props.environmentId,
                      input: { snapshotId: entry.reviewFingerprint },
                    });
                    if (result._tag === "Failure")
                      throw new Error(formatEnvironmentQueryError(result.cause));
                    catalog.refresh();
                  })
                }
              >
                Revoke and stop agents
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={!canRemove || busy}
                onClick={() =>
                  void run(async () => {
                    const result = await remove({
                      environmentId: props.environmentId,
                      input: { projectId: props.projectId, profileId: profile.id },
                    });
                    if (result._tag === "Failure")
                      throw new Error(formatEnvironmentQueryError(result.cause));
                  })
                }
              >
                Delete definition
              </Button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
