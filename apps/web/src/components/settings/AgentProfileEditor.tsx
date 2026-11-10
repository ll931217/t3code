import { useState } from "react";
import { AgentProfile, ProviderOptionSelections, type ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const isAgentProfile = Schema.is(AgentProfile);
const decodeOptions = Schema.decodeUnknownSync(ProviderOptionSelections);

const lines = (value: string) =>
  value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

export function AgentProfileEditor(props: {
  profile: AgentProfile;
  providers: ReadonlyArray<ServerProvider>;
  onSave: (profile: AgentProfile) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.profile);
  const [optionsText, setOptionsText] = useState(
    JSON.stringify(props.profile.modelSelection.options ?? [], null, 2),
  );
  const [optionsError, setOptionsError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supportedProviders = props.providers.filter(
    (entry) => entry.enabled && (entry.driver === "codex" || entry.driver === "claudeAgent"),
  );
  const provider = props.providers.find(
    (entry) => entry.instanceId === draft.modelSelection.instanceId,
  );
  const issues = [
    ...(!provider?.enabled ||
    !provider.models.some((model) => model.slug === draft.modelSelection.model)
      ? ["Choose an enabled provider and an available model."]
      : []),
    ...(provider && provider.driver !== "codex" && provider.driver !== "claudeAgent"
      ? ["This provider cannot enforce agent profiles yet. Choose Codex or Claude Agent."]
      : []),
    ...(provider?.driver === "codex" &&
    (draft.permissions.approvalPolicy !== "never" ||
      draft.permissions.nativeTools !== "capability-defaults")
      ? [
          "Codex profiles require capability-default tools and the never approval policy. Permissions remain enforced by the sandbox.",
        ]
      : []),
    ...(draft.permissions.writablePaths.length &&
    (provider?.driver !== "claudeAgent" || draft.permissions.commands)
      ? ["Scoped writable paths require Claude Agent with commands disabled."]
      : []),
    ...(draft.permissions.commands &&
    draft.permissions.network &&
    !draft.permissions.integrations.publish
      ? [
          "Commands with network access can publish changes. Enable publish permission, or disable commands or network.",
        ]
      : []),
  ];
  const valid = isAgentProfile(draft);
  const permission = <K extends keyof AgentProfile["permissions"]>(
    key: K,
    value: AgentProfile["permissions"][K],
  ) => setDraft({ ...draft, permissions: { ...draft.permissions, [key]: value } });
  return (
    <form
      className="space-y-4 rounded-lg border border-border p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (optionsError) return;
        setBusy(true);
        setError(null);
        try {
          await props.onSave(draft);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Unable to save profile.");
        }
        setBusy(false);
      }}
    >
      <h3 className="font-semibold">Edit agent profile</h3>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <label className="block space-y-1 text-sm">
        Identity
        <Input
          value={draft.id}
          onChange={(event) => setDraft({ ...draft, id: event.target.value })}
          required
          pattern="(personal|project)/[a-z0-9][a-z0-9_-]{0,63}"
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Use personal/name for this environment or project/name for the repository. Changing the
        identity saves a separate profile.
      </p>
      <label className="block space-y-1 text-sm">
        Name
        <Input
          value={draft.name}
          required
          maxLength={128}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </label>
      <label className="block space-y-1 text-sm">
        Description
        <Input
          value={draft.description}
          maxLength={2000}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </label>
      <label className="block space-y-1 text-sm">
        Provider and model
        <select
          className="block w-full rounded border border-input bg-background p-2"
          value={JSON.stringify([draft.modelSelection.instanceId, draft.modelSelection.model])}
          onChange={(event) => {
            for (const entry of supportedProviders)
              for (const model of entry.models)
                if (JSON.stringify([entry.instanceId, model.slug]) === event.target.value) {
                  setDraft({
                    ...draft,
                    modelSelection: { instanceId: entry.instanceId, model: model.slug },
                  });
                  setOptionsText("[]");
                  setOptionsError(false);
                }
          }}
        >
          {!supportedProviders.some(
            (entry) =>
              entry.instanceId === draft.modelSelection.instanceId &&
              entry.models.some((model) => model.slug === draft.modelSelection.model),
          ) ? (
            <option
              disabled
              value={JSON.stringify([draft.modelSelection.instanceId, draft.modelSelection.model])}
            >
              Unavailable or unsupported: {draft.modelSelection.model}
            </option>
          ) : null}
          {supportedProviders.map((entry) => (
            <optgroup key={entry.instanceId} label={entry.displayName ?? entry.instanceId}>
              {entry.models.map((model) => (
                <option
                  key={model.slug}
                  disabled={!entry.enabled}
                  value={JSON.stringify([entry.instanceId, model.slug])}
                >
                  {model.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label className="block space-y-1 text-sm">
        Model options (JSON)
        <Textarea
          value={optionsText}
          aria-invalid={optionsError}
          onChange={(event) => {
            setOptionsText(event.target.value);
            try {
              const options = decodeOptions(JSON.parse(event.target.value));
              setDraft({ ...draft, modelSelection: { ...draft.modelSelection, options } });
              setOptionsError(false);
            } catch {
              setOptionsError(true);
            }
          }}
        />
      </label>
      {optionsError ? (
        <p role="alert" className="text-xs text-destructive">
          Enter valid model options JSON, such as [{`{"id":"reasoningEffort","value":"high"}`}].
        </p>
      ) : null}
      <label className="block space-y-1 text-sm">
        Instructions
        <Textarea
          value={draft.prompt}
          maxLength={100000}
          onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
        />
      </label>
      <fieldset className="space-y-2">
        <legend className="font-medium">Permissions</legend>
        <label className="block text-sm">
          Filesystem
          <select
            className="ml-2 rounded border border-input bg-background p-1"
            value={draft.permissions.filesystem}
            onChange={(event) =>
              permission(
                "filesystem",
                event.target.value as AgentProfile["permissions"]["filesystem"],
              )
            }
          >
            <option value="read-only">Read only</option>
            <option value="workspace-write">Workspace write</option>
          </select>
        </label>
        {(["commands", "network"] as const).map((key) => (
          <label key={key} className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.permissions[key]}
              onChange={(event) => permission(key, event.target.checked)}
            />
            Allow {key}
          </label>
        ))}
        <label className="block space-y-1 text-sm">
          Writable paths
          <Textarea
            defaultValue={draft.permissions.writablePaths.join("\n")}
            onBlur={(event) => permission("writablePaths", lines(event.target.value))}
          />
        </label>
        <label className="block text-sm">
          Approval policy
          <select
            className="ml-2 rounded border border-input bg-background p-1"
            value={draft.permissions.approvalPolicy}
            onChange={(event) =>
              permission(
                "approvalPolicy",
                event.target.value as AgentProfile["permissions"]["approvalPolicy"],
              )
            }
          >
            {["untrusted", "on-failure", "on-request", "never"].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.permissions.nativeTools === "capability-defaults"}
            onChange={(event) =>
              permission("nativeTools", event.target.checked ? "capability-defaults" : [])
            }
          />
          Use provider capability defaults
        </label>
        {draft.permissions.nativeTools !== "capability-defaults" ? (
          <label className="block space-y-1 text-sm">
            Allowed native tools
            <Textarea
              defaultValue={draft.permissions.nativeTools.join("\n")}
              onBlur={(event) => permission("nativeTools", lines(event.target.value))}
            />
          </label>
        ) : null}
        <label className="block space-y-1 text-sm">
          Allowed MCP tools
          <Textarea
            defaultValue={draft.permissions.mcpTools.join("\n")}
            onBlur={(event) => permission("mcpTools", lines(event.target.value))}
          />
        </label>
        {(["commit", "merge", "publish"] as const).map((key) => (
          <label key={key} className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.permissions.integrations[key]}
              onChange={(event) =>
                permission("integrations", {
                  ...draft.permissions.integrations,
                  [key]: event.target.checked,
                })
              }
            />
            Allow {key}
          </label>
        ))}
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="font-medium">Delegation</legend>
        <label className="block space-y-1 text-sm">
          Allowed child profile identities
          <Textarea
            defaultValue={draft.delegation.profiles.join("\n")}
            onBlur={(event) =>
              setDraft({
                ...draft,
                delegation: { ...draft.delegation, profiles: lines(event.target.value) },
              })
            }
          />
        </label>
        {(["maxConcurrent", "maxAgents", "maxDepth"] as const).map((key) => (
          <label key={key} className="block space-y-1 text-sm">
            {
              {
                maxConcurrent: "Maximum concurrent agents",
                maxAgents: "Maximum total agents",
                maxDepth: "Maximum depth",
              }[key]
            }
            <Input
              type="number"
              min={1}
              max={key === "maxConcurrent" ? 64 : key === "maxAgents" ? 1024 : 16}
              value={draft.delegation[key]}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  delegation: { ...draft.delegation, [key]: Number(event.target.value) },
                })
              }
            />
          </label>
        ))}
      </fieldset>
      <label className="block text-sm">
        Isolation
        <select
          className="ml-2 rounded border border-input bg-background p-1"
          value={draft.isolation}
          onChange={(event) =>
            setDraft({ ...draft, isolation: event.target.value as AgentProfile["isolation"] })
          }
        >
          <option value="worktree">Separate worktree</option>
          <option value="shared">Shared workspace</option>
        </select>
      </label>
      {issues.length ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
      {!valid ? (
        <p className="text-xs text-destructive">
          Check profile identity, delegation identities, relative paths, and numeric limits.
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !valid || optionsError}>
          Save configuration
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
