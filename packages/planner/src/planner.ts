import { DomainRuleError, type AddWorkItemInput } from "../../domain/src/index.ts";
import type { ProjectRepository } from "../../control-plane/src/index.ts";
import { Replanner } from "../../replanner/src/index.ts";
import {
  buildPlanningPrompt,
  buildPlanReviewPrompt,
  collectPlanningOutput,
  parseWorkGraphPlan,
} from "./plan-contract.ts";
import type { PlanProjectInput, PlanProjectResult, PlanningRunExecutor } from "./types.ts";

export const PLAN_ROOT_WORK_ITEM_ID = "STREW-PLAN";

export class DagPlanner {
  private readonly repository: ProjectRepository;
  private readonly runs: PlanningRunExecutor;
  private readonly replanner: Replanner;

  constructor(
    repository: ProjectRepository,
    runs: PlanningRunExecutor,
    replanner = new Replanner(),
  ) {
    this.repository = repository;
    this.runs = runs;
    this.replanner = replanner;
  }

  async planProject(input: PlanProjectInput): Promise<PlanProjectResult> {
    let current = this.repository.load(input.projectId);
    const project = current.state.project;
    if (!project) throw new DomainRuleError(`project '${input.projectId}' does not exist`);
    const nativeItems = Object.values(current.state.workItems).filter(
      (item) => item.origin === "native" && item.workItemId !== PLAN_ROOT_WORK_ITEM_ID,
    );
    if (nativeItems.length > 0) {
      throw new DomainRuleError("automatic DAG generation is available only before native work items are created");
    }
    requireIndependentPlanningCrew(current.state, input.agentId);

    const pending = pendingPlanningDecision(current.state);
    if (pending) return blockedResult(current, [], [], pending.decisionId);
    if (!current.state.workItems[PLAN_ROOT_WORK_ITEM_ID]) {
      const root: AddWorkItemInput = {
        workItemId: PLAN_ROOT_WORK_ITEM_ID,
        kind: "goal",
        title: `Plan: ${project.name}`,
        description: `Generate a validated delivery DAG for: ${project.goal}`,
        acceptanceCriteria: ["A complete machine-validated acyclic work graph is persisted atomically"],
        requiredCapabilities: [],
        allowedRoles: ["planning", "review"],
        codeScopes: [".strew-plan"],
      };
      const added = this.repository.addWorkItem(input.projectId, root, systemContext(current.revision, `planning-root:${current.revision}`));
      current = { revision: added.revision, state: added.state };
    }

    const attempts: string[] = [];
    const runIds: string[] = [];
    const attemptedPlannerIds = new Set<string>();
    for (let attempt = 1; attempt <= project.policy.maxAttemptsPerStage; attempt += 1) {
      current = this.repository.load(input.projectId);
      const decision = pendingPlanningDecision(current.state);
      if (decision) return blockedResult(current, runIds, attempts, decision.decisionId);
      if (current.state.workItems[PLAN_ROOT_WORK_ITEM_ID]?.ownStatus !== "ready") {
        const readied = this.repository.changeWorkItemStatus(
          input.projectId,
          PLAN_ROOT_WORK_ITEM_ID,
          "ready",
          systemContext(current.revision, `planning-ready:${attempt}:${current.revision}`),
        );
        current = { revision: readied.revision, state: readied.state };
      }
      const plannerAgentId = input.agentId ?? selectPlanningAgentId(current.state, attemptedPlannerIds);
      const execution = await this.runs.execute({
        projectId: input.projectId,
        workItemId: PLAN_ROOT_WORK_ITEM_ID,
        role: "planning",
        prompt: buildPlanningPrompt({
          goal: project.goal,
          maxDecompositionDepth: project.policy.maxDecompositionDepth,
          availableCapabilities: availableCapabilities(current.state),
          previousFailures: attempts,
        }),
        permissionMode: "workspace-auto",
        agentId: plannerAgentId,
        attempt,
      });
      runIds.push(execution.runId);
      attemptedPlannerIds.add(execution.agentId);
      if (execution.status !== "succeeded") {
        attempts.push(`attempt ${attempt}: planner run ${execution.runId} ended ${execution.status}; ${summarizeRunFailure(execution.events)}`);
      }
      current = this.repository.load(input.projectId);
      const runDecision = pendingPlanningDecision(current.state);
      if (runDecision) return blockedResult(current, runIds, attempts, runDecision.decisionId);
      if (execution.status !== "succeeded") continue;
      try {
        const plan = parseWorkGraphPlan(collectPlanningOutput(execution.events), project.policy);
        validateRoutingFeasibility(current.state, plan);
        const reviewer = selectReviewer(current.state, execution.agentId);
        const readyForReview = this.repository.changeWorkItemStatus(
          input.projectId,
          PLAN_ROOT_WORK_ITEM_ID,
          "ready",
          systemContext(current.revision, `planning-review-ready:${attempt}:${current.revision}`),
        );
        current = { revision: readyForReview.revision, state: readyForReview.state };
        const review = await this.runs.execute({
          projectId: input.projectId,
          workItemId: PLAN_ROOT_WORK_ITEM_ID,
          role: "review",
          prompt: buildPlanReviewPrompt(project.goal, plan),
          permissionMode: "workspace-auto",
          agentId: reviewer.agentId,
          attempt,
          subjectRunId: execution.runId,
        });
        runIds.push(review.runId);
        current = this.repository.load(input.projectId);
        const reviewDecision = pendingPlanningDecision(current.state);
        if (reviewDecision) return blockedResult(current, runIds, attempts, reviewDecision.decisionId);
        if (review.status !== "succeeded" || reviewVerdict(review.events) !== "passed") {
          attempts.push(`attempt ${attempt}: independent plan review by ${review.agentId} failed; ${summarizeOutput(review.events)}`);
          continue;
        }
        const applied = this.repository.applyPlannedWorkGraph(
          input.projectId,
          {
            planRootWorkItemId: PLAN_ROOT_WORK_ITEM_ID,
            workItems: plan.workItems.map((item) => ({
              ...item,
              allowedRoles: ["implementation", "review", "testing"],
            })),
            dependencies: plan.dependencies.map((dependency, index) => ({
              ...dependency,
              dependencyId: `plan-${execution.runId}-${index + 1}`,
            })),
          },
          { expectedRevision: current.revision, idempotencyKey: `planning-apply:${execution.runId}`, actorType: "agent", actorId: execution.agentId },
        );
        return {
          status: "planned",
          planRootWorkItemId: PLAN_ROOT_WORK_ITEM_ID,
          runIds,
          attempts,
          plan,
          decisionId: null,
          project: { revision: applied.revision, state: applied.state },
        };
      } catch (error) {
        attempts.push(`attempt ${attempt}: ${planningFailure(error)}`);
      }
    }

    current = this.repository.load(input.projectId);
    const existing = pendingPlanningDecision(current.state);
    if (existing) return blockedResult(current, runIds, attempts, existing.decisionId);
    const decision = this.replanner.buildDecision(current.state, {
      trigger: "retry_exhausted",
      workItemId: PLAN_ROOT_WORK_ITEM_ID,
      currentState: `Planning failed ${attempts.length} time(s); no valid DAG was persisted.`,
      bottleneck: "The planning agent could not produce a schema-valid, bounded, acyclic work graph.",
      attempts,
    });
    const paused = this.repository.requestDecisionAndPause(input.projectId, decision, systemContext(current.revision, `planning-decision:${decision.decisionId}`));
    return blockedResult({ revision: paused.revision, state: paused.state }, runIds, attempts, decision.decisionId);
  }
}

function requireIndependentPlanningCrew(
  state: ReturnType<ProjectRepository["load"]>["state"],
  requestedPlannerId?: string,
): void {
  const active = Object.values(state.agents).filter((agent) => agent.active);
  const planners = requestedPlannerId
    ? active.filter((agent) => agent.agentId === requestedPlannerId && agent.roles.includes("planning"))
    : active.filter((agent) => agent.roles.includes("planning"));
  if (planners.length === 0) throw new DomainRuleError("automatic DAG generation requires an active planning agent");
  if (!planners.some((planner) => active.some((agent) => agent.agentId !== planner.agentId && agent.roles.includes("review")))) {
    throw new DomainRuleError("automatic DAG generation requires a different active agent for independent plan review");
  }
}

function selectReviewer(
  state: ReturnType<ProjectRepository["load"]>["state"],
  plannerAgentId: string,
) {
  const reviewer = Object.values(state.agents)
    .filter((agent) => agent.active && agent.agentId !== plannerAgentId && agent.roles.includes("review"))
    .sort((left, right) => right.reliability - left.reliability || left.agentId.localeCompare(right.agentId))[0];
  if (!reviewer) throw new DomainRuleError("no independent plan reviewer is available");
  return reviewer;
}

function selectPlanningAgentId(
  state: ReturnType<ProjectRepository["load"]>["state"],
  attemptedPlannerIds: ReadonlySet<string>,
): string {
  const active = Object.values(state.agents).filter((agent) => agent.active);
  const candidates = active
    .filter((agent) => agent.roles.includes("planning"))
    .filter((planner) => active.some((reviewer) => reviewer.agentId !== planner.agentId && reviewer.roles.includes("review")))
    .filter((agent) => Object.values(state.runs).filter(
      (run) => run.agentId === agent.agentId && ["queued", "starting", "running", "waiting_approval"].includes(run.status),
    ).length < agent.maxConcurrentRuns)
    .sort((left, right) => right.reliability - left.reliability || left.agentId.localeCompare(right.agentId));
  const selected = candidates.find((agent) => !attemptedPlannerIds.has(agent.agentId)) ?? candidates[0];
  if (!selected) throw new DomainRuleError("no active planning agent is currently available");
  return selected.agentId;
}

function summarizeOutput(events: readonly { message?: string }[]): string {
  const output = collectPlanningOutput(events).replace(/\s+/g, " ").trim();
  return output ? output.slice(-1_000) : "reviewer returned no explanation";
}

function summarizeRunFailure(events: readonly { message?: string }[]): string {
  const output = collectPlanningOutput(events).replace(/\s+/g, " ").trim();
  return output ? output.slice(-1_000) : "planner returned no diagnostic output";
}

function reviewVerdict(events: readonly { message?: string }[]): "passed" | "failed" | "missing" {
  for (const message of events.map((event) => event.message ?? "").toReversed()) {
    if (/STREW_VERDICT\s*:\s*FAIL\b/i.test(message)) return "failed";
    if (/STREW_VERDICT\s*:\s*PASS\b/i.test(message)) return "passed";
  }
  return "missing";
}

function availableCapabilities(state: ReturnType<ProjectRepository["load"]>["state"]): string[] {
  return [...new Set(Object.values(state.agents).filter((agent) => agent.active).flatMap((agent) => agent.capabilities))].sort();
}

function validateRoutingFeasibility(
  state: ReturnType<ProjectRepository["load"]>["state"],
  plan: NonNullable<PlanProjectResult["plan"]>,
): void {
  const active = Object.values(state.agents).filter((agent) => agent.active);
  for (const item of plan.workItems) {
    const supports = (role: "implementation" | "review" | "testing") => active.filter(
      (agent) => agent.roles.includes(role) && item.requiredCapabilities.every((capability) => agent.capabilities.includes(capability)),
    );
    const implementers = supports("implementation");
    const reviewers = supports("review");
    const testers = supports("testing");
    if (implementers.length === 0 || testers.length === 0 || !implementers.some((implementer) => reviewers.some((reviewer) => reviewer.agentId !== implementer.agentId))) {
      throw new DomainRuleError(`work item '${item.workItemId}' cannot be routed to an implementation, independent review, and testing crew with capabilities: ${item.requiredCapabilities.join(", ") || "none"}`);
    }
  }
}

function planningFailure(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 2_000);
}

function pendingPlanningDecision(state: ReturnType<ProjectRepository["load"]>["state"]) {
  return Object.values(state.decisions).find(
    (decision) => decision.status === "pending" && (decision.workItemId === PLAN_ROOT_WORK_ITEM_ID || decision.affectedWorkItemIds.includes(PLAN_ROOT_WORK_ITEM_ID)),
  );
}

function blockedResult(
  project: ReturnType<ProjectRepository["load"]>,
  runIds: string[],
  attempts: string[],
  decisionId: string,
): PlanProjectResult {
  return { status: "blocked", planRootWorkItemId: PLAN_ROOT_WORK_ITEM_ID, runIds, attempts, plan: null, decisionId, project };
}

function systemContext(expectedRevision: number, idempotencyKey: string) {
  return { expectedRevision, idempotencyKey, actorType: "system" as const, actorId: "strew-planner" };
}
