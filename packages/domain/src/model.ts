export const WORK_ITEM_KINDS = [
  "goal",
  "epic",
  "story",
  "task",
  "bug",
  "review",
  "test",
  "release",
] as const;

export type WorkItemKind = (typeof WORK_ITEM_KINDS)[number];

export const WORK_ITEM_STATUSES = [
  "backlog",
  "ready",
  "running",
  "waiting_review",
  "verifying",
  "blocked",
  "done",
  "cancelled",
] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const FUNCTIONAL_ROLES = [
  "planning",
  "architecture",
  "implementation",
  "review",
  "testing",
  "integration",
  "monitoring",
] as const;

export type FunctionalRole = (typeof FUNCTIONAL_ROLES)[number];

export type AgentAdapterKind = "codex" | "claude-code" | "opencode" | "external";
export type DependencyKind = "blocks" | "produces" | "conflicts_with";
export type AgentRunStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";

export type DecisionStatus = "pending" | "resolved" | "superseded";
export type DecisionTrigger =
  | "goal_drift"
  | "retry_exhausted"
  | "budget_exceeded"
  | "permission_escalation"
  | "workspace_conflict"
  | "architecture_risk";

export interface ProjectPolicy {
  maxDecompositionDepth: number;
  maxAgentDelegationDepth: number;
  maxAttemptsPerStage: number;
  maxReplanDepth: number;
  requireIndependentReview: boolean;
  requireTestEvidence: boolean;
  autoMerge: boolean;
}

export interface ProjectBudgetPolicy {
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  maxCostUsd: number | null;
  maxWallClockSeconds: number | null;
}

export interface Project {
  projectId: string;
  name: string;
  repositoryPath: string;
  baseBranch: string;
  goal: string;
  policy: ProjectPolicy;
  budget: ProjectBudgetPolicy;
  createdAt: string;
}

export interface WorkItem {
  workItemId: string;
  projectId: string;
  parentWorkItemId: string | null;
  kind: WorkItemKind;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  requiredCapabilities: string[];
  allowedRoles: FunctionalRole[];
  codeScopes: string[];
  origin: "native" | "k-now";
  ownStatus: WorkItemStatus;
  aggregateStatus: WorkItemStatus;
  decompositionDepth: number;
  createdAt: string;
}

export interface Dependency {
  dependencyId: string;
  projectId: string;
  upstreamWorkItemId: string;
  downstreamWorkItemId: string;
  kind: DependencyKind;
  createdAt: string;
}

export interface AgentProfile {
  agentId: string;
  displayName: string;
  adapterKind: AgentAdapterKind;
  capabilities: string[];
  roles: FunctionalRole[];
  reliability: number;
  costPerMillionTokens: number | null;
  active: boolean;
  maxConcurrentRuns: number;
  createdAt: string;
}

export interface AgentRun {
  runId: string;
  mode?: "batch" | "terminal";
  projectId: string;
  workItemId: string;
  agentId: string;
  role: FunctionalRole;
  status: AgentRunStatus;
  attempt: number;
  delegationDepth: number;
  worktreePath: string;
  branchName: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AgentHandoff {
  messageId: string;
  projectId: string;
  workItemId: string;
  sourceRunId: string;
  recipientAgentId: string;
  kind: "handoff" | "blocker" | "review_request";
  summary: string;
  artifactIds: string[];
  createdAt: string;
  artifactReads?: Record<string, Record<string, string>>;
  acknowledgedByRunId?: string | null;
  acknowledgedAt?: string | null;
}

export interface WorkspaceLease {
  leaseId: string;
  projectId: string;
  workItemId: string;
  runId: string;
  worktreePath: string;
  branchName: string;
  codeScopes: string[];
  status: "active" | "released";
  acquiredAt: string;
  releasedAt: string | null;
}

export type ArtifactKind = "log" | "diff" | "commit" | "report" | "output" | "test-results";

export interface Artifact {
  artifactId: string;
  projectId: string;
  workItemId: string;
  runId: string;
  kind: ArtifactKind;
  relativePath: string;
  contentHash: string;
  byteLength: number;
  mediaType: string;
  imported: boolean;
  createdAt: string;
}

export type EvidenceKind = "implementation" | "review" | "test" | "build" | "security" | "integration";
export type EvidenceVerdict = "passed" | "failed" | "informational";

export interface Evidence {
  evidenceId: string;
  projectId: string;
  workItemId: string;
  runId: string;
  producerAgentId: string;
  kind: EvidenceKind;
  verdict: EvidenceVerdict;
  summary: string;
  artifactIds: string[];
  subjectRunId: string | null;
  imported: boolean;
  createdAt: string;
}

export type BudgetEntryKind = "reservation" | "actual" | "release";

export interface BudgetEntry {
  budgetEntryId: string;
  projectId: string;
  workItemId: string;
  runId: string;
  kind: BudgetEntryKind;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  wallClockSeconds: number;
  createdAt: string;
}

export interface LegacyImportReceipt {
  importId: string;
  projectId: string;
  sourceKind: "k-now";
  sourcePath: string;
  sourceHash: string;
  sourceRevision: number;
  importedWorkItemIds: string[];
  importedEvidenceIds: string[];
  importedAgentIds: string[];
  skipped: string[];
  createdAt: string;
}

export interface DecisionOption {
  optionId: string;
  title: string;
  description: string;
  estimatedTokens: number | null;
  estimatedSeconds: number | null;
  risk: "low" | "medium" | "high";
}

export interface DecisionRequest {
  decisionId: string;
  projectId: string;
  workItemId: string | null;
  trigger: DecisionTrigger;
  status: DecisionStatus;
  objective: string;
  currentState: string;
  architectureSummary: string;
  logicStack: string[];
  bottleneck: string;
  attempts: string[];
  affectedWorkItemIds: string[];
  options: DecisionOption[];
  recommendedOptionId: string;
  recommendationReason: string;
  selectedOptionId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface ProjectState {
  project: Project | null;
  workItems: Record<string, WorkItem>;
  dependencies: Record<string, Dependency>;
  agents: Record<string, AgentProfile>;
  runs: Record<string, AgentRun>;
  handoffs: Record<string, AgentHandoff>;
  workspaceLeases: Record<string, WorkspaceLease>;
  artifacts: Record<string, Artifact>;
  evidence: Record<string, Evidence>;
  budgetEntries: Record<string, BudgetEntry>;
  importReceipts: Record<string, LegacyImportReceipt>;
  decisions: Record<string, DecisionRequest>;
}

export function emptyProjectState(): ProjectState {
  return {
    project: null,
    workItems: {},
    dependencies: {},
    agents: {},
    runs: {},
    handoffs: {},
    workspaceLeases: {},
    artifacts: {},
    evidence: {},
    budgetEntries: {},
    importReceipts: {},
    decisions: {},
  };
}

export function defaultProjectPolicy(): ProjectPolicy {
  return {
    maxDecompositionDepth: 4,
    maxAgentDelegationDepth: 2,
    maxAttemptsPerStage: 3,
    maxReplanDepth: 2,
    requireIndependentReview: true,
    requireTestEvidence: true,
    autoMerge: true,
  };
}

export function defaultProjectBudgetPolicy(): ProjectBudgetPolicy {
  return {
    maxInputTokens: null,
    maxOutputTokens: null,
    maxCostUsd: null,
    maxWallClockSeconds: null,
  };
}

/** Adds fields introduced by later schema versions without rewriting history. */
export function upgradeProjectState(state: ProjectState): ProjectState {
  const next = structuredClone(state);
  next.workItems ??= {};
  for (const item of Object.values(next.workItems)) {
    item.codeScopes ??= ["."];
    item.origin ??= "native";
  }
  next.dependencies ??= {};
  next.agents ??= {};
  next.runs ??= {};
  for (const run of Object.values(next.runs)) run.mode ??= "batch";
  next.handoffs ??= {};
  for (const handoff of Object.values(next.handoffs)) {
    handoff.artifactReads ??= {};
    handoff.acknowledgedByRunId ??= null;
    handoff.acknowledgedAt ??= null;
  }
  next.workspaceLeases ??= {};
  next.artifacts ??= {};
  next.evidence ??= {};
  next.budgetEntries ??= {};
  next.importReceipts ??= {};
  next.decisions ??= {};
  if (next.project) {
    next.project.budget ??= defaultProjectBudgetPolicy();
    next.project.baseBranch ??= "main";
  }
  return next;
}
