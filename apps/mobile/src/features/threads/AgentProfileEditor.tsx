import { useState } from "react";
import { ScrollView, Switch, TextInput, View } from "react-native";
import { AgentProfile, type ServerProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

const decodeProfile = Schema.decodeUnknownSync(AgentProfile);

function parseProfile(draft: AgentProfile, advanced: string) {
  const config: unknown = JSON.parse(advanced);
  return decodeProfile({
    ...draft,
    ...(typeof config === "object" && config !== null ? config : {}),
  });
}

export function AgentProfileEditor(props: {
  profile: AgentProfile;
  providers: ReadonlyArray<ServerProvider>;
  onSave: (profile: AgentProfile) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(props.profile);
  const [advanced, setAdvanced] = useState(
    JSON.stringify(
      {
        permissions: props.profile.permissions,
        delegation: props.profile.delegation,
        isolation: props.profile.isolation,
      },
      null,
      2,
    ),
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [models, setModels] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <View className="gap-3 rounded-lg border border-border p-3">
      <Text className="font-t3-bold text-lg text-foreground">Edit agent profile</Text>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <Text className="text-sm text-foreground">Identity (personal/name or project/name)</Text>
      <TextInput
        accessibilityLabel="Profile identity"
        value={draft.id}
        onChangeText={(id) => setDraft({ ...draft, id })}
        className="rounded-lg border border-border p-3 text-foreground"
        autoCapitalize="none"
      />
      <Text className="text-sm text-foreground">Name</Text>
      <TextInput
        accessibilityLabel="Profile name"
        value={draft.name}
        onChangeText={(name) => setDraft({ ...draft, name })}
        className="rounded-lg border border-border p-3 text-foreground"
      />
      <Text className="text-sm text-foreground">Description</Text>
      <TextInput
        accessibilityLabel="Profile description"
        value={draft.description}
        onChangeText={(description) => setDraft({ ...draft, description })}
        className="rounded-lg border border-border p-3 text-foreground"
      />
      <Button label={`Model: ${draft.modelSelection.model}`} onPress={() => setModels(!models)} />
      {models ? (
        <ScrollView style={{ maxHeight: 220 }} nestedScrollEnabled>
          {props.providers
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
                    setDraft({
                      ...draft,
                      modelSelection: { instanceId: provider.instanceId, model: model.slug },
                    });
                    setModels(false);
                  }}
                />
              )),
            )}
        </ScrollView>
      ) : null}
      <Text className="text-sm text-foreground">Instructions</Text>
      <TextInput
        accessibilityLabel="Profile instructions"
        multiline
        value={draft.prompt}
        onChangeText={(prompt) => setDraft({ ...draft, prompt })}
        className="min-h-28 rounded-lg border border-border p-3 text-foreground"
      />
      <View className="flex-row items-center justify-between">
        <Text className="text-sm text-foreground">Advanced permissions and delegation</Text>
        <Switch
          accessibilityLabel="Advanced permissions and delegation"
          value={showAdvanced}
          onValueChange={setShowAdvanced}
        />
      </View>
      {showAdvanced ? (
        <>
          <Text className="text-xs text-foreground-secondary">
            Edit the profile configuration for paths, tools, approval policy, allowed child
            profiles, limits, and worktree isolation. Unsupported provider combinations are rejected
            at launch.
          </Text>
          <TextInput
            accessibilityLabel="Permissions and delegation JSON"
            multiline
            value={advanced}
            onChangeText={setAdvanced}
            className="min-h-64 rounded-lg border border-border p-3 font-mono text-xs text-foreground"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </>
      ) : (
        <Text className="text-xs text-foreground-secondary">
          {draft.permissions.filesystem} · commands{" "}
          {draft.permissions.commands ? "allowed" : "denied"} · network{" "}
          {draft.permissions.network ? "allowed" : "denied"}
        </Text>
      )}
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Save configuration"
          loading={busy}
          onPress={() => {
            setBusy(true);
            setError(null);
            void (async () => {
              try {
                const parsed = parseProfile(draft, advanced);
                await props.onSave(parsed);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Invalid profile configuration.");
              }
              setBusy(false);
            })();
          }}
        />
        <Button label="Cancel" disabled={busy} onPress={props.onCancel} />
      </View>
    </View>
  );
}
