import type {
  DecisionOption,
  DecisionRequest,
  DecisionTrigger,
  DomainEvent,
  ProjectState,
} from "../../domain/src/index.ts";
import type { PersistedRunEvent } from "../../agent-protocol/src/index.ts";
import { DomainRuleError } from "../../domain/src/index.ts";

export interface ReplanSignal {
  trigger: DecisionTrigger;
  workItemId: string | null;
  currentState: string;
  bottleneck: string;
  architectureSummary?: string;
  logicStack?: string[];
  attempts?: string[];
  affectedWorkItemIds?: string[];
}

export interface AutomaticRunSituation {
  workItemId: string;
  runId: string;
  runEvents: readonly PersistedRunEvent[];
  changedPaths?: readonly string[];
}

export class Replanner {
  detectAutomatic(state: ProjectState, situation: AutomaticRunSituation): ReplanSignal[] {
    const project = requireProject(state);
    const run = state.runs[situation.runId];
    const item = state.workItems[situation.workItemId];
    if (!run || !item) throw new DomainRuleError("automatic replanning requires a persisted run and work item");
    const signals: ReplanSignal[] = [];
    const outsideScopes = ["implementation", "integration"].includes(run.role)
      ? (situation.changedPaths ?? []).filter((path) => !isWithinScopes(path, item.codeScopes))
      : [];
    if (outsideScopes.length > 0) {
      signals.push({
        trigger: "goal_drift",
        workItemId: item.workItemId,
        currentState: `Run ${run.runId} changed paths outside its declared code scopes: ${outsideScopes.join(", ")}.`,
        bottleneck: "The implementation's change surface no longer matches the planned ownership boundary.",
        attempts: [`${run.runId}: declared ${item.codeScopes.join(", ")}; observed ${outsideScopes.join(", ")}`],
      });
    }
    const retryWindowStartedAt = latestResolvedRetryDecisionAt(state, item.workItemId);
    const attempts = Object.values(state.runs)
      .filter((candidate) => candidate.workItemId === item.workItemId && candidate.role === run.role)
      .filter((candidate) => candidate.status === "failed")
      .filter((candidate) => !retryWindowStartedAt || (candidate.finishedAt ?? candidate.startedAt ?? "") > retryWindowStartedAt)
      .sort((left, right) => left.attempt - right.attempt);
    if (run.status === "failed" && attempts.length >= project.policy.maxAttemptsPerStage) {
      signals.push({
        trigger: "retry_exhausted",
        workItemId: item.workItemId,
        currentState: `${run.role} failed ${attempts.length} time(s); the configured limit is ${project.policy.maxAttemptsPerStage}.`,
        bottleneck: `The ${run.role} stage has exhausted its retry budget.`,
        attempts: attempts.map((candidate) => `${candidate.runId}: attempt ${candidate.attempt} failed with ${candidate.agentId}`),
      });
    }
    if (situation.runEvents.some((event) => event.type === "approval.requested")) {
      signals.push({
        trigger: "permission_escalation",
        workItemId: item.workItemId,
        currentState: `Run ${run.runId} requested a permission outside its current automatic policy.`,
        bottleneck: "The agent cannot continue without a recorded permission decision.",
        attempts: [`${run.runId}: permission request observed in the normalized run stream`],
      });
    }
    const overBudget = projectBudgetFailures(state);
    if (overBudget.length > 0) {
      signals.push({
        trigger: "budget_exceeded",
        workItemId: item.workItemId,
        currentState: overBudget.join("; "),
        bottleneck: "Recorded usage exceeds the project budget policy.",
        attempts: [`${run.runId}: usage was persisted before the budget check`],
      });
    }
    return signals.filter((signal) => !hasPendingEquivalent(state, signal));
  }

  buildDecision(state: ProjectState, signal: ReplanSignal): DecisionRequest {
    const project = requireProject(state);
    if (signal.workItemId && !state.workItems[signal.workItemId]) {
      throw new DomainRuleError(`replan work item '${signal.workItemId}' does not exist`);
    }
    const affected = expandAffectedSubgraph(
      state,
      signal.affectedWorkItemIds ?? (signal.workItemId ? [signal.workItemId] : []),
    );
    const options = optionsFor(signal.trigger);
    const item = signal.workItemId ? state.workItems[signal.workItemId] : null;
    const runs = signal.workItemId
      ? Object.values(state.runs).filter((run) => run.workItemId === signal.workItemId)
      : [];
    return {
      decisionId: globalThis.crypto.randomUUID(),
      projectId: project.projectId,
      workItemId: signal.workItemId,
      trigger: signal.trigger,
      status: "pending",
      objective: project.goal,
      currentState: signal.currentState,
      architectureSummary:
        signal.architectureSummary ??
        `Project ${project.name} uses a dependency-driven AgentRun pipeline with isolated Git worktrees and evidence gates.`,
      logicStack:
        signal.logicStack ??
        [
          ...(item?.requiredCapabilities ?? []),
          ...(item?.codeScopes.map((scope) => `scope:${scope}`) ?? []),
          ...runs.map((run) => `${run.role}:${run.agentId}:${run.status}`),
        ],
      bottleneck: signal.bottleneck,
      attempts: signal.attempts ?? runs.map((run) => `${run.runId}: ${run.role} ${run.status}, attempt ${run.attempt}`),
      affectedWorkItemIds: affected,
      options,
      recommendedOptionId: options[0]?.optionId ?? "pause",
      recommendationReason: recommendationFor(signal.trigger),
      selectedOptionId: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
  }
}

function latestResolvedRetryDecisionAt(state: ProjectState, workItemId: string): string | null {
  return Object.values(state.decisions)
    .filter((decision) => decision.trigger === "retry_exhausted" && decision.status === "resolved")
    .filter((decision) => decision.workItemId === workItemId || decision.affectedWorkItemIds.includes(workItemId))
    .map((decision) => decision.resolvedAt)
    .filter((resolvedAt): resolvedAt is string => Boolean(resolvedAt))
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
}

export function decisionPauseEvents(state: ProjectState, decision: DecisionRequest): DomainEvent[] {
  const events: DomainEvent[] = [];
  for (const workItemId of decision.affectedWorkItemIds) {
    const item = state.workItems[workItemId];
    if (item && !["blocked", "done", "cancelled"].includes(item.ownStatus)) {
      events.push({ eventType: "work_item.status_changed", payload: { workItemId, status: "blocked" } });
    }
  }
  events.push({ eventType: "decision.requested", payload: { decision } });
  return events;
}

export function expandAffectedSubgraph(state: ProjectState, roots: readonly string[]): string[] {
  const affected = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    for (const dependency of Object.values(state.dependencies)) {
      if (dependency.kind === "conflicts_with" || dependency.upstreamWorkItemId !== current) continue;
      if (!affected.has(dependency.downstreamWorkItemId)) {
        affected.add(dependency.downstreamWorkItemId);
        queue.push(dependency.downstreamWorkItemId);
      }
    }
  }
  return [...affected].filter((workItemId) => Boolean(state.workItems[workItemId])).sort();
}

function projectBudgetFailures(state: ProjectState): string[] {
  const project = requireProject(state);
  const entries = Object.values(state.budgetEntries);
  const actual = entries.reduce(
    (total, entry) => {
      const direction = entry.kind === "release" ? -1 : 1;
      total.inputTokens += direction * entry.inputTokens;
      total.outputTokens += direction * entry.outputTokens;
      total.costUsd += direction * entry.costUsd;
      total.wallClockSeconds += direction * entry.wallClockSeconds;
      return total;
    },
    { inputTokens: 0, outputTokens: 0, costUsd: 0, wallClockSeconds: 0 },
  );
  const failures: string[] = [];
  if (project.budget.maxInputTokens !== null && actual.inputTokens > project.budget.maxInputTokens) failures.push(`input tokens ${actual.inputTokens} exceed ${project.budget.maxInputTokens}`);
  if (project.budget.maxOutputTokens !== null && actual.outputTokens > project.budget.maxOutputTokens) failures.push(`output tokens ${actual.outputTokens} exceed ${project.budget.maxOutputTokens}`);
  if (project.budget.maxCostUsd !== null && actual.costUsd > project.budget.maxCostUsd) failures.push(`cost $${actual.costUsd.toFixed(4)} exceeds $${project.budget.maxCostUsd.toFixed(4)}`);
  if (project.budget.maxWallClockSeconds !== null && actual.wallClockSeconds > project.budget.maxWallClockSeconds) failures.push(`wall time ${actual.wallClockSeconds.toFixed(1)}s exceeds ${project.budget.maxWallClockSeconds}s`);
  return failures;
}

function hasPendingEquivalent(state: ProjectState, signal: ReplanSignal): boolean {
  return Object.values(state.decisions).some(
    (decision) =>
      decision.status === "pending" &&
      decision.trigger === signal.trigger &&
      decision.workItemId === signal.workItemId,
  );
}

function isWithinScopes(path: string, scopes: readonly string[]): boolean {
  const normalize = (value: string) => {
    const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const normalizedPath = normalize(path);
  return scopes.some((scope) => {
    const normalizedScope = normalize(scope) || ".";
    return normalizedScope === "." || normalizedPath === normalizedScope || normalizedPath.startsWith(`${normalizedScope}/`);
  });
}

function optionsFor(trigger: DecisionTrigger): DecisionOption[] {
  const definitions: Record<DecisionTrigger, Array<[string, string, string, DecisionOption["risk"]]>> = {
    retry_exhausted: [
      ["replan", "Replan the affected subgraph", "Keep the objective and replace the failed technical approach.", "medium"],
      ["switch-agent", "Switch agent/profile", "Retry with a different capability and reliability profile.", "medium"],
      ["pause", "Pause affected work", "Preserve evidence and wait for manual technical direction.", "low"],
    ],
    budget_exceeded: [
      ["reduce-scope", "Reduce execution scope", "Keep the budget fixed and replan only the essential acceptance criteria.", "medium"],
      ["increase-budget", "Increase project budget", "Authorize an explicit budget expansion before more execution.", "medium"],
      ["pause", "Pause affected work", "Stop spending while retaining all current artifacts.", "low"],
    ],
    permission_escalation: [
      ["sandbox-alternative", "Use a sandboxed alternative", "Replan the operation so it stays inside current permissions.", "low"],
      ["approve-once", "Approve once", "Grant the exact requested operation for one recorded run.", "high"],
      ["pause", "Pause affected work", "Do not grant additional permissions.", "low"],
    ],
    goal_drift: [
      ["realign", "Realign implementation", "Discard the divergent approach and restore the recorded objective.", "medium"],
      ["revise-goal", "Revise goal explicitly", "Accept the new direction by changing objective and acceptance criteria.", "high"],
      ["pause", "Pause affected work", "Inspect architecture and evidence before choosing a direction.", "low"],
    ],
    workspace_conflict: [
      ["serialize", "Serialize the conflicting runs", "Keep code scopes and execute one writer at a time.", "low"],
      ["narrow-scopes", "Narrow code scopes", "Split ownership where files can be changed independently.", "medium"],
      ["cancel-run", "Cancel one run", "Release one lease and preserve the other run.", "medium"],
    ],
    architecture_risk: [
      ["technical-spike", "Run a bounded technical spike", "Gather evidence before committing to the risky architecture.", "low"],
      ["redesign", "Redesign the affected layer", "Replace the architecture before further implementation.", "medium"],
      ["accept-risk", "Accept the documented risk", "Continue with explicit user authorization and audit trail.", "high"],
    ],
  };
  return definitions[trigger].map(([optionId, title, description, risk]) => ({
    optionId,
    title,
    description,
    estimatedTokens: null,
    estimatedSeconds: null,
    risk,
  }));
}

function recommendationFor(trigger: DecisionTrigger): string {
  const reasons: Record<DecisionTrigger, string> = {
    retry_exhausted: "Replanning preserves the objective while breaking the repeated-failure loop.",
    budget_exceeded: "Reducing scope stops unapproved spending and keeps the highest-value acceptance criteria.",
    permission_escalation: "A sandboxed alternative minimizes authority while allowing progress where possible.",
    goal_drift: "Realignment protects the recorded objective from silent scope drift.",
    workspace_conflict: "Serial execution is the lowest-risk way to preserve single-writer ownership.",
    architecture_risk: "A bounded spike gathers evidence before an irreversible design commitment.",
  };
  return reasons[trigger];
}

function requireProject(state: ProjectState): NonNullable<ProjectState["project"]> {
  if (!state.project) throw new DomainRuleError("project has not been created");
  return state.project;
}
