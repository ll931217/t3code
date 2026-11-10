import { useState } from "react";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { useProjects } from "../../state/entities";
import { useSettingsScope } from "./SettingsScopeContext";
import { AgentProfilesPanel } from "./AgentProfilesPanel";

export function AgentProfilesSettings() {
  const { environment, scope } = useSettingsScope();
  const projects = useProjects().filter(
    (project) => project.environmentId === environment?.environmentId,
  );
  const [projectKey, setProjectKey] = useState("");
  const scopedProject =
    scope.kind === "project" || scope.kind === "checkout"
      ? scope.members.find((member) => member.environmentId === environment?.environmentId)
      : null;
  const selected = projects.find((project) =>
    scopedProject
      ? project.id === scopedProject.id
      : scopedProjectKey({ environmentId: project.environmentId, projectId: project.id }) ===
        projectKey,
  );
  return (
    <section id="agent-profiles" className="space-y-4 p-6">
      <h2 className="text-lg font-semibold">Agent profiles</h2>
      {!scopedProject ? (
        <label className="block space-y-1 text-sm">
          Project
          <select
            className="block w-full rounded border border-input bg-background p-2"
            value={projectKey}
            onChange={(event) => setProjectKey(event.target.value)}
          >
            <option value="">Select a project</option>
            {projects.map((project) => (
              <option
                key={project.id}
                value={scopedProjectKey({
                  environmentId: project.environmentId,
                  projectId: project.id,
                })}
              >
                {project.title}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {selected ? (
        <AgentProfilesPanel
          key={scopedProjectKey({ environmentId: selected.environmentId, projectId: selected.id })}
          environmentId={selected.environmentId}
          projectId={selected.id}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          Select a project to review repository profiles and choose where new agents work. Personal
          profiles remain available across projects on this environment.
        </p>
      )}
    </section>
  );
}
