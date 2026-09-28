import type { AdapterOutputEvent, AgentLaunchRequest } from "../../agent-protocol/src/index.ts";

export function requireLaunchRequest(request: AgentLaunchRequest): void {
  if (!request.runId.trim()) throw new TypeError("runId is required");
  if (!request.prompt.trim()) throw new TypeError("prompt is required");
  if (!request.workspacePath.trim()) throw new TypeError("workspacePath is required");
  if (request.maxBudgetUsd !== undefined && request.maxBudgetUsd <= 0) {
    throw new TypeError("maxBudgetUsd must be positive");
  }
}
export function parseJsonLine(line: string): { parsed: unknown; eventType: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const body = isRecord(parsed) ? parsed : {};
    const eventType = stringField(body, "type") ?? stringField(body, "event") ?? "unknown";
    return { parsed, eventType };
  } catch {
    return null;
  }
}

export function textOutput(line: string): AdapterOutputEvent[] {
  if (!line) return [];
  return [{ type: "output.delta", message: line, raw: line }];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stringField(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

export function numberField(value: Record<string, unknown>, key: string): number | undefined {
  return typeof value[key] === "number" ? value[key] : undefined;
}
