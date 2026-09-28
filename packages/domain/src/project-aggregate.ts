import type { DomainEvent } from "./events.ts";
import {
  defaultProjectBudgetPolicy,
  defaultProjectPolicy,
  emptyProjectState,
  FUNCTIONAL_ROLES,
  type Artifact,
  type AgentProfile,
  type AgentRun,
  type AgentHandoff,
  type BudgetEntry,
  type DecisionRequest,
  type Dependency,
  type Evidence,
  type FunctionalRole,
  type LegacyImportReceipt,
  type Project,
  type ProjectPolicy,
  type ProjectBudgetPolicy,
  type ProjectState,
  type WorkItem,
  type WorkItemKind,
  type WorkItemStatus,
} from "./model.ts";

export class DomainRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainRuleError";
  }
}

function now(): string {
  return new Date().toISOString();
}

function normalizedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function evolveProject(state: ProjectState, event: DomainEvent): ProjectState {
  const next = structuredClone(state);
  switch (event.eventType) {
    case "project.created":
      next.project = event.payload.project;
      return next;
    case "work_item.added":
      next.workItems[event.payload.workItem.workItemId] = event.payload.workItem;
      return next;
    case "work_item.roles_changed": {
      const item = next.workItems[event.payload.workItemId];
      if (!item) throw new DomainRuleError(`work item '${event.payload.workItemId}' does not exist`);
      item.allowedRoles = event.payload.allowedRoles;
      return next;
    }
    case "work_item.status_changed": {
      const item = next.workItems[event.payload.workItemId];
      if (!item) throw new DomainRuleError(`work item '${event.payload.workItemId}' does not exist`);
      item.ownStatus = event.payload.status;
      return next;
    }
    case "dependency.added":
      next.dependencies[event.payload.dependency.dependencyId] = event.payload.dependency;
      return next;
    case "agent.registered":
      next.agents[event.payload.agent.agentId] = event.payload.agent;
      return next;
    case "agent_run.started":
      next.runs[event.payload.run.runId] = event.payload.run;
      return next;
    case "agent_handoff.recorded":
      next.handoffs[event.payload.handoff.messageId] = event.payload.handoff;
      return next;
    case "agent_handoff.artifact_fetched": {
      const handoff = next.handoffs[event.payload.messageId];
      if (!handoff) throw new DomainRuleError(`handoff '${event.payload.messageId}' does not exist`);
      handoff.artifactReads ??= {};
      handoff.artifactReads[event.payload.recipientRunId] ??= {};
      handoff.artifactReads[event.payload.recipientRunId]![event.payload.artifactId] = event.payload.fetchedAt;
      return next;
    }
    case "agent_handoff.acknowledged": {
      const handoff = next.handoffs[event.payload.messageId];
      if (!handoff) throw new DomainRuleError(`handoff '${event.payload.messageId}' does not exist`);
      handoff.acknowledgedByRunId = event.payload.recipientRunId;
      handoff.acknowledgedAt = event.payload.acknowledgedAt;
      return next;
    }
    case "workspace_lease.acquired":
      next.workspaceLeases[event.payload.lease.leaseId] = event.payload.lease;
      return next;
    case "workspace_lease.released": {
      const lease = next.workspaceLeases[event.payload.leaseId];
      if (!lease) throw new DomainRuleError(`workspace lease '${event.payload.leaseId}' does not exist`);
      lease.status = "released";
      lease.releasedAt = event.payload.releasedAt;
      return next;
    }
    case "artifact.recorded":
      next.artifacts[event.payload.artifact.artifactId] = event.payload.artifact;
      return next;
    case "evidence.recorded":
      next.evidence[event.payload.evidence.evidenceId] = event.payload.evidence;
      return next;
    case "budget.recorded":
      next.budgetEntries[event.payload.entry.budgetEntryId] = event.payload.entry;
      return next;
    case "legacy_import.recorded":
      next.importReceipts[event.payload.receipt.importId] = event.payload.receipt;
      return next;
    case "agent_run.finished": {
      const run = next.runs[event.payload.runId];
      if (!run) throw new DomainRuleError(`agent run '${event.payload.runId}' does not exist`);
      run.status = event.payload.status;
      run.finishedAt = event.payload.finishedAt;
      return next;
    }
    case "decision.requested":
      next.decisions[event.payload.decision.decisionId] = event.payload.decision;
      return next;
    case "decision.resolved": {
      const decision = next.decisions[event.payload.decisionId];
      if (!decision) throw new DomainRuleError(`decision '${event.payload.decisionId}' does not exist`);
      decision.status = "resolved";
      decision.selectedOptionId = event.payload.selectedOptionId;
      decision.resolvedAt = event.payload.resolvedAt;
      return next;
    }
  }
}

export function replayProject(events: readonly DomainEvent[]): ProjectState {
  return events.reduce(evolveProject, emptyProjectState());
}

export interface CreateProjectInput {
  projectId: string;
  name: string;
  repositoryPath: string;
  baseBranch?: string;
  goal: string;
  policy?: Partial<ProjectPolicy>;
  budget?: Partial<ProjectBudgetPolicy>;
  createdAt?: string;
}

export function decideCreateProject(state: ProjectState, input: CreateProjectInput): DomainEvent {
  if (state.project) throw new DomainRuleError(`project '${state.project.projectId}' already exists`);
  if (!input.projectId.trim()) throw new DomainRuleError("projectId is required");
  if (!input.name.trim()) throw new DomainRuleError("project name is required");
  if (!input.repositoryPath.trim()) throw new DomainRuleError("repositoryPath is required");
  if (input.baseBranch !== undefined && !input.baseBranch.trim()) throw new DomainRuleError("baseBranch cannot be empty");
  if (!input.goal.trim()) throw new DomainRuleError("project goal is required");
  const policy = { ...defaultProjectPolicy(), ...input.policy };
  for (const [name, value] of Object.entries(policy)) {
    if (typeof value === "number" && (!Number.isInteger(value) || value < 0)) {
      throw new DomainRuleError(`project policy '${name}' must be a non-negative integer`);
    }
  }
  if (policy.maxAttemptsPerStage < 1) {
    throw new DomainRuleError("project policy 'maxAttemptsPerStage' must be at least 1");
  }
  const budget = { ...defaultProjectBudgetPolicy(), ...input.budget };
  for (const [name, value] of Object.entries(budget)) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new DomainRuleError(`project budget '${name}' must be null or a non-negative number`);
    }
  }
  const project: Project = {
    projectId: input.projectId,
    name: input.name,
    repositoryPath: input.repositoryPath,
    baseBranch: input.baseBranch?.trim() || "main",
    goal: input.goal,
    policy,
    budget,
    createdAt: input.createdAt ?? now(),
  };
  return { eventType: "project.created", payload: { project } };
}

export interface AddWorkItemInput {
  workItemId: string;
  parentWorkItemId?: string | null;
  kind: WorkItemKind;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  requiredCapabilities?: string[];
  allowedRoles?: FunctionalRole[];
  codeScopes?: string[];
  origin?: WorkItem["origin"];
  createdAt?: string;
}

export function decideAddWorkItem(state: ProjectState, input: AddWorkItemInput): DomainEvent {
  const project = requireProject(state);
  if (state.workItems[input.workItemId]) {
    throw new DomainRuleError(`work item '${input.workItemId}' already exists`);
  }
  if (!input.title.trim()) throw new DomainRuleError("work item title is required");
  if (!input.description.trim()) throw new DomainRuleError("work item description is required");
  if (input.acceptanceCriteria.length === 0 || input.acceptanceCriteria.some((value) => !value.trim())) {
    throw new DomainRuleError("work item requires at least one non-empty acceptance criterion");
  }
  const parentId = input.parentWorkItemId ?? null;
  const parent = parentId ? state.workItems[parentId] : null;
  if (parentId && !parent) throw new DomainRuleError(`parent work item '${parentId}' does not exist`);
  const decompositionDepth = parent ? parent.decompositionDepth + 1 : 0;
  if (decompositionDepth > project.policy.maxDecompositionDepth) {
    throw new DomainRuleError(
      `work item depth ${decompositionDepth} exceeds maxDecompositionDepth ${project.policy.maxDecompositionDepth}`,
    );
  }
  const item: WorkItem = {
    workItemId: input.workItemId,
    projectId: project.projectId,
    parentWorkItemId: parentId,
    kind: input.kind,
    title: input.title,
    description: input.description,
    acceptanceCriteria: [...input.acceptanceCriteria],
    requiredCapabilities: normalizedUnique(input.requiredCapabilities ?? []),
    allowedRoles: normalizedUnique(input.allowedRoles ?? []) as FunctionalRole[],
    codeScopes: normalizedUnique(input.codeScopes?.length ? input.codeScopes : ["."]),
    origin: input.origin ?? "native",
    ownStatus: "backlog",
    aggregateStatus: "backlog",
    decompositionDepth,
    createdAt: input.createdAt ?? now(),
  };
  return { eventType: "work_item.added", payload: { workItem: item } };
}

export function decideSetWorkItemRoles(
  state: ProjectState,
  workItemId: string,
  allowedRoles: FunctionalRole[],
): DomainEvent {
  const item = state.workItems[workItemId];
  if (!item) throw new DomainRuleError(`work item '${workItemId}' does not exist`);
  if (["running", "done", "cancelled"].includes(item.ownStatus) ||
      Object.values(state.workspaceLeases).some((lease) => lease.workItemId === workItemId && lease.status === "active")) {
    throw new DomainRuleError(`work item '${workItemId}' cannot change roles while active or complete`);
  }
  if (allowedRoles.some((role) => !FUNCTIONAL_ROLES.includes(role))) {
    throw new DomainRuleError("work item roles contain an unknown role");
  }
  return { eventType: "work_item.roles_changed", payload: {
    workItemId, allowedRoles: normalizedUnique(allowedRoles) as FunctionalRole[],
  } };
}

export interface AddDependencyInput {
  dependencyId?: string;
  upstreamWorkItemId: string;
  downstreamWorkItemId: string;
  kind: Dependency["kind"];
  createdAt?: string;
}

export interface ApplyPlannedWorkGraphInput {
  planRootWorkItemId: string;
  workItems: AddWorkItemInput[];
  dependencies: AddDependencyInput[];
}

/** Atomically validates and materializes a planner-produced work graph. */
export function decideApplyPlannedWorkGraph(
  state: ProjectState,
  input: ApplyPlannedWorkGraphInput,
): DomainEvent[] {
  const planRoot = state.workItems[input.planRootWorkItemId];
  if (!planRoot || !planRoot.allowedRoles.includes("planning")) {
    throw new DomainRuleError(`planning root '${input.planRootWorkItemId}' does not exist`);
  }
  const existingNative = Object.values(state.workItems).filter(
    (item) => item.origin === "native" && item.workItemId !== input.planRootWorkItemId,
  );
  if (existingNative.length > 0) {
    throw new DomainRuleError(
      `automatic planning cannot overwrite existing native work items: ${existingNative.map((item) => item.workItemId).join(", ")}`,
    );
  }
  if (input.workItems.length === 0) throw new DomainRuleError("planned work graph must contain at least one work item");

  const events: DomainEvent[] = [];
  let staged = state;
  for (const workItem of input.workItems) {
    const event = decideAddWorkItem(staged, { ...workItem, origin: "native" });
    events.push(event);
    staged = evolveProject(staged, event);
  }
  for (const dependency of input.dependencies) {
    const event = decideAddDependency(staged, dependency);
    events.push(event);
    staged = evolveProject(staged, event);
  }

  const blockedIds = new Set(
    input.dependencies
      .filter((dependency) => dependency.kind !== "conflicts_with")
      .map((dependency) => dependency.downstreamWorkItemId),
  );
  for (const workItem of input.workItems) {
    if (blockedIds.has(workItem.workItemId)) continue;
    const event = decideChangeWorkItemStatus(staged, workItem.workItemId, "ready");
    events.push(event);
    staged = evolveProject(staged, event);
  }
  events.push(decideChangeWorkItemStatus(staged, input.planRootWorkItemId, "done"));
  return events;
}

export function decideAddDependency(state: ProjectState, input: AddDependencyInput): DomainEvent {
  const project = requireProject(state);
  if (!state.workItems[input.upstreamWorkItemId]) {
    throw new DomainRuleError(`upstream work item '${input.upstreamWorkItemId}' does not exist`);
  }
  if (!state.workItems[input.downstreamWorkItemId]) {
    throw new DomainRuleError(`downstream work item '${input.downstreamWorkItemId}' does not exist`);
  }
  if (input.upstreamWorkItemId === input.downstreamWorkItemId) {
    throw new DomainRuleError("a work item cannot depend on itself");
  }
  const duplicate = Object.values(state.dependencies).find(
    (dependency) =>
      dependency.upstreamWorkItemId === input.upstreamWorkItemId &&
      dependency.downstreamWorkItemId === input.downstreamWorkItemId &&
      dependency.kind === input.kind,
  );
  if (duplicate) throw new DomainRuleError(`dependency '${duplicate.dependencyId}' already exists`);
  if (input.kind !== "conflicts_with" && createsDirectedCycle(state, input)) {
    throw new DomainRuleError(
      `dependency '${input.upstreamWorkItemId}' -> '${input.downstreamWorkItemId}' creates a cycle`,
    );
  }
  const dependency: Dependency = {
    dependencyId: input.dependencyId ?? globalThis.crypto.randomUUID(),
    projectId: project.projectId,
    upstreamWorkItemId: input.upstreamWorkItemId,
    downstreamWorkItemId: input.downstreamWorkItemId,
    kind: input.kind,
    createdAt: input.createdAt ?? now(),
  };
  if (state.dependencies[dependency.dependencyId]) {
    throw new DomainRuleError(`dependency id '${dependency.dependencyId}' already exists`);
  }
  return { eventType: "dependency.added", payload: { dependency } };
}

function createsDirectedCycle(state: ProjectState, input: AddDependencyInput): boolean {
  const adjacency = new Map<string, string[]>();
  for (const dependency of Object.values(state.dependencies)) {
    if (dependency.kind === "conflicts_with") continue;
    const targets = adjacency.get(dependency.upstreamWorkItemId) ?? [];
    targets.push(dependency.downstreamWorkItemId);
    adjacency.set(dependency.upstreamWorkItemId, targets);
  }
  const targets = adjacency.get(input.upstreamWorkItemId) ?? [];
  targets.push(input.downstreamWorkItemId);
  adjacency.set(input.upstreamWorkItemId, targets);
  const visited = new Set<string>();
  const stack = [input.downstreamWorkItemId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (current === input.upstreamWorkItemId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

export function decideRegisterAgent(state: ProjectState, agent: AgentProfile): DomainEvent {
  requireProject(state);
  if (state.agents[agent.agentId]) throw new DomainRuleError(`agent '${agent.agentId}' already exists`);
  if (!agent.agentId.trim() || !agent.displayName.trim()) {
    throw new DomainRuleError("agent id and display name are required");
  }
  if (agent.reliability < 0 || agent.reliability > 1) {
    throw new DomainRuleError("agent reliability must be between 0 and 1");
  }
  if (!Number.isInteger(agent.maxConcurrentRuns) || agent.maxConcurrentRuns < 1) {
    throw new DomainRuleError("agent maxConcurrentRuns must be a positive integer");
  }
  return {
    eventType: "agent.registered",
    payload: {
      agent: {
        ...agent,
        capabilities: normalizedUnique(agent.capabilities),
        roles: normalizedUnique(agent.roles) as FunctionalRole[],
      },
    },
  };
}

export interface StartAgentRunInput {
  runId?: string;
  mode?: AgentRun["mode"];
  workItemId: string;
  agentId: string;
  role: FunctionalRole;
  attempt: number;
  delegationDepth: number;
  worktreePath: string;
  branchName: string;
  startedAt?: string;
}

export function decideStartAgentRun(state: ProjectState, input: StartAgentRunInput): DomainEvent[] {
  const project = requireProject(state);
  const item = state.workItems[input.workItemId];
  if (!item) throw new DomainRuleError(`work item '${input.workItemId}' does not exist`);
  const agent = state.agents[input.agentId];
  if (!agent || !agent.active) throw new DomainRuleError(`agent '${input.agentId}' is not active`);
  if (item.ownStatus !== "ready") {
    throw new DomainRuleError(`work item '${input.workItemId}' is not ready`);
  }
  const blocking = unsatisfiedDependencies(state, input.workItemId);
  if (blocking.length > 0) {
    throw new DomainRuleError(`work item '${input.workItemId}' is blocked by ${blocking.join(", ")}`);
  }
  if (!agent.roles.includes(input.role)) {
    throw new DomainRuleError(`agent '${input.agentId}' does not support role '${input.role}'`);
  }
  if (item.allowedRoles.length > 0 && !item.allowedRoles.includes(input.role)) {
    throw new DomainRuleError(`work item '${input.workItemId}' does not allow role '${input.role}'`);
  }
  const missingCapabilities = item.requiredCapabilities.filter(
    (capability) => !agent.capabilities.includes(capability),
  );
  if (missingCapabilities.length > 0) {
    throw new DomainRuleError(`agent '${input.agentId}' lacks capabilities: ${missingCapabilities.join(", ")}`);
  }
  if (input.delegationDepth > project.policy.maxAgentDelegationDepth) {
    throw new DomainRuleError(
      `delegation depth ${input.delegationDepth} exceeds maxAgentDelegationDepth ${project.policy.maxAgentDelegationDepth}`,
    );
  }
  if (input.attempt < 1 || input.attempt > project.policy.maxAttemptsPerStage) {
    throw new DomainRuleError(`attempt ${input.attempt} is outside the configured stage retry budget`);
  }
  const activeRuns = Object.values(state.runs).filter(
    (run) => run.workItemId === input.workItemId && !["succeeded", "failed", "cancelled"].includes(run.status),
  );
  if (activeRuns.length > 0) {
    throw new DomainRuleError(`work item '${input.workItemId}' already has an active run`);
  }
  if (project.policy.requireIndependentReview && input.role === "review") {
    const implementingAgents = new Set(
      Object.values(state.runs)
        .filter((run) => run.workItemId === input.workItemId && run.role === "implementation")
        .map((run) => run.agentId),
    );
    if (implementingAgents.has(input.agentId)) {
      throw new DomainRuleError(`agent '${input.agentId}' cannot independently review its own implementation`);
    }
  }
  const run: AgentRun = {
    runId: input.runId ?? globalThis.crypto.randomUUID(),
    mode: input.mode ?? "batch",
    projectId: project.projectId,
    workItemId: input.workItemId,
    agentId: input.agentId,
    role: input.role,
    status: "running",
    attempt: input.attempt,
    delegationDepth: input.delegationDepth,
    worktreePath: input.worktreePath,
    branchName: input.branchName,
    startedAt: input.startedAt ?? now(),
    finishedAt: null,
  };
  return [
    { eventType: "agent_run.started", payload: { run } },
    { eventType: "work_item.status_changed", payload: { workItemId: item.workItemId, status: "running" } },
  ];
}

export function decideChangeWorkItemStatus(
  state: ProjectState,
  workItemId: string,
  status: WorkItemStatus,
): DomainEvent {
  if (!state.workItems[workItemId]) throw new DomainRuleError(`work item '${workItemId}' does not exist`);
  return { eventType: "work_item.status_changed", payload: { workItemId, status } };
}

export function decideFinishAgentRun(
  state: ProjectState,
  runId: string,
  status: "succeeded" | "failed" | "cancelled",
  finishedAt = now(),
): DomainEvent[] {
  const run = state.runs[runId];
  if (!run) throw new DomainRuleError(`agent run '${runId}' does not exist`);
  if (!["queued", "starting", "running", "waiting_approval"].includes(run.status)) {
    throw new DomainRuleError(`agent run '${runId}' is already terminal`);
  }
  let workItemStatus: WorkItemStatus = "blocked";
  if (status === "succeeded") {
    if (run.role === "implementation") workItemStatus = "waiting_review";
    else if (run.role === "review") workItemStatus = "verifying";
    else workItemStatus = "verifying";
  } else if (status === "cancelled") {
    workItemStatus = "ready";
  }
  return [
    { eventType: "agent_run.finished", payload: { runId, status, finishedAt } },
    { eventType: "work_item.status_changed", payload: { workItemId: run.workItemId, status: workItemStatus } },
  ];
}

export function decideRecordArtifact(state: ProjectState, artifact: Artifact): DomainEvent {
  const project = requireProject(state);
  if (artifact.projectId !== project.projectId) throw new DomainRuleError("artifact project does not match");
  requireRunAndWorkItem(state, artifact.runId, artifact.workItemId, "artifact");
  if (state.artifacts[artifact.artifactId]) throw new DomainRuleError(`artifact '${artifact.artifactId}' already exists`);
  if (!artifact.relativePath.trim() || !/^[a-f0-9]{64}$/i.test(artifact.contentHash)) {
    throw new DomainRuleError("artifact requires a relative path and SHA-256 content hash");
  }
  if (!Number.isInteger(artifact.byteLength) || artifact.byteLength < 0) {
    throw new DomainRuleError("artifact byteLength must be a non-negative integer");
  }
  return { eventType: "artifact.recorded", payload: { artifact } };
}

export type RecordAgentHandoffInput = Omit<AgentHandoff, "projectId" | "createdAt" | "artifactReads" | "acknowledgedByRunId" | "acknowledgedAt"> & {
  createdAt?: string;
};

export function decideRecordAgentHandoff(
  state: ProjectState,
  input: RecordAgentHandoffInput,
): DomainEvent {
  const project = requireProject(state);
  const source = requireRunAndWorkItem(state, input.sourceRunId, input.workItemId, "handoff");
  const recipient = state.agents[input.recipientAgentId];
  if (!recipient || !recipient.active) throw new DomainRuleError("handoff recipient agent is not active");
  if (source.agentId === recipient.agentId) throw new DomainRuleError("handoff requires another agent");
  if (!input.messageId.trim() || state.handoffs[input.messageId]) {
    throw new DomainRuleError("handoff messageId is empty or already exists");
  }
  if (!input.summary.trim()) throw new DomainRuleError("handoff summary is required");
  for (const artifactId of input.artifactIds) {
    const artifact = state.artifacts[artifactId];
    if (!artifact || artifact.runId !== source.runId) {
      throw new DomainRuleError(`handoff artifact '${artifactId}' does not belong to source run`);
    }
  }
  return {
    eventType: "agent_handoff.recorded",
    payload: {
      handoff: {
        ...input,
        projectId: project.projectId,
        summary: input.summary.trim(),
        artifactIds: [...new Set(input.artifactIds)],
        createdAt: input.createdAt ?? now(),
        artifactReads: {},
        acknowledgedByRunId: null,
        acknowledgedAt: null,
      },
    },
  };
}

function requireHandoffRecipientRun(state: ProjectState, messageId: string, recipientRunId: string): AgentHandoff {
  const handoff = state.handoffs[messageId];
  const run = state.runs[recipientRunId];
  if (!handoff || !run || run.projectId !== handoff.projectId ||
      run.workItemId !== handoff.workItemId || run.agentId !== handoff.recipientAgentId ||
      run.startedAt === null || run.finishedAt !== null) {
    throw new DomainRuleError("handoff recipient run is not active or does not match the message");
  }
  return handoff;
}

export function decideFetchHandoffArtifact(
  state: ProjectState, messageId: string, artifactId: string, recipientRunId: string,
): DomainEvent {
  const handoff = requireHandoffRecipientRun(state, messageId, recipientRunId);
  if (!handoff.artifactIds.includes(artifactId)) throw new DomainRuleError("artifact is not attached to this handoff");
  if (handoff.acknowledgedAt) throw new DomainRuleError("handoff is already acknowledged");
  return { eventType: "agent_handoff.artifact_fetched", payload: {
    messageId, artifactId, recipientRunId, fetchedAt: now(),
  } };
}

export function decideAcknowledgeAgentHandoff(
  state: ProjectState, messageId: string, recipientRunId: string,
): DomainEvent {
  const handoff = requireHandoffRecipientRun(state, messageId, recipientRunId);
  if (handoff.acknowledgedAt) throw new DomainRuleError("handoff is already acknowledged");
  const missing = handoff.artifactIds.filter((artifactId) => !handoff.artifactReads?.[recipientRunId]?.[artifactId]);
  if (missing.length) throw new DomainRuleError(`handoff artifacts must be fetched before acknowledgement: ${missing.join(", ")}`);
  return { eventType: "agent_handoff.acknowledged", payload: { messageId, recipientRunId, acknowledgedAt: now() } };
}

export function decideRecordEvidence(state: ProjectState, evidence: Evidence): DomainEvent {
  const project = requireProject(state);
  if (evidence.projectId !== project.projectId) throw new DomainRuleError("evidence project does not match");
  if (evidence.imported) {
    if (!state.workItems[evidence.workItemId]) {
      throw new DomainRuleError(`evidence work item '${evidence.workItemId}' does not exist`);
    }
    if (state.evidence[evidence.evidenceId]) throw new DomainRuleError(`evidence '${evidence.evidenceId}' already exists`);
    if (!evidence.summary.trim() || !evidence.producerAgentId.trim()) {
      throw new DomainRuleError("imported evidence requires a summary and historical producer identity");
    }
    if (evidence.artifactIds.some((artifactId) => !state.artifacts[artifactId]?.imported)) {
      throw new DomainRuleError("imported evidence may reference only imported artifacts");
    }
    return { eventType: "evidence.recorded", payload: { evidence } };
  }
  const run = requireRunAndWorkItem(state, evidence.runId, evidence.workItemId, "evidence");
  if (run.agentId !== evidence.producerAgentId) {
    throw new DomainRuleError("evidence producer must match the AgentRun identity");
  }
  if (state.evidence[evidence.evidenceId]) throw new DomainRuleError(`evidence '${evidence.evidenceId}' already exists`);
  if (!evidence.summary.trim()) throw new DomainRuleError("evidence summary is required");
  for (const artifactId of evidence.artifactIds) {
    const artifact = state.artifacts[artifactId];
    if (!artifact || artifact.workItemId !== evidence.workItemId) {
      throw new DomainRuleError(`evidence artifact '${artifactId}' does not belong to the work item`);
    }
  }
  if (evidence.kind === "review" && evidence.subjectRunId) {
    const subject = state.runs[evidence.subjectRunId];
    if (!subject || subject.workItemId !== evidence.workItemId) {
      throw new DomainRuleError("review evidence subject run does not belong to the work item");
    }
    if (subject.agentId === evidence.producerAgentId) {
      throw new DomainRuleError("independent review evidence cannot be produced by the implementation agent");
    }
  }
  return { eventType: "evidence.recorded", payload: { evidence } };
}

export function decideRecordBudgetEntry(state: ProjectState, entry: BudgetEntry): DomainEvent {
  const project = requireProject(state);
  if (entry.projectId !== project.projectId) throw new DomainRuleError("budget entry project does not match");
  requireRunAndWorkItem(state, entry.runId, entry.workItemId, "budget entry");
  if (state.budgetEntries[entry.budgetEntryId]) {
    throw new DomainRuleError(`budget entry '${entry.budgetEntryId}' already exists`);
  }
  for (const [name, value] of Object.entries(entry)) {
    if (["inputTokens", "outputTokens", "costUsd", "wallClockSeconds"].includes(name)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new DomainRuleError(`budget entry '${name}' must be a non-negative number`);
      }
    }
  }
  return { eventType: "budget.recorded", payload: { entry } };
}

export function decideRecordLegacyImport(
  state: ProjectState,
  receipt: LegacyImportReceipt,
): DomainEvent {
  const project = requireProject(state);
  if (receipt.projectId !== project.projectId) throw new DomainRuleError("legacy import project does not match");
  if (!/^[a-f0-9]{64}$/i.test(receipt.sourceHash)) throw new DomainRuleError("legacy import requires a SHA-256 source hash");
  if (Object.values(state.importReceipts).some((existing) => existing.sourceHash === receipt.sourceHash)) {
    throw new DomainRuleError(`legacy source '${receipt.sourceHash}' was already imported`);
  }
  return { eventType: "legacy_import.recorded", payload: { receipt } };
}

export function decideRequestDecision(state: ProjectState, decision: DecisionRequest): DomainEvent {
  const project = requireProject(state);
  if (decision.projectId !== project.projectId) throw new DomainRuleError("decision project does not match");
  if (state.decisions[decision.decisionId]) {
    throw new DomainRuleError(`decision '${decision.decisionId}' already exists`);
  }
  if (decision.options.length < 2 || decision.options.length > 3) {
    throw new DomainRuleError("decision requires two or three viable options");
  }
  if (!decision.options.some((option) => option.optionId === decision.recommendedOptionId)) {
    throw new DomainRuleError("recommended decision option does not exist");
  }
  if (!decision.objective.trim() || !decision.currentState.trim() || !decision.bottleneck.trim()) {
    throw new DomainRuleError("decision objective, currentState, and bottleneck are required");
  }
  return { eventType: "decision.requested", payload: { decision } };
}

export function decideResolveDecision(
  state: ProjectState,
  decisionId: string,
  selectedOptionId: string,
  resolvedAt = now(),
): DomainEvent {
  const decision = state.decisions[decisionId];
  if (!decision) throw new DomainRuleError(`decision '${decisionId}' does not exist`);
  if (decision.status !== "pending") throw new DomainRuleError(`decision '${decisionId}' is not pending`);
  if (!decision.options.some((option) => option.optionId === selectedOptionId)) {
    throw new DomainRuleError(`decision option '${selectedOptionId}' does not exist`);
  }
  return { eventType: "decision.resolved", payload: { decisionId, selectedOptionId, resolvedAt } };
}

export function unsatisfiedDependencies(state: ProjectState, workItemId: string): string[] {
  return Object.values(state.dependencies)
    .filter(
      (dependency) =>
        dependency.downstreamWorkItemId === workItemId && dependency.kind !== "conflicts_with",
    )
    .filter((dependency) => state.workItems[dependency.upstreamWorkItemId]?.ownStatus !== "done")
    .map((dependency) => dependency.upstreamWorkItemId)
    .sort();
}

function requireProject(state: ProjectState): Project {
  if (!state.project) throw new DomainRuleError("project has not been created");
  return state.project;
}

function requireRunAndWorkItem(
  state: ProjectState,
  runId: string,
  workItemId: string,
  entityName: string,
): AgentRun {
  const item = state.workItems[workItemId];
  if (!item) throw new DomainRuleError(`${entityName} work item '${workItemId}' does not exist`);
  const run = state.runs[runId];
  if (!run || run.workItemId !== workItemId) {
    throw new DomainRuleError(`${entityName} run '${runId}' does not belong to work item '${workItemId}'`);
  }
  return run;
}
