import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type {
  AddDependencyInput,
  AddWorkItemInput,
  AgentProfile,
  AgentAdapterKind,
  CreateProjectInput,
  FunctionalRole,
  ProjectState,
  RecordAgentHandoffInput,
  StoredEvent,
  WorkItemStatus,
} from "../../../packages/domain/src/index.ts";
import { DomainRuleError } from "../../../packages/domain/src/index.ts";
import { createDefaultAdapterRegistry } from "../../../packages/adapters/src/index.ts";
import {
  RunCoordinator,
  AgentInbox,
  type ExecuteAgentRunInput,
  type ExecuteAgentRunResult,
} from "../../../packages/agent-runtime/src/index.ts";
import { LocalArtifactStore } from "../../../packages/artifact-store/src/index.ts";
import {
  ProjectRepository,
  type CommandContext,
  type CommandResult,
} from "../../../packages/control-plane/src/index.ts";
import { SqliteEventStore } from "../../../packages/event-store/src/index.ts";
import { evaluateQualityGates, type QualityGateReport } from "../../../packages/quality-gates/src/index.ts";
import { Replanner } from "../../../packages/replanner/src/index.ts";
import { Director, type DeliveryResult } from "../../../packages/director/src/index.ts";
import {
  DagPlanner,
  type PlanProjectResult,
  type PlanningRunExecutor,
} from "../../../packages/planner/src/index.ts";
import { ensureProjectRepository } from "./repository-preflight.ts";
import { TerminalSessions, type StartTerminalInput, type TerminalView } from "./terminal-sessions.ts";

export interface StrewApplicationOptions {
  planningRuns?: PlanningRunExecutor;
  terminalLaunch?: (kind: AgentAdapterKind) => { executable: string; args: string[] };
}

export class StrewApplication {
  readonly store: SqliteEventStore;
  readonly projects: ProjectRepository;
  readonly adapters = createDefaultAdapterRegistry();
  readonly runs: RunCoordinator;
  readonly inbox: AgentInbox;
  readonly terminals: TerminalSessions;
  readonly replanner = new Replanner();
  readonly director: Director;
  readonly planner: DagPlanner;
  private readonly events = new EventEmitter();
  private readonly activeBatchRuns = new Map<string, AbortController>();
  private isClosed = false;

  constructor(databasePath: string, options: StrewApplicationOptions = {}) {
    this.store = new SqliteEventStore(databasePath);
    this.events.setMaxListeners(100);
    const publish = (events: StoredEvent[]) => this.events.emit("events", events);
    this.projects = new ProjectRepository(this.store, publish);
    this.inbox = new AgentInbox(this.projects);
    this.terminals = new TerminalSessions(this.projects, this.adapters, options.terminalLaunch, publish, this.inbox);
    this.runs = new RunCoordinator({
      repository: this.projects,
      adapters: this.adapters,
      onStoredEvents: publish,
      inbox: this.inbox,
    });
    this.director = new Director({
      repository: this.projects,
      runs: { execute: (input) => this.executeAgentRun(input) },
      replanner: this.replanner,
    });
    const planningRuns = options.planningRuns ?? {
        execute: async (input) => {
          const result = await this.executeAgentRun(input);
          return {
            runId: result.runId,
            agentId: result.agentId,
            status: result.status,
            events: result.events,
          };
        },
      };
    this.planner = new DagPlanner(
      this.projects,
      planningRuns,
      this.replanner,
    );
    this.recoverInterruptedRuns();
  }

  listProjects(): Array<{ revision: number; state: ProjectState }> {
    return this.store
      .listSnapshots<ProjectState>("project")
      .map((snapshot) => this.projects.load(snapshot.streamId.replace(/^project:/, "")));
  }

  getProject(projectId: string): { revision: number; state: ProjectState } | null {
    const project = this.projects.load(projectId);
    return project.state.project ? project : null;
  }

  createProject(input: CreateProjectInput, context: CommandContext): CommandResult {
    return this.projects.createProject(input, context);
  }

  async createLocalProject(input: CreateProjectInput, context: CommandContext): Promise<CommandResult> {
    if (this.getProject(input.projectId)) {
      throw new DomainRuleError(`project '${input.projectId}' already exists`);
    }
    await ensureProjectRepository(input.repositoryPath, input.baseBranch ?? "main");
    return this.projects.createProject(input, context);
  }

  addWorkItem(projectId: string, input: AddWorkItemInput, context: CommandContext): CommandResult {
    return this.projects.addWorkItem(projectId, input, context);
  }

  setWorkItemRoles(projectId: string, workItemId: string, allowedRoles: FunctionalRole[], context: CommandContext): CommandResult {
    return this.projects.setWorkItemRoles(projectId, workItemId, allowedRoles, context);
  }

  addDependency(projectId: string, input: AddDependencyInput, context: CommandContext): CommandResult {
    return this.projects.addDependency(projectId, input, context);
  }

  recordAgentHandoff(
    projectId: string,
    input: RecordAgentHandoffInput,
    context: CommandContext,
  ): CommandResult {
    return this.projects.recordAgentHandoff(projectId, input, context);
  }

  registerAgent(projectId: string, agent: AgentProfile, context: CommandContext): CommandResult {
    return this.projects.registerAgent(projectId, agent, context);
  }

  startTerminal(input: StartTerminalInput, context: CommandContext): Promise<TerminalView> {
    return this.terminals.start(input, context);
  }

  changeWorkItemStatus(
    projectId: string,
    workItemId: string,
    status: WorkItemStatus,
    context: CommandContext,
  ): CommandResult {
    return this.projects.changeWorkItemStatus(projectId, workItemId, status, context);
  }

  resolveDecision(
    projectId: string,
    decisionId: string,
    selectedOptionId: string,
    context: CommandContext,
  ): CommandResult {
    return this.projects.resolveDecision(projectId, decisionId, selectedOptionId, context);
  }

  async executeAgentRun(input: ExecuteAgentRunInput): Promise<ExecuteAgentRunResult> {
    const runId = input.runId ?? randomUUID();
    const key = `${input.projectId}\0${runId}`;
    if (this.activeBatchRuns.has(key)) throw new DomainRuleError(`run '${runId}' is already active`);
    const controller = new AbortController();
    this.activeBatchRuns.set(key, controller);
    try {
      return await this.executeTrackedAgentRun({
        ...input,
        runId,
        signal: input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal,
      });
    } finally {
      this.activeBatchRuns.delete(key);
    }
  }

  cancelAgentRun(projectId: string, runId: string): void {
    const controller = this.activeBatchRuns.get(`${projectId}\0${runId}`);
    if (!controller) throw new DomainRuleError(`batch run '${runId}' is not active in project '${projectId}'`);
    controller.abort(new Error("cancelled by local owner"));
  }

  cancelAllBatchRuns(): void {
    for (const controller of this.activeBatchRuns.values()) controller.abort(new Error("runtime shutting down"));
  }

  private async executeTrackedAgentRun(input: ExecuteAgentRunInput): Promise<ExecuteAgentRunResult> {
    let result: ExecuteAgentRunResult;
    try {
      result = await this.runs.execute(input);
    } catch (error) {
      if (error instanceof Error && error.message.includes("workspace lease conflicts")) {
        const current = this.projects.load(input.projectId);
        const decision = this.replanner.buildDecision(current.state, {
          trigger: "workspace_conflict",
          workItemId: input.workItemId,
          currentState: error.message,
          bottleneck: "Two AgentRuns requested overlapping single-writer code scopes.",
          attempts: [`${input.role}: workspace lease acquisition was rejected before execution`],
        });
        this.projects.requestDecisionAndPause(input.projectId, decision, {
          expectedRevision: current.revision,
          idempotencyKey: `workspace-conflict:${decision.decisionId}`,
          actorType: "system",
          actorId: "strew-scheduler",
        });
      }
      throw error;
    }
    let current = this.projects.load(input.projectId);
    const signals = this.replanner.detectAutomatic(current.state, {
      workItemId: input.workItemId,
      runId: result.runId,
      runEvents: result.events,
      changedPaths: result.changes?.changedPaths,
    });
    for (const signal of signals) {
      const decision = this.replanner.buildDecision(current.state, signal);
      const updated = this.projects.requestDecisionAndPause(input.projectId, decision, {
        expectedRevision: current.revision,
        idempotencyKey: `replan:${decision.decisionId}`,
        actorType: "system",
        actorId: "strew-replanner",
      });
      current = { revision: updated.revision, state: updated.state };
    }
    return result;
  }

  deliverWorkItem(projectId: string, workItemId: string): Promise<DeliveryResult> {
    return this.director.deliverWorkItem({ projectId, workItemId });
  }

  integrateVerifiedWorkItem(projectId: string, workItemId: string, implementationRunId: string) {
    return this.director.integrateVerifiedWorkItem(projectId, workItemId, implementationRunId);
  }

  async planProject(projectId: string, agentId?: string): Promise<PlanProjectResult> {
    const current = this.getProject(projectId);
    const project = current?.state.project;
    if (!project) throw new DomainRuleError(`project '${projectId}' does not exist`);
    await ensureProjectRepository(project.repositoryPath, project.baseBranch);
    return this.planner.planProject({ projectId, agentId });
  }

  getRunEvents(projectId: string, runId: string, afterRevision = 0): StoredEvent[] | null {
    const project = this.getProject(projectId);
    if (!project?.state.runs[runId]) return null;
    return this.store.readStream(`run:${runId}`, afterRevision);
  }

  getQualityReports(projectId: string): QualityGateReport[] | null {
    const project = this.getProject(projectId);
    if (!project) return null;
    return Object.keys(project.state.workItems)
      .sort()
      .map((workItemId) => evaluateQualityGates(project.state, workItemId));
  }

  async readArtifact(projectId: string, artifactId: string): Promise<{ artifact: ProjectState["artifacts"][string]; content: Buffer } | null> {
    const project = this.getProject(projectId);
    const artifact = project?.state.artifacts[artifactId];
    const root = project?.state.project?.repositoryPath;
    if (!artifact || !root) return null;
    return { artifact, content: await new LocalArtifactStore(root).read(artifact) };
  }

  async importKNowFile(
    projectId: string,
    sourcePath: string,
    context: CommandContext,
  ): Promise<CommandResult> {
    if (!isAbsolute(sourcePath)) throw new DomainRuleError("K-now import sourcePath must be absolute");
    const sourceText = await readFile(sourcePath, "utf8");
    return this.projects.importKNow(projectId, sourceText, sourcePath, context);
  }

  subscribe(listener: (events: StoredEvent[]) => void): () => void {
    this.events.on("events", listener);
    return () => this.events.off("events", listener);
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.terminals.close();
    this.events.removeAllListeners();
    this.store.close();
  }

  private recoverInterruptedRuns(): void {
    for (const snapshot of this.store.listSnapshots<ProjectState>("project")) {
      const projectId = snapshot.streamId.replace(/^project:/, "");
      let current = this.projects.load(projectId);
      const interrupted = Object.values(current.state.runs).filter((run) =>
        ["queued", "starting", "running", "waiting_approval"].includes(run.status),
      );
      for (const run of interrupted) {
        const lease = Object.values(current.state.workspaceLeases).find(
          (candidate) => candidate.runId === run.runId && candidate.status === "active",
        );
        const context = {
          expectedRevision: current.revision,
          idempotencyKey: `recovery:finish:${run.runId}`,
          actorType: "system" as const,
          actorId: "strew-recovery",
        };
        const recovered = lease
          ? this.projects.finishAgentRunAndReleaseLease(
              projectId,
              run.runId,
              "cancelled",
              lease.leaseId,
              context,
            )
          : this.projects.finishAgentRun(projectId, run.runId, "cancelled", context);
        current = { revision: recovered.revision, state: recovered.state };
        const decision = this.replanner.buildDecision(current.state, {
          trigger: "architecture_risk",
          workItemId: run.workItemId,
          currentState: `Run ${run.runId} was active when the local runtime stopped and has been recovered as cancelled.`,
          bottleneck: "The interrupted stage has no trustworthy terminal evidence and must be replanned or retried.",
          attempts: [`${run.runId}: recovered from ${run.status} to cancelled`],
        });
        const paused = this.projects.requestDecisionAndPause(projectId, decision, {
          expectedRevision: current.revision,
          idempotencyKey: `recovery:decision:${run.runId}`,
          actorType: "system",
          actorId: "strew-recovery",
        });
        current = { revision: paused.revision, state: paused.state };
      }
    }
  }

}
