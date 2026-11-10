import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AgentProfileCatalogEntry,
  type ServerProvider,
} from "@t3tools/contracts";
import { createAgentProfileTemplate } from "@t3tools/client-runtime/state/agent-profiles";
import { render } from "../../../test/render";
import { AgentProfilesPanel } from "./AgentProfilesPanel";

const mocks = vi.hoisted(() => ({
  catalog: [] as AgentProfileCatalogEntry[],
  providers: new Map<EnvironmentId, ServerProvider[]>(),
  allowed: true,
}));
vi.mock("../../state/agentProfiles", () => {
  const command = { permissionAtom: () => null };
  return {
    agentProfileEnvironment: {
      list: () => null,
      save: command,
      remove: command,
      revoke: command,
      launch: command,
      apply: command,
    },
  };
});
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => mocks.allowed,
}));
vi.mock("../../state/environments", () => ({
  useEnvironmentProviders: () => mocks.providers,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: mocks.catalog, isPending: false, error: null }),
  formatEnvironmentQueryError: () => "Failed",
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

function setup() {
  const environmentId = EnvironmentId.make("profile-launch-test");
  const instanceId = ProviderInstanceId.make("codex");
  mocks.allowed = true;
  mocks.catalog = [
    {
      version: {
        profile: createAgentProfileTemplate("worker", { instanceId, model: "luna" }),
        fingerprint: "profile-v1",
        sourceProjectId: null,
      },
      reviewFingerprint: "closure-v1",
      trusted: true,
      revoked: false,
      unresolvedProfiles: [],
    },
  ];
  mocks.providers = new Map([
    [
      environmentId,
      [
        {
          instanceId,
          driver: ProviderDriverKind.make("codex"),
          installed: true,
          enabled: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-01-01T00:00:00.000Z",
          skills: [],
          slashCommands: [],
          models: [{ slug: "luna", name: "Luna", isCustom: false, capabilities: null }],
        },
      ],
    ],
  ]);
  return { environmentId, projectId: ProjectId.make("project") };
}

it("explains launch gates and enables a trusted Settings profile once its objective is entered", async () => {
  const props = setup();
  await using screen = await render(<AgentProfilesPanel {...props} />);
  const launch = screen.getByRole("button", { name: "Launch thread" });
  await expect.element(launch).toBeDisabled();
  await expect
    .element(screen.getByText("Enter an objective for the new thread above."))
    .toBeVisible();
  await userEvent.type(
    screen.getByRole("textbox", { name: "Objective for a new thread" }),
    "Verify the parser",
  );
  await expect.element(launch).toBeEnabled();
  mocks.allowed = false;
  await screen.rerender(<AgentProfilesPanel {...props} />);
  await expect.element(launch).toBeDisabled();
  await expect
    .element(
      screen.getByText(
        "This connection cannot launch agents. Reconnect with orchestration permission.",
      ),
    )
    .toBeVisible();
  mocks.allowed = true;
  mocks.providers = new Map();
  await screen.rerender(<AgentProfilesPanel {...props} />);
  await expect.element(launch).toBeDisabled();
  await expect
    .element(screen.getByText("Connect the configured provider (codex) or select another model."))
    .toBeVisible();
  setup();
  await screen.rerender(<AgentProfilesPanel {...props} />);
  await expect.element(launch).toBeEnabled();
});
