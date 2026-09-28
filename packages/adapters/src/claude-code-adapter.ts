import type {
  AdapterOutputEvent,
  AgentAdapter,
  AgentLaunchRequest,
  AgentLaunchSpec,
} from "../../agent-protocol/src/index.ts";
import { isRecord, numberField, parseJsonLine, requireLaunchRequest, stringField, textOutput } from "./common.ts";

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly kind = "claude-code" as const;
  readonly displayName = "Claude Code";
  readonly executable = "claude";

  buildLaunchSpec(request: AgentLaunchRequest): AgentLaunchSpec {
    requireLaunchRequest(request);
    if (request.permissionMode === "external-sandbox-auto") {
      throw new TypeError("Claude Code bypass permissions are not allowed by the default adapter");
    }
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      request.permissionMode === "workspace-auto" ? "auto" : "manual",
    ];
    if (request.model) args.push("--model", request.model);
    if (request.sessionId) args.push("--resume", request.sessionId);
    if (request.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(request.maxBudgetUsd));
    args.push(request.prompt);
    return {
      adapterKind: this.kind,
      executable: this.executable,
      args,
      cwd: request.workspacePath,
      stdin: null,
      environment: { ...request.extraEnvironment },
    };
  }

  parseStdoutLine(line: string): AdapterOutputEvent[] {
    const decoded = parseJsonLine(line);
    if (!decoded) return textOutput(line);
    const body = isRecord(decoded.parsed) ? decoded.parsed : {};
    const type = decoded.eventType;
    if (type === "system" && stringField(body, "subtype") === "init") {
      return [
        {
          type: "session.discovered",
          sessionId: stringField(body, "session_id") ?? undefined,
          providerEventType: "system.init",
          raw: decoded.parsed,
        },
      ];
    }
    if (type === "result") {
      const usage = isRecord(body.usage) ? body.usage : {};
      const subtype = stringField(body, "subtype") ?? "";
      return [
        {
          type: subtype.includes("error") ? "run.failed" : "run.succeeded",
          message: stringField(body, "result") ?? undefined,
          inputTokens: numberField(usage, "input_tokens"),
          outputTokens: numberField(usage, "output_tokens"),
          costUsd: numberField(body, "total_cost_usd"),
          providerEventType: type,
          raw: decoded.parsed,
        },
      ];
    }
    if (type.includes("permission") || type.includes("approval")) {
      return [{ type: "approval.requested", providerEventType: type, raw: decoded.parsed }];
    }
    return [{ type: "provider.event", providerEventType: type, raw: decoded.parsed }];
  }
}
