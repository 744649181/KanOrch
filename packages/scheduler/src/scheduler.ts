import type {
  AgentProfile,
  FunctionalRole,
  ProjectState,
  WorkItem,
} from "../../domain/src/index.ts";
import { DomainRuleError, unsatisfiedDependencies } from "../../domain/src/index.ts";

export interface RouteDecision {
  workItemId: string;
  agentId: string;
  role: FunctionalRole;
  score: number;
  reasons: string[];
}

export class Scheduler {
  listRoutable(state: ProjectState, role: FunctionalRole): WorkItem[] {
    return Object.values(state.workItems)
      .filter((item) => item.ownStatus === "ready")
      .filter((item) => item.allowedRoles.length === 0 || item.allowedRoles.includes(role))
      .filter((item) => unsatisfiedDependencies(state, item.workItemId).length === 0)
      .sort((left, right) => {
        const depth = left.decompositionDepth - right.decompositionDepth;
        return depth !== 0 ? depth : left.workItemId.localeCompare(right.workItemId);
      });
  }

  route(state: ProjectState, workItemId: string, role: FunctionalRole): RouteDecision {
    const item = state.workItems[workItemId];
    if (!item) throw new DomainRuleError(`work item '${workItemId}' does not exist`);
    if (item.ownStatus !== "ready") throw new DomainRuleError(`work item '${workItemId}' is not ready`);
    const blocking = unsatisfiedDependencies(state, workItemId);
    if (blocking.length > 0) throw new DomainRuleError(`work item '${workItemId}' is blocked by ${blocking.join(", ")}`);
    if (item.allowedRoles.length > 0 && !item.allowedRoles.includes(role)) {
      throw new DomainRuleError(`work item '${workItemId}' does not allow role '${role}'`);
    }
    const candidates = Object.values(state.agents)
      .filter((agent) => agent.active)
      .filter((agent) => agent.roles.includes(role))
      .filter((agent) =>
        role !== "review" ||
        !state.project?.policy.requireIndependentReview ||
        !Object.values(state.runs).some(
          (run) =>
            run.workItemId === workItemId &&
            run.role === "implementation" &&
            run.status === "succeeded" &&
            run.agentId === agent.agentId,
        ),
      )
      .filter((agent) => item.requiredCapabilities.every((capability) => agent.capabilities.includes(capability)))
      .filter((agent) => activeRunCount(state, agent.agentId) < agent.maxConcurrentRuns)
      .map((agent) => scoreCandidate(state, item, agent, role))
      .sort((left, right) => right.score - left.score || left.agentId.localeCompare(right.agentId));
    const selected = candidates[0];
    if (!selected) {
      throw new DomainRuleError(
        `no active agent can route work item '${workItemId}' for role '${role}' within capability and concurrency constraints`,
      );
    }
    return selected;
  }
}

function activeRunCount(state: ProjectState, agentId: string): number {
  return Object.values(state.runs).filter(
    (run) => run.agentId === agentId && ["queued", "starting", "running", "waiting_approval"].includes(run.status),
  ).length;
}

function scoreCandidate(
  state: ProjectState,
  item: WorkItem,
  agent: AgentProfile,
  role: FunctionalRole,
): RouteDecision {
  const load = activeRunCount(state, agent.agentId);
  const costPenalty = agent.costPerMillionTokens === null ? 0 : Math.min(agent.costPerMillionTokens, 100) / 10;
  const capabilityHeadroom = agent.capabilities.filter(
    (capability) => !item.requiredCapabilities.includes(capability),
  ).length;
  const score = agent.reliability * 100 - load * 15 - costPenalty + Math.min(capabilityHeadroom, 5);
  return {
    workItemId: item.workItemId,
    agentId: agent.agentId,
    role,
    score,
    reasons: [
      `reliability=${agent.reliability.toFixed(3)}`,
      `activeRuns=${load}/${agent.maxConcurrentRuns}`,
      `requiredCapabilities=${item.requiredCapabilities.join(",") || "none"}`,
      `extraCapabilities=${capabilityHeadroom}`,
    ],
  };
}
