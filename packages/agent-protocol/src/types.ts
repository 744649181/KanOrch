import type { AgentAdapterKind } from "../../domain/src/model.ts";

export type AgentPermissionMode = "manual" | "workspace-auto" | "external-sandbox-auto";

export interface AgentLaunchRequest {
  runId: string;
  prompt: string;
  workspacePath: string;
  model?: string;
  sessionId?: string;
  permissionMode: AgentPermissionMode;
  maxBudgetUsd?: number;
  extraEnvironment?: Record<string, string>;
}
export interface AgentLaunchSpec {
  adapterKind: AgentAdapterKind;
  executable: string;
  args: string[];
  cwd: string;
  stdin: string | null;
  environment: Record<string, string>;
}

export type NormalizedRunEventType =
  | "run.started"
  | "session.discovered"
  | "output.delta"
  | "tool.started"
  | "tool.finished"
  | "approval.requested"
  | "usage.updated"
  | "artifact.created"
  | "run.succeeded"
  | "run.failed"
  | "run.cancelled"
  | "provider.event";

export interface AdapterOutputEvent {
  type: NormalizedRunEventType;
  message?: string;
  providerEventType?: string;
  sessionId?: string;
  toolName?: string;
  toolCallId?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  raw: unknown;
}

export interface PersistedRunEvent extends AdapterOutputEvent {
  eventId: string;
  runId: string;
  sequence: number;
  occurredAt: string;
}

export interface AgentAdapter {
  readonly kind: AgentAdapterKind;
  readonly displayName: string;
  readonly executable: string;
  buildLaunchSpec(request: AgentLaunchRequest): AgentLaunchSpec;
  parseStdoutLine(line: string): AdapterOutputEvent[];
}
