import type {
  AdapterOutputEvent,
  AgentAdapter,
  AgentLaunchRequest,
  AgentLaunchSpec,
} from "../../agent-protocol/src/index.ts";
import { isRecord, numberField, parseJsonLine, requireLaunchRequest, stringField, textOutput } from "./common.ts";

export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex" as const;
  readonly displayName = "OpenAI Codex";
  readonly executable = "codex";

  buildLaunchSpec(request: AgentLaunchRequest): AgentLaunchSpec {
    requireLaunchRequest(request);
    const args = ["exec", "--json", "--cd", request.workspacePath];
    if (request.permissionMode === "workspace-auto") args.push("--approve-for-me");
    else args.push("--sandbox", "workspace-write");
    if (request.permissionMode === "external-sandbox-auto") {
      throw new TypeError("Codex external-sandbox-auto is not allowed; use its workspace sandbox");
    }
    if (request.model) args.push("--model", request.model);
    if (request.sessionId) args.push("resume", request.sessionId, "-");
    else args.push("-");
    return {
      adapterKind: this.kind,
      executable: this.executable,
      args,
      cwd: request.workspacePath,
      stdin: `${request.prompt}\n`,
      environment: { ...request.extraEnvironment },
    };
  }

  parseStdoutLine(line: string): AdapterOutputEvent[] {
    const decoded = parseJsonLine(line);
    if (!decoded) return textOutput(line);
    const body = isRecord(decoded.parsed) ? decoded.parsed : {};
    const type = decoded.eventType;
    if (type === "thread.started") {
      return [
        {
          type: "session.discovered",
          sessionId: stringField(body, "thread_id") ?? stringField(body, "threadId") ?? undefined,
          providerEventType: type,
          raw: decoded.parsed,
        },
      ];
    }
    if (type === "turn.completed") {
      const usage = isRecord(body.usage) ? body.usage : {};
      return [
        {
          type: "usage.updated",
          inputTokens: numberField(usage, "input_tokens"),
          outputTokens: numberField(usage, "output_tokens"),
          providerEventType: type,
          raw: decoded.parsed,
        },
      ];
    }
    if (type.includes("approval")) {
      return [{ type: "approval.requested", providerEventType: type, raw: decoded.parsed }];
    }
    if (type === "item.started" || type === "item.completed") {
      const item = isRecord(body.item) ? body.item : {};
      const itemType = stringField(item, "type") ?? "item";
      const text = stringField(item, "text") ?? stringField(item, "content") ?? stringField(item, "message");
      if (type === "item.completed" && text && (itemType.includes("message") || itemType.includes("text"))) {
        return [
          {
            type: "output.delta",
            message: text,
            providerEventType: type,
            raw: decoded.parsed,
          },
        ];
      }
      const isTool = itemType.includes("command") || itemType.includes("tool") || itemType.includes("mcp");
      if (isTool) {
        return [
          {
            type: type === "item.started" ? "tool.started" : "tool.finished",
            toolName: itemType,
            toolCallId: stringField(item, "id") ?? undefined,
            providerEventType: type,
            raw: decoded.parsed,
          },
        ];
      }
    }
    return [{ type: "provider.event", providerEventType: type, raw: decoded.parsed }];
  }
}
