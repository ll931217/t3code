import type { AgentProfileCatalogEntry, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { agentProfileEnvironment } from "../../state/agentProfiles";
import { useEnvironmentQuery, formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useState } from "react";
import { Button } from "../ui/button";

export function AgentProfileReview(props: {
  entry: AgentProfileCatalogEntry;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    agentProfileEnvironment.review({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, profileId: props.entry.version.profile.id },
    }),
  );
  const trust = useAtomCommand(agentProfileEnvironment.trust, { reportFailure: false });
  const allowed = useAtomValue(agentProfileEnvironment.trust.permissionAtom(props.environmentId));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <h3 className="font-semibold">Review {props.entry.version.profile.name}</h3>
      <p className="text-sm text-muted-foreground">
        Trust covers this exact profile and all delegated profiles below. Configuration changes
        require a fresh review.
      </p>
      {query.error || error ? (
        <p role="alert" className="text-sm text-destructive">
          {error ?? query.error}
        </p>
      ) : null}
      {query.data ? (
        [query.data.root, ...query.data.dependencies].map((version) => (
          <details
            key={version.profile.id}
            open={version.profile.id === props.entry.version.profile.id}
            className="rounded border border-border p-3"
          >
            <summary className="cursor-pointer font-medium">
              {version.profile.name} · {version.profile.id}
            </summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">
              {JSON.stringify(version.profile, null, 2)}
            </pre>
          </details>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">Loading exact configuration…</p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!allowed || !query.data || busy}
          onClick={async () => {
            if (!query.data) return;
            setBusy(true);
            setError(null);
            const result = await trust({
              environmentId: props.environmentId,
              input: {
                projectId: props.projectId,
                profileId: props.entry.version.profile.id,
                expectedFingerprint: query.data.id,
              },
            });
            setBusy(false);
            if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
            else props.onClose();
          }}
        >
          Trust this configuration
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          Close
        </Button>
      </div>
    </section>
  );
}
