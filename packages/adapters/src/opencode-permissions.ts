import type { AgentPermissionMode } from "../../agent-protocol/src/index.ts";

/** OpenCode permissions are prompts and denials, not an operating-system sandbox. */
export function openCodeEnvironment(
  environment: Record<string, string>,
  mode: AgentPermissionMode,
): Record<string, string> {
  if (mode === "external-sandbox-auto") {
    throw new TypeError("OpenCode auto approval requires a verified external sandbox and is disabled");
  }
  const raw = environment.OPENCODE_CONFIG_CONTENT;
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    throw new TypeError("OPENCODE_CONFIG_CONTENT must be valid JSON");
  }
  if (!isRecord(parsed)) throw new TypeError("OPENCODE_CONFIG_CONTENT must be a JSON object");
  const agent = isRecord(parsed.agent) ? parsed.agent : {};
  const build = isRecord(agent.build) ? agent.build : {};
  const permission = {
    "*": "ask",
    read: { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" },
    glob: "allow",
    grep: "allow",
    lsp: "allow",
    edit: mode === "workspace-auto" ? "allow" : "ask",
    bash: "ask",
    task: "deny",
    skill: "ask",
    question: "allow",
    webfetch: "ask",
    websearch: "ask",
    doom_loop: "ask",
    external_directory: "deny",
  };
  return {
    ...environment,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...parsed,
      permission,
      agent: { ...agent, build: { ...build, permission } },
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
