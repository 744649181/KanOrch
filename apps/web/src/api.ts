import type {
  AddWorkItemInput,
  AddDependencyInput,
  AgentProfile,
  AgentHandoff,
  FunctionalRole,
  ProjectBudgetPolicy,
  ProjectPolicy,
  ProjectState,
  StoredEvent,
  WorkItemStatus,
} from "../../../packages/domain/src/index.ts";
import type { AgentPermissionMode } from "../../../packages/agent-protocol/src/index.ts";
import type { CommandResult } from "../../../packages/control-plane/src/index.ts";
import type { PlanProjectResult } from "../../../packages/planner/src/index.ts";

export interface ProjectView {
  revision: number;
  state: ProjectState;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(readErrorMessage(body) ?? `KanOrch API returned HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export async function listProjects(): Promise<ProjectView[]> {
  const response = await request<{ projects: ProjectView[] }>("/api/projects");
  return response.projects;
}

export function getProject(projectId: string): Promise<ProjectView> {
  return request(`/api/projects/${encodeURIComponent(projectId)}`);
}

export function createProject(input: {
  projectId: string;
  name: string;
  repositoryPath: string;
  baseBranch?: string;
  goal: string;
  policy?: Partial<ProjectPolicy>;
  budget?: Partial<ProjectBudgetPolicy>;
}): Promise<CommandResult> {
  return request("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      expectedRevision: 0,
      idempotencyKey: crypto.randomUUID(),
      project: input,
    }),
  });
}

export function addWorkItem(
  projectId: string,
  revision: number,
  workItem: AddWorkItemInput,
): Promise<CommandResult> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/work-items`, {
    method: "POST",
    body: JSON.stringify({
      expectedRevision: revision,
      idempotencyKey: crypto.randomUUID(),
      workItem,
    }),
  });
}

export function planProject(
  projectId: string,
  revision: number,
  agentId?: string,
): Promise<PlanProjectResult> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/plan`, {
    method: "POST",
    body: JSON.stringify({
      expectedRevision: revision,
      idempotencyKey: crypto.randomUUID(),
      agentId,
    }),
  });
}

export function addDependency(
  projectId: string,
  revision: number,
  dependency: AddDependencyInput,
): Promise<CommandResult> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/dependencies`, {
    method: "POST",
    body: JSON.stringify({
      expectedRevision: revision,
      idempotencyKey: crypto.randomUUID(),
      dependency,
    }),
  });
}

export function changeWorkItemStatus(
  projectId: string,
  workItemId: string,
  status: WorkItemStatus,
  revision: number,
): Promise<CommandResult> {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/status`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: revision,
        idempotencyKey: crypto.randomUUID(),
        status,
      }),
    },
  );
}

export function registerAgent(
  projectId: string,
  revision: number,
  agent: Omit<AgentProfile, "createdAt">,
): Promise<CommandResult> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/agents`, {
    method: "POST",
    body: JSON.stringify({
      expectedRevision: revision,
      idempotencyKey: crypto.randomUUID(),
      agent,
    }),
  });
}

export function setWorkItemRoles(
  projectId: string,
  workItemId: string,
  allowedRoles: FunctionalRole[],
  revision: number,
): Promise<CommandResult> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/roles`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision: revision, idempotencyKey: crypto.randomUUID(), allowedRoles }),
  });
}

export function recordAgentHandoff(
  projectId: string,
  revision: number,
  handoff: Omit<AgentHandoff, "messageId" | "projectId" | "createdAt">,
): Promise<CommandResult> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/handoffs`, {
    method: "POST",
    body: JSON.stringify({
      expectedRevision: revision,
      idempotencyKey: crypto.randomUUID(),
      handoff: { ...handoff, messageId: crypto.randomUUID() },
    }),
  });
}

export function executeAgentRun(
  projectId: string,
  workItemId: string,
  revision: number,
  run: {
    role: FunctionalRole;
    prompt: string;
    permissionMode: AgentPermissionMode;
    agentId?: string;
    baseRef?: string;
    subjectRunId?: string | null;
  },
): Promise<{ execution: { runId: string; status: string }; project: ProjectView }> {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/runs`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: revision,
        idempotencyKey: crypto.randomUUID(),
        run: { ...run, runId: crypto.randomUUID() },
      }),
    },
  );
}

export function cancelAgentRun(projectId: string, runId: string): Promise<{ cancelled: boolean }> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
  });
}

export function startAgentTerminal(
  projectId: string,
  workItemId: string,
  revision: number,
  input: { agentId: string; role: FunctionalRole },
): Promise<{ terminal: { runId: string }; project: ProjectView }> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/terminals`, {
    method: "POST",
    body: JSON.stringify({
      expectedRevision: revision,
      idempotencyKey: crypto.randomUUID(),
      ...input,
      cols: 100,
      rows: 30,
    }),
  });
}

export async function getRunEvents(projectId: string, runId: string): Promise<StoredEvent[]> {
  const response = await request<{ events: StoredEvent[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/events`,
  );
  return response.events;
}

export async function getArtifactText(projectId: string, artifactId: string): Promise<string> {
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}`,
  );
  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    throw new ApiError(response.status, body);
  }
  return response.text();
}

export function importKNow(
  projectId: string,
  revision: number,
  sourcePath: string,
): Promise<CommandResult> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/imports/k-now`, {
    method: "POST",
    body: JSON.stringify({
      expectedRevision: revision,
      idempotencyKey: crypto.randomUUID(),
      sourcePath,
    }),
  });
}

export function deliverWorkItem(
  projectId: string,
  workItemId: string,
  revision: number,
): Promise<{ delivery: { status: "done" | "paused"; decisionId: string | null }; project: ProjectView }> {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/deliver`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: revision,
        idempotencyKey: crypto.randomUUID(),
      }),
    },
  );
}

export function integrateVerifiedWorkItem(projectId: string, workItemId: string, revision: number, implementationRunId: string): Promise<{ merge: { commitSha: string; summary: string }; project: ProjectView }> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/work-items/${encodeURIComponent(workItemId)}/integrate`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision: revision, idempotencyKey: crypto.randomUUID(), implementationRunId }),
  });
}

export function resolveDecision(
  projectId: string,
  decisionId: string,
  selectedOptionId: string,
  revision: number,
): Promise<CommandResult> {
  return request(
    `/api/projects/${encodeURIComponent(projectId)}/decisions/${encodeURIComponent(decisionId)}/resolve`,
    {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: revision,
        idempotencyKey: crypto.randomUUID(),
        selectedOptionId,
      }),
    },
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
}

function readErrorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}
