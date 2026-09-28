import type {
  AdapterOutputEvent,
  AgentAdapter,
  AgentLaunchRequest,
  AgentLaunchSpec,
} from "../../agent-protocol/src/index.ts";
import { isRecord, numberField, parseJsonLine, requireLaunchRequest, stringField, textOutput } from "./common.ts";
import { openCodeEnvironment } from "./opencode-permissions.ts";

export class OpenCodeAdapter implements AgentAdapter {
  readonly kind = "opencode" as const;
  readonly displayName = "OpenCode";
  readonly executable = "opencode";

  buildLaunchSpec(request: AgentLaunchRequest): AgentLaunchSpec {
    requireLaunchRequest(request);
    const environment = openCodeEnvironment({
      ...request.extraEnvironment,
      OPENCODE_CONFIG_CONTENT: request.extraEnvironment?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT ?? "",
    }, request.permissionMode);
    const args = ["run", "--format", "json", "--dir", request.workspacePath, "--agent", "build"];
    if (request.model) args.push("--model", request.model);
    if (request.sessionId) args.push("--session", request.sessionId);
    args.push(request.prompt);
    return {
      adapterKind: this.kind,
      executable: this.executable,
      args,
      cwd: request.workspacePath,
      stdin: null,
      environment,
    };
  }

  parseStdoutLine(line: string): AdapterOutputEvent[] {
    const decoded = parseJsonLine(line);
    if (!decoded) return textOutput(line);
    const body = isRecord(decoded.parsed) ? decoded.parsed : {};
    const type = decoded.eventType;
    const part = isRecord(body.part) ? body.part : {};
    const usage = isRecord(body.usage)
      ? body.usage
      : isRecord(body.tokens)
        ? body.tokens
        : isRecord(part.usage)
          ? part.usage
          : isRecord(part.tokens)
            ? part.tokens
          : {};
    const cache = isRecord(usage.cache) ? usage.cache : {};
    const uncachedInput = numberField(usage, "input_tokens") ?? numberField(usage, "inputTokens") ?? numberField(usage, "input");
    const inputTokens = uncachedInput === undefined ? undefined
      : uncachedInput + (numberField(cache, "read") ?? 0) + (numberField(cache, "write") ?? 0);
    const outputTokens = numberField(usage, "output_tokens") ?? numberField(usage, "outputTokens") ?? numberField(usage, "output");
    const costUsd = numberField(body, "cost_usd") ?? numberField(body, "costUsd") ?? numberField(body, "cost") ?? numberField(part, "cost");
    if (inputTokens !== undefined || outputTokens !== undefined || costUsd !== undefined) {
      return [{ type: "usage.updated", inputTokens, outputTokens, costUsd, providerEventType: type, raw: decoded.parsed }];
    }
    if (type.includes("permission") || type.includes("approval")) {
      return [{ type: "approval.requested", providerEventType: type, raw: decoded.parsed }];
    }
    if (type === "tool_use" && isRecord(part.state)) {
      const status = stringField(part.state, "status");
      if (status === "running" || status === "completed") {
        return [{
          type: status === "completed" ? "tool.finished" : "tool.started",
          toolName: stringField(part, "tool") ?? undefined,
          toolCallId: stringField(part, "callID") ?? undefined,
          providerEventType: type,
          raw: decoded.parsed,
        }];
      }
    }
    if (type.includes("tool") && type.includes("start")) {
      return [
        {
          type: "tool.started",
          toolName: stringField(body, "tool") ?? stringField(body, "name") ?? undefined,
          toolCallId: stringField(body, "id") ?? undefined,
          providerEventType: type,
          raw: decoded.parsed,
        },
      ];
    }
    if (type.includes("tool") && (type.includes("finish") || type.includes("complete"))) {
      return [
        {
          type: "tool.finished",
          toolName: stringField(body, "tool") ?? stringField(body, "name") ?? undefined,
          toolCallId: stringField(body, "id") ?? undefined,
          providerEventType: type,
          raw: decoded.parsed,
        },
      ];
    }
    const text = stringField(body, "text") ?? stringField(body, "content") ?? stringField(body, "message") ?? stringField(part, "text");
    if (text && (type.includes("text") || type.includes("message") || type.includes("response"))) {
      return [{ type: "output.delta", message: text, providerEventType: type, raw: decoded.parsed }];
    }
    return [{ type: "provider.event", providerEventType: type, raw: decoded.parsed }];
  }
}
