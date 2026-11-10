import type { AgentProfile } from "@t3tools/contracts";
import type * as Schema from "effect/Schema";

export function codexAgentProfileConfig(
  profile: AgentProfile,
  inheritedServers: Readonly<Record<string, Schema.Json>>,
  t3Server: Record<string, Schema.Json> | undefined,
): Record<string, Schema.Json> {
  return {
    "agents.enabled": false,
    "features.multi_agent": false,
    "features.multi_agent_v2": false,
    "features.shell_tool": profile.permissions.commands,
    "features.js_repl": false,
    "features.computer_use": false,
    "features.browser_use": false,
    "features.browser_use_external": false,
    "features.code_mode": false,
    "features.apps": false,
    "features.plugins": false,
    "features.recommended_plugins": false,
    "features.hooks": false,
    "features.codex_hooks": false,
    "features.plugin_hooks": false,
    allow_login_shell: false,
    notify: [],
    web_search: profile.permissions.network ? "live" : "disabled",
    mcp_servers: {
      // Disabled servers still need transports; config/read nulls are not valid TOML overrides.
      ...Object.fromEntries(
        Object.entries(inheritedServers).map(([name, config]) => [
          name,
          {
            ...(config !== null && typeof config === "object" && !Array.isArray(config)
              ? Object.fromEntries(Object.entries(config).filter(([, value]) => value !== null))
              : {}),
            enabled: false,
          },
        ]),
      ),
      ...(t3Server === undefined
        ? {}
        : {
            "t3-code": {
              ...t3Server,
              enabled: profile.permissions.mcpTools.length > 0,
              enabled_tools: [...profile.permissions.mcpTools],
              default_tools_approval_mode: "prompt",
              tools: Object.fromEntries(
                profile.permissions.mcpTools.map((name) => [name, { approval_mode: "approve" }]),
              ),
            },
          }),
    },
  };
}

export function codexAgentProfileContext(profile: AgentProfile | undefined) {
  if (profile === undefined) return {};
  // Codex truncates individual context entries at 4,000 UTF-8 bytes.
  const characters = Array.from(profile.prompt);
  const context: Record<string, { kind: "application"; value: string }> = {};
  for (let offset = 0; offset < characters.length; offset += 1000) {
    context[`t3_agent_role_${String(offset / 1000).padStart(3, "0")}`] = {
      kind: "application",
      value: characters.slice(offset, offset + 1000).join(""),
    };
  }
  return context;
}
