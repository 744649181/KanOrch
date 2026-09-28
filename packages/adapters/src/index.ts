import { AgentAdapterRegistry } from "../../agent-protocol/src/index.ts";
import { ClaudeCodeAdapter } from "./claude-code-adapter.ts";
import { CodexAdapter } from "./codex-adapter.ts";
import { OpenCodeAdapter } from "./opencode-adapter.ts";

export * from "./claude-code-adapter.ts";
export * from "./cline-execution-adapter.ts";
export * from "./codex-adapter.ts";
export * from "./opencode-adapter.ts";
export * from "./opencode-permissions.ts";

export function createDefaultAdapterRegistry(): AgentAdapterRegistry {
  const registry = new AgentAdapterRegistry();
  registry.register(new CodexAdapter());
  registry.register(new ClaudeCodeAdapter());
  registry.register(new OpenCodeAdapter());
  return registry;
}
