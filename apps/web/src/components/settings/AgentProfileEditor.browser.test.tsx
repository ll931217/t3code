import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { createAgentProfileTemplate } from "@t3tools/client-runtime/state/agent-profiles";
import { render } from "../../../test/render";
import { AgentProfileEditor } from "./AgentProfileEditor";

it("preserves multiline delegation and tools while editing a stored profile", async () => {
  const profile = createAgentProfileTemplate("orchestrator", {
    instanceId: ProviderInstanceId.make("codex"),
    model: "test-model",
    options: [{ id: "custom-option", value: "custom-value" }],
  });
  const save = vi.fn().mockResolvedValue(undefined);
  await using screen = await render(
    <AgentProfileEditor profile={profile} providers={[]} onSave={save} onCancel={() => {}} />,
  );
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Allowed child profile identities" }),
    "personal/worker\nproject/reviewer",
  );
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Allowed MCP tools" }),
    "delegate_task\ntask_status",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  await vi.waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        modelSelection: expect.objectContaining({
          options: [{ id: "custom-option", value: "custom-value" }],
        }),
        permissions: expect.objectContaining({
          filesystem: "read-only",
          commands: false,
          mcpTools: ["delegate_task", "task_status"],
        }),
        delegation: expect.objectContaining({
          profiles: ["personal/worker", "project/reviewer"],
          maxDepth: 3,
        }),
      }),
    ),
  );
  await userEvent.fill(screen.getByRole("textbox", { name: "Model options (JSON)" }), "[");
  await expect.element(screen.getByRole("button", { name: "Save configuration" })).toBeDisabled();
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Model options (JSON)" }),
    '[{"id":"reasoningEffort","value":"high"}]',
  );
  await userEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  await vi.waitFor(() =>
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        modelSelection: expect.objectContaining({
          options: [{ id: "reasoningEffort", value: "high" }],
        }),
      }),
    ),
  );
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Identity", exact: true }),
    "project/../unsafe",
  );
  await expect.element(screen.getByRole("button", { name: "Save configuration" })).toBeDisabled();
});

it("retains an unsupported stored model without offering unsupported providers for selection", async () => {
  const providers: ServerProvider[] = ["codex", "replay"].map((driver) => ({
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    installed: true,
    enabled: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    skills: [],
    slashCommands: [],
    models: [
      { slug: `${driver}-model`, name: `${driver} model`, isCustom: false, capabilities: null },
    ],
  }));
  const profile = createAgentProfileTemplate("worker", {
    instanceId: ProviderInstanceId.make("replay"),
    model: "replay-model",
  });
  await using screen = await render(
    <AgentProfileEditor
      profile={profile}
      providers={providers}
      onSave={async () => {}}
      onCancel={() => {}}
    />,
  );
  await expect
    .element(screen.getByRole("option", { name: "codex model", exact: true }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole("option", { name: "replay model", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("option", { name: "Unavailable or unsupported: replay-model" }))
    .toBeDisabled();
});
