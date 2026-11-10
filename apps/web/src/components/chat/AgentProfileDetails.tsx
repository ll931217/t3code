import type { ScopedThreadRef } from "@t3tools/contracts";
import { agentProfileEnvironment } from "../../state/agentProfiles";
import { useEnvironmentQuery } from "../../state/query";

export function AgentProfileDetails({ threadRef }: { threadRef: ScopedThreadRef }) {
  const result = useEnvironmentQuery(
    agentProfileEnvironment.threadSnapshot({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  if (result.error)
    return <p className="p-4 text-xs text-muted-foreground">Profile unavailable: {result.error}</p>;
  if (!result.data) return null;
  const { root, id } = result.data;
  const { profile } = root;
  const writablePaths = result.data.writablePaths ?? profile.permissions.writablePaths;
  return (
    <details className="border-b border-border p-4 text-xs">
      <summary className="cursor-pointer font-medium">Profile: {profile.name}</summary>
      <dl className="mt-2 space-y-1 text-muted-foreground">
        <div>
          <dt className="inline font-medium">Model: </dt>
          <dd className="inline">
            {profile.modelSelection.instanceId} / {profile.modelSelection.model}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">Files: </dt>
          <dd className="inline">
            {profile.permissions.filesystem}
            {writablePaths.length ? ` (${writablePaths.join(", ")})` : ""}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">Commands: </dt>
          <dd className="inline">{profile.permissions.commands ? "Allowed" : "Denied"}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Network: </dt>
          <dd className="inline">{profile.permissions.network ? "Allowed" : "Denied"}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Isolation: </dt>
          <dd className="inline">{profile.isolation}</dd>
        </div>
        <div>
          <dt className="inline font-medium">Tools: </dt>
          <dd className="inline">
            {typeof profile.permissions.nativeTools === "string"
              ? "Provider capability defaults"
              : profile.permissions.nativeTools.join(", ") || "None"}
          </dd>
        </div>
        <div>
          <dt className="inline font-medium">Snapshot: </dt>
          <dd className="inline break-all">{id}</dd>
        </div>
      </dl>
    </details>
  );
}
