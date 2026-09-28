import type {
  BudgetEntry,
  Evidence,
  ProjectState,
} from "../../domain/src/index.ts";
import {
  decideChangeWorkItemStatus,
  DomainRuleError,
  unsatisfiedDependencies,
  type DomainEvent,
} from "../../domain/src/index.ts";

export type QualityGateKey =
  | "dependencies"
  | "implementation"
  | "independent_review"
  | "tests"
  | "budget"
  | "workspace"
  | "decisions";

export interface QualityGateCheck {
  key: QualityGateKey;
  passed: boolean;
  summary: string;
  evidenceIds: string[];
}

export interface QualityGateReport {
  projectId: string;
  workItemId: string;
  checks: QualityGateCheck[];
  passed: boolean;
  evaluatedAt: string;
}

export interface BudgetTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  wallClockSeconds: number;
}

export function evaluateQualityGates(state: ProjectState, workItemId: string, implementationRunId?: string): QualityGateReport {
  const project = state.project;
  if (!project) throw new DomainRuleError("project has not been created");
  if (!state.workItems[workItemId]) throw new DomainRuleError(`work item '${workItemId}' does not exist`);
  const workEvidence = Object.values(state.evidence).filter(
    (entry) => entry.workItemId === workItemId && !entry.imported,
  );
  const implementationRuns = Object.values(state.runs).filter(
    (run) => run.workItemId === workItemId && run.role === "implementation" && run.status === "succeeded",
  );
  const evidenceFor = (runId: string) => {
    const implementation = passingEvidence(workEvidence, "implementation").filter((entry) => entry.runId === runId);
    const review = passingEvidence(workEvidence, "review").filter((entry) => {
      const reviewer = state.runs[entry.runId];
      return entry.subjectRunId === runId && reviewer?.role === "review" && reviewer.status === "succeeded" &&
        reviewer.agentId !== state.runs[runId]?.agentId;
    });
    const test = passingEvidence(workEvidence, "test").filter((entry) =>
      entry.subjectRunId === runId && state.runs[entry.runId]?.role === "testing" && state.runs[entry.runId]?.status === "succeeded",
    );
    return { implementation, review, test };
  };
  const completeRun = implementationRuns.find((run) => {
    if (implementationRunId && run.runId !== implementationRunId) return false;
    const evidence = evidenceFor(run.runId);
    return evidence.implementation.length > 0 &&
      (!project.policy.requireIndependentReview || evidence.review.length > 0) &&
      (!project.policy.requireTestEvidence || evidence.test.length > 0);
  });
  const candidate = completeRun ?? implementationRuns.find((run) => run.runId === implementationRunId) ??
    (implementationRunId ? undefined : implementationRuns.at(-1));
  const { implementation: implementationEvidence, review: reviewEvidence, test: testEvidence } = candidate
    ? evidenceFor(candidate.runId)
    : { implementation: [], review: [], test: [] };
  const blocking = unsatisfiedDependencies(state, workItemId);
  const activeLeases = Object.values(state.workspaceLeases).filter(
    (lease) => lease.workItemId === workItemId && lease.status === "active",
  );
  const pendingDecisions = Object.values(state.decisions).filter(
    (decision) =>
      decision.status === "pending" &&
      (decision.workItemId === workItemId || decision.affectedWorkItemIds.includes(workItemId)),
  );
  const totals = calculateBudgetTotals(
    Object.values(state.budgetEntries).filter((entry) => entry.workItemId === workItemId),
  );
  const budgetFailures = budgetExceeded(project.budget, totals);

  const checks: QualityGateCheck[] = [
    check("dependencies", blocking.length === 0, blocking.length ? `Blocked by ${blocking.join(", ")}` : "All dependencies are done"),
    check(
      "implementation",
      implementationEvidence.length > 0,
      implementationEvidence.length ? "Passing implementation evidence exists" : "Passing implementation evidence is missing",
      implementationEvidence,
    ),
    check(
      "independent_review",
      !project.policy.requireIndependentReview || reviewEvidence.length > 0,
      !project.policy.requireIndependentReview
        ? "Independent review is disabled by policy"
        : reviewEvidence.length
          ? "Independent passing review exists"
          : "Independent passing review is missing",
      reviewEvidence,
    ),
    check(
      "tests",
      !project.policy.requireTestEvidence || testEvidence.length > 0,
      !project.policy.requireTestEvidence
        ? "Test evidence is disabled by policy"
        : testEvidence.length
          ? "Passing test evidence exists"
          : "Passing test evidence is missing",
      testEvidence,
    ),
    check("budget", budgetFailures.length === 0, budgetFailures.length ? budgetFailures.join("; ") : "Budget is within policy"),
    check("workspace", activeLeases.length === 0, activeLeases.length ? `${activeLeases.length} workspace lease(s) remain active` : "No active workspace lease remains"),
    check("decisions", pendingDecisions.length === 0, pendingDecisions.length ? `${pendingDecisions.length} decision(s) await the user` : "No pending decision blocks this work"),
  ];
  return {
    projectId: project.projectId,
    workItemId,
    checks,
    passed: checks.every((entry) => entry.passed),
    evaluatedAt: new Date().toISOString(),
  };
}

export function decideCompleteWorkItem(state: ProjectState, workItemId: string): DomainEvent {
  const report = evaluateQualityGates(state, workItemId);
  const failed = report.checks.filter((entry) => !entry.passed);
  if (failed.length > 0) {
    throw new QualityGateError(workItemId, failed);
  }
  return decideChangeWorkItemStatus(state, workItemId, "done");
}

export function calculateBudgetTotals(entries: readonly BudgetEntry[]): BudgetTotals {
  const totals: BudgetTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0, wallClockSeconds: 0 };
  for (const entry of entries) {
    const direction = entry.kind === "release" ? -1 : 1;
    totals.inputTokens += direction * entry.inputTokens;
    totals.outputTokens += direction * entry.outputTokens;
    totals.costUsd += direction * entry.costUsd;
    totals.wallClockSeconds += direction * entry.wallClockSeconds;
  }
  for (const key of Object.keys(totals) as Array<keyof BudgetTotals>) totals[key] = Math.max(0, totals[key]);
  return totals;
}

export class QualityGateError extends DomainRuleError {
  readonly workItemId: string;
  readonly failedChecks: QualityGateCheck[];

  constructor(workItemId: string, failedChecks: QualityGateCheck[]) {
    super(`work item '${workItemId}' failed quality gates: ${failedChecks.map((entry) => entry.key).join(", ")}`);
    this.name = "QualityGateError";
    this.workItemId = workItemId;
    this.failedChecks = failedChecks;
  }
}

function passingEvidence(evidence: readonly Evidence[], kind: Evidence["kind"]): Evidence[] {
  return evidence.filter((entry) => entry.kind === kind && entry.verdict === "passed");
}

function check(
  key: QualityGateKey,
  passed: boolean,
  summary: string,
  evidence: readonly Evidence[] = [],
): QualityGateCheck {
  return { key, passed, summary, evidenceIds: evidence.map((entry) => entry.evidenceId).sort() };
}

function budgetExceeded(
  policy: NonNullable<ProjectState["project"]>["budget"],
  totals: BudgetTotals,
): string[] {
  const failures: string[] = [];
  if (policy.maxInputTokens !== null && totals.inputTokens > policy.maxInputTokens) failures.push(`input tokens ${totals.inputTokens} exceed ${policy.maxInputTokens}`);
  if (policy.maxOutputTokens !== null && totals.outputTokens > policy.maxOutputTokens) failures.push(`output tokens ${totals.outputTokens} exceed ${policy.maxOutputTokens}`);
  if (policy.maxCostUsd !== null && totals.costUsd > policy.maxCostUsd) failures.push(`cost $${totals.costUsd.toFixed(4)} exceeds $${policy.maxCostUsd.toFixed(4)}`);
  if (policy.maxWallClockSeconds !== null && totals.wallClockSeconds > policy.maxWallClockSeconds) failures.push(`wall time ${totals.wallClockSeconds}s exceeds ${policy.maxWallClockSeconds}s`);
  return failures;
}
