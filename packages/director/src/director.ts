import type { Artifact, FunctionalRole, ProjectState } from "../../domain/src/index.ts";
import { DomainRuleError } from "../../domain/src/index.ts";
import type {
  ExecuteAgentRunInput,
  ExecuteAgentRunResult,
} from "../../agent-runtime/src/index.ts";
import type { ProjectRepository } from "../../control-plane/src/index.ts";
import { LocalArtifactStore } from "../../artifact-store/src/index.ts";
import {
  GitMergeExecutor,
  MergeController,
  type MergeResult,
} from "../../quality-gates/src/index.ts";
import { Replanner, type ReplanSignal } from "../../replanner/src/index.ts";

export interface RunExecutor {
  execute(input: ExecuteAgentRunInput): Promise<ExecuteAgentRunResult>;
}

export interface DeliverWorkItemInput {
  projectId: string;
  workItemId: string;
  permissionMode?: ExecuteAgentRunInput["permissionMode"];
}

export interface DeliveryStageResult {
  role: FunctionalRole;
  run: ExecuteAgentRunResult;
}

export interface DeliveryResult {
  projectId: string;
  workItemId: string;
  status: "done" | "paused";
  stages: DeliveryStageResult[];
  merge: MergeResult | null;
  decisionId: string | null;
}

export interface DirectorOptions {
  repository: ProjectRepository;
  runs: RunExecutor;
  replanner?: Replanner;
}

export class Director {
  private readonly repository: ProjectRepository;
  private readonly runs: RunExecutor;
  private readonly replanner: Replanner;

  constructor(options: DirectorOptions) {
    this.repository = options.repository;
    this.runs = options.runs;
    this.replanner = options.replanner ?? new Replanner();
  }

  async deliverWorkItem(input: DeliverWorkItemInput): Promise<DeliveryResult> {
    const stages: DeliveryStageResult[] = [];
    const permissionMode = input.permissionMode ?? "workspace-auto";
    let current = this.repository.load(input.projectId);
    const project = current.state.project;
    const item = current.state.workItems[input.workItemId];
    if (!project || !item) throw new DomainRuleError("project and work item must exist before delivery");
    if (["done", "cancelled"].includes(item.ownStatus)) {
      throw new DomainRuleError(`work item '${item.workItemId}' is already ${item.ownStatus}`);
    }

    current = this.makeReady(input.projectId, input.workItemId, current);
    const implementation = await this.runStageWithRetries({
      projectId: input.projectId,
      workItemId: item.workItemId,
      role: "implementation",
      permissionMode,
      prompt: stagePrompt("implementation", current.state, item.workItemId),
    }, stages);
    if (implementation.status !== "succeeded") {
      return this.pauseForFailedStage(input, stages, implementation, "Implementation did not complete successfully.");
    }
    const implementationPause = await this.pauseForDetectedSignals(input, stages, implementation);
    if (implementationPause) return implementationPause;

    current = this.makeReady(input.projectId, input.workItemId, this.repository.load(input.projectId));
    const review = await this.runStageWithRetries({
      projectId: input.projectId,
      workItemId: item.workItemId,
      role: "review",
      permissionMode,
      baseRef: implementation.branchName,
      subjectRunId: implementation.runId,
      prompt: stagePrompt("review", current.state, item.workItemId),
    }, stages);
    if (review.status !== "succeeded") {
      return this.pauseForFailedStage(input, stages, review, "Independent review did not complete successfully.");
    }
    const reviewPause = await this.pauseForDetectedSignals(input, stages, review);
    if (reviewPause) return reviewPause;

    current = this.makeReady(input.projectId, input.workItemId, this.repository.load(input.projectId));
    const testing = await this.runStageWithRetries({
      projectId: input.projectId,
      workItemId: item.workItemId,
      role: "testing",
      permissionMode,
      baseRef: implementation.branchName,
      subjectRunId: implementation.runId,
      prompt: stagePrompt("testing", current.state, item.workItemId),
    }, stages);
    if (testing.status !== "succeeded") {
      return this.pauseForFailedStage(input, stages, testing, "Verification did not complete successfully.");
    }
    const testingPause = await this.pauseForDetectedSignals(input, stages, testing);
    if (testingPause) return testingPause;

    try {
      const merge = await this.integrateVerifiedWorkItem(input.projectId, input.workItemId, implementation.runId);
      return {
        projectId: input.projectId,
        workItemId: input.workItemId,
        status: "done",
        stages,
        merge,
        decisionId: null,
      };
    } catch (error) {
      return this.pauseForException(input, stages, error);
    }
  }

  async integrateVerifiedWorkItem(projectId: string, workItemId: string, implementationRunId: string): Promise<MergeResult> {
    let current = this.repository.load(projectId);
    const project = current.state.project;
    const item = current.state.workItems[workItemId];
    const run = current.state.runs[implementationRunId];
    if (!project || !item || !run || run.workItemId !== workItemId || run.role !== "implementation" || run.status !== "succeeded") {
      throw new DomainRuleError("integration requires a successful implementation run for this work item");
    }
    if (["done", "cancelled"].includes(item.ownStatus)) throw new DomainRuleError(`work item '${workItemId}' is already ${item.ownStatus}`);
    const evidence = Object.values(current.state.evidence).find((entry) =>
      entry.runId === implementationRunId && entry.kind === "implementation" && entry.verdict === "passed" && !entry.imported,
    );
    const artifact = evidence?.artifactIds.map((id) => current.state.artifacts[id]).find((entry) => entry?.kind === "commit");
    if (!artifact) throw new DomainRuleError("implementation commit artifact is missing");
    const expectedSourceCommit = (await new LocalArtifactStore(project.repositoryPath).read(artifact)).toString("utf8").split("\n")[0]?.trim() ?? "";
    const controller = new MergeController(new GitMergeExecutor({ repositoryPath: project.repositoryPath }));
    const merged = await controller.mergeWhenAuthorized(current.state, {
      workItemId,
      sourceBranch: run.branchName,
      targetBranch: project.baseBranch,
      expectedSourceCommit,
    });
    const mergeArtifact = await this.recordMergeArtifact(current.state, implementationRunId, merged.result);
    current = this.repository.load(projectId);
    this.repository.recordArtifact(projectId, mergeArtifact, systemContext(current.revision, `merge-artifact:${mergeArtifact.artifactId}`));
    current = this.repository.load(projectId);
    this.repository.completeWorkItem(projectId, workItemId, systemContext(current.revision, `complete:${workItemId}:${merged.result.commitSha}`));
    return merged.result;
  }

  private runStage(input: ExecuteAgentRunInput): Promise<ExecuteAgentRunResult> {
    return this.runs.execute(input);
  }

  private async runStageWithRetries(
    input: ExecuteAgentRunInput,
    stages: DeliveryStageResult[],
  ): Promise<ExecuteAgentRunResult> {
    const project = this.repository.load(input.projectId).state.project;
    if (!project) throw new DomainRuleError(`project '${input.projectId}' does not exist`);
    let last: ExecuteAgentRunResult | null = null;
    for (let attempt = 1; attempt <= project.policy.maxAttemptsPerStage; attempt += 1) {
      if (attempt > 1) {
        this.makeReady(input.projectId, input.workItemId, this.repository.load(input.projectId));
      }
      last = await this.runStage({ ...input, attempt });
      stages.push({ role: input.role, run: last });
      if (last.status === "succeeded" || last.status === "cancelled") return last;
    }
    if (!last) throw new DomainRuleError("stage retry policy allowed zero attempts");
    return last;
  }

  private makeReady(
    projectId: string,
    workItemId: string,
    current: { revision: number; state: ProjectState },
  ): { revision: number; state: ProjectState } {
    if (current.state.workItems[workItemId]?.ownStatus === "ready") return current;
    const result = this.repository.changeWorkItemStatus(
      projectId,
      workItemId,
      "ready",
      systemContext(current.revision, `director-ready:${workItemId}:${current.revision}`),
    );
    return { revision: result.revision, state: result.state };
  }

  private async pauseForFailedStage(
    input: DeliverWorkItemInput,
    stages: DeliveryStageResult[],
    run: ExecuteAgentRunResult,
    bottleneck: string,
  ): Promise<DeliveryResult> {
    return this.pauseWithSignal(input, stages, {
      trigger: "retry_exhausted",
      workItemId: input.workItemId,
      currentState: `Run ${run.runId} finished with status ${run.status}.`,
      bottleneck,
      attempts: stages.map((stage) => `${stage.role}: ${stage.run.runId} ${stage.run.status}`),
    });
  }

  private async pauseForDetectedSignals(
    input: DeliverWorkItemInput,
    stages: DeliveryStageResult[],
    run: ExecuteAgentRunResult,
  ): Promise<DeliveryResult | null> {
    const current = this.repository.load(input.projectId);
    const pending = Object.values(current.state.decisions).find(
      (decision) =>
        decision.status === "pending" &&
        (decision.workItemId === input.workItemId || decision.affectedWorkItemIds.includes(input.workItemId)),
    );
    if (pending) {
      return {
        projectId: input.projectId,
        workItemId: input.workItemId,
        status: "paused",
        stages,
        merge: null,
        decisionId: pending.decisionId,
      };
    }
    const signal = this.replanner.detectAutomatic(current.state, {
      workItemId: input.workItemId,
      runId: run.runId,
      runEvents: run.events,
      changedPaths: run.changes?.changedPaths,
    })[0];
    return signal ? this.pauseWithSignal(input, stages, signal) : null;
  }

  private async pauseForException(
    input: DeliverWorkItemInput,
    stages: DeliveryStageResult[],
    error: unknown,
  ): Promise<DeliveryResult> {
    return this.pauseWithSignal(input, stages, {
      trigger: "architecture_risk",
      workItemId: input.workItemId,
      currentState: `Automatic merge could not complete: ${errorMessage(error)}`,
      bottleneck: "The verified implementation cannot be merged safely under current repository state.",
      attempts: stages.map((stage) => `${stage.role}: ${stage.run.runId} ${stage.run.status}`),
    });
  }

  private async pauseWithSignal(
    input: DeliverWorkItemInput,
    stages: DeliveryStageResult[],
    signal: ReplanSignal,
  ): Promise<DeliveryResult> {
    const current = this.repository.load(input.projectId);
    const decision = this.replanner.buildDecision(current.state, {
      ...signal,
      workItemId: input.workItemId,
    });
    this.repository.requestDecisionAndPause(
      input.projectId,
      decision,
      systemContext(current.revision, `director-decision:${decision.decisionId}`),
    );
    return {
      projectId: input.projectId,
      workItemId: input.workItemId,
      status: "paused",
      stages,
      merge: null,
      decisionId: decision.decisionId,
    };
  }

  private async recordMergeArtifact(
    state: ProjectState,
    implementationRunId: string,
    merge: MergeResult,
  ): Promise<Artifact> {
    const project = state.project;
    const run = state.runs[implementationRunId];
    if (!project || !run) throw new DomainRuleError("merge artifact requires project and implementation run");
    return new LocalArtifactStore(project.repositoryPath).write({
      projectId: project.projectId,
      workItemId: run.workItemId,
      runId: run.runId,
      kind: "commit",
      content: `${merge.commitSha}\n${merge.summary}\n`,
      mediaType: "text/plain",
      extension: "txt",
    });
  }
}

function stagePrompt(role: "implementation" | "review" | "testing", state: ProjectState, workItemId: string): string {
  const item = state.workItems[workItemId];
  if (!item) throw new DomainRuleError(`work item '${workItemId}' does not exist`);
  const common = [
    `[${role}] Work item ${item.workItemId}: ${item.title}`,
    item.description,
    "Acceptance criteria:",
    ...item.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    `Code scopes: ${item.codeScopes.join(", ")}`,
  ];
  if (role === "implementation") {
    common.push("Implement the change, run relevant checks, and leave only intended files changed. Strew will create the commit; do not merge branches.");
  } else if (role === "review") {
    common.push("Independently review the implementation against every acceptance criterion. Do not modify files. End the final response with exactly STREW_VERDICT: PASS when no blocking issue exists, otherwise STREW_VERDICT: FAIL.");
  } else {
    common.push("Run the relevant automated tests and verification commands. Do not modify files. End the final response with exactly STREW_VERDICT: PASS only when every required check passes, otherwise STREW_VERDICT: FAIL.");
  }
  return common.join("\n");
}

function systemContext(expectedRevision: number, idempotencyKey: string) {
  return {
    expectedRevision,
    idempotencyKey,
    actorType: "system" as const,
    actorId: "strew-director",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
