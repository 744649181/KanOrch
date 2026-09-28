import type { ProjectState } from "../../domain/src/index.ts";
import { DomainRuleError } from "../../domain/src/index.ts";
import { evaluateQualityGates, type QualityGateReport } from "./quality-gates.ts";

export interface MergeRequest {
  workItemId: string;
  sourceBranch: string;
  targetBranch: string;
  expectedSourceCommit: string;
}

export interface MergeResult {
  commitSha: string;
  summary: string;
}

export interface MergeExecutor {
  merge(request: MergeRequest): Promise<MergeResult>;
}

export class MergeController {
  private readonly executor: MergeExecutor;

  constructor(executor: MergeExecutor) {
    this.executor = executor;
  }

  async mergeWhenAuthorized(state: ProjectState, request: MergeRequest): Promise<{ gateReport: QualityGateReport; result: MergeResult }> {
    const project = state.project;
    if (!project) throw new DomainRuleError("project has not been created");
    if (!project.policy.autoMerge) throw new MergeAuthorizationError("automatic merge is disabled by project policy");
    const sourceRun = Object.values(state.runs).find((run) =>
      run.workItemId === request.workItemId && run.role === "implementation" && run.status === "succeeded" &&
      run.branchName === request.sourceBranch,
    );
    if (!sourceRun) throw new MergeAuthorizationError("source branch has no successful implementation run for this work item");
    const gateReport = evaluateQualityGates(state, request.workItemId, sourceRun.runId);
    if (!gateReport.passed) {
      throw new MergeAuthorizationError(
        `merge is blocked by: ${gateReport.checks.filter((entry) => !entry.passed).map((entry) => entry.key).join(", ")}`,
        gateReport,
      );
    }
    return { gateReport, result: await this.executor.merge(request) };
  }
}

export class MergeAuthorizationError extends DomainRuleError {
  readonly gateReport: QualityGateReport | undefined;

  constructor(message: string, gateReport?: QualityGateReport) {
    super(message);
    this.name = "MergeAuthorizationError";
    this.gateReport = gateReport;
  }
}
