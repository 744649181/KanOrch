import type { DomainEvent, PendingEvent, StoredEvent } from "../../domain/src/events.ts";
import {
  decideAddDependency,
  decideAddWorkItem,
  decideApplyPlannedWorkGraph,
  decideChangeWorkItemStatus,
  decideCreateProject,
  decideFetchHandoffArtifact,
  decideAcknowledgeAgentHandoff,
  decideFinishAgentRun,
  decideRegisterAgent,
  decideRecordArtifact,
  decideRecordAgentHandoff,
  decideRecordBudgetEntry,
  decideRecordEvidence,
  decideRequestDecision,
  decideResolveDecision,
  decideSetWorkItemRoles,
  decideStartAgentRun,
  emptyProjectState,
  evolveProject,
  replayProject,
  upgradeProjectState,
  type AddDependencyInput,
  type AddWorkItemInput,
  type ApplyPlannedWorkGraphInput,
  type AgentProfile,
  type Artifact,
  type BudgetEntry,
  type CreateProjectInput,
  type DecisionRequest,
  type Evidence,
  type FunctionalRole,
  type ProjectState,
  type RecordAgentHandoffInput,
  type StartAgentRunInput,
  type WorkItemStatus,
} from "../../domain/src/index.ts";
import { fingerprintValue, SqliteEventStore } from "../../event-store/src/index.ts";
import {
  decideAcquireWorkspaceLease,
  decideReleaseWorkspaceLease,
  type AcquireWorkspaceLeaseInput,
} from "../../scheduler/src/index.ts";
import { decisionPauseEvents } from "../../replanner/src/index.ts";
import { KNowImporter } from "../../migration/src/index.ts";
import { decideCompleteWorkItem } from "../../quality-gates/src/index.ts";

export interface CommandContext {
  expectedRevision: number;
  idempotencyKey: string;
  actorType: "user" | "system" | "agent";
  actorId?: string | null;
}

export interface CommandResult {
  revision: number;
  state: ProjectState;
  events: StoredEvent[];
}

export class ProjectRepository {
  readonly store: SqliteEventStore;
  private readonly onCommitted: ((events: StoredEvent[]) => void) | undefined;

  constructor(store: SqliteEventStore, onCommitted?: (events: StoredEvent[]) => void) {
    this.store = store;
    this.onCommitted = onCommitted;
  }

  load(projectId: string): { revision: number; state: ProjectState } {
    const streamId = projectStreamId(projectId);
    const snapshot = this.store.loadSnapshot<ProjectState>(streamId);
    if (snapshot) return { revision: snapshot.revision, state: upgradeProjectState(snapshot.state) };
    const events = this.store.readStream(streamId);
    return {
      revision: events.at(-1)?.revision ?? 0,
      state: upgradeProjectState(replayProject(events.map(toDomainEvent))),
    };
  }

  createProject(input: CreateProjectInput, context: CommandContext): CommandResult {
    return this.execute(input.projectId, context, "createProject", input, (state) => [
      decideCreateProject(state, input),
    ]);
  }

  addWorkItem(projectId: string, input: AddWorkItemInput, context: CommandContext): CommandResult {
    return this.execute(projectId, context, "addWorkItem", input, (state) => [
      decideAddWorkItem(state, input),
    ]);
  }

  setWorkItemRoles(projectId: string, workItemId: string, allowedRoles: FunctionalRole[], context: CommandContext): CommandResult {
    return this.execute(projectId, context, "setWorkItemRoles", { workItemId, allowedRoles }, (state) => [
      decideSetWorkItemRoles(state, workItemId, allowedRoles),
    ]);
  }

  addDependency(projectId: string, input: AddDependencyInput, context: CommandContext): CommandResult {
    return this.execute(projectId, context, "addDependency", input, (state) => [
      decideAddDependency(state, input),
    ]);
  }

  applyPlannedWorkGraph(
    projectId: string,
    input: ApplyPlannedWorkGraphInput,
    context: CommandContext,
  ): CommandResult {
    return this.execute(projectId, context, "applyPlannedWorkGraph", input, (state) =>
      decideApplyPlannedWorkGraph(state, input),
    );
  }

  registerAgent(projectId: string, agent: AgentProfile, context: CommandContext): CommandResult {
    return this.execute(projectId, context, "registerAgent", agent, (state) => [
      decideRegisterAgent(state, agent),
    ]);
  }

  changeWorkItemStatus(
    projectId: string,
    workItemId: string,
    status: WorkItemStatus,
    context: CommandContext,
  ): CommandResult {
    return this.execute(projectId, context, "changeWorkItemStatus", { workItemId, status }, (state) => [
      decideChangeWorkItemStatus(state, workItemId, status),
    ]);
  }

  completeWorkItem(
    projectId: string,
    workItemId: string,
    context: CommandContext,
  ): CommandResult {
    return this.execute(projectId, context, "completeWorkItem", { workItemId }, (state) => [
      decideCompleteWorkItem(state, workItemId),
    ]);
  }

  startAgentRun(
    projectId: string,
    input: StartAgentRunInput,
    context: CommandContext,
  ): CommandResult {
    return this.execute(projectId, context, "startAgentRun", input, (state) =>
      decideStartAgentRun(state, input),
    );
  }

  startAgentRunWithLease(
    projectId: string,
    input: StartAgentRunInput,
    lease: AcquireWorkspaceLeaseInput,
    context: CommandContext,
  ): CommandResult {
    return this.execute(projectId, context, "startAgentRunWithLease", { input, lease }, (state) => {
      const runEvents = decideStartAgentRun(state, input);
      const afterRun = runEvents.reduce(evolveProject, state);
      return [...runEvents, decideAcquireWorkspaceLease(afterRun, lease)];
    });
  }

  finishAgentRun(
    projectId: string,
    runId: string,
    status: "succeeded" | "failed" | "cancelled",
    context: CommandContext,
  ): CommandResult {
    return this.execute(projectId, context, "finishAgentRun", { runId, status }, (state) =>
      decideFinishAgentRun(state, runId, status),
    );
  }

  finishAgentRunAndReleaseLease(
    projectId: string,
    runId: string,
    status: "succeeded" | "failed" | "cancelled",
    leaseId: string,
    context: CommandContext,
  ): CommandResult {
    return this.execute(
      projectId,
      context,
      "finishAgentRunAndReleaseLease",
      { runId, status, leaseId },
      (state) => {
        const finishEvents = decideFinishAgentRun(state, runId, status);
        const afterFinish = finishEvents.reduce(evolveProject, state);
        return [...finishEvents, decideReleaseWorkspaceLease(afterFinish, leaseId)];
      },
    );
  }

  recordArtifact(projectId: string, artifact: Artifact, context: CommandContext): CommandResult {
    return this.execute(projectId, context, "recordArtifact", artifact, (state) => [
      decideRecordArtifact(state, artifact),
    ]);
  }

  recordAgentHandoff(
    projectId: string,
    input: RecordAgentHandoffInput,
    context: CommandContext,
  ): CommandResult {
    return this.execute(projectId, context, "recordAgentHandoff", input, (state) => [
      decideRecordAgentHandoff(state, input),
    ]);
  }

  fetchHandoffArtifact(
    projectId: string, messageId: string, artifactId: string, recipientRunId: string, context: CommandContext,
  ): CommandResult {
    return this.execute(projectId, context, "fetchHandoffArtifact", { messageId, artifactId, recipientRunId }, (state) => [
      decideFetchHandoffArtifact(state, messageId, artifactId, recipientRunId),
    ]);
  }

  acknowledgeAgentHandoff(
    projectId: string, messageId: string, recipientRunId: string, context: CommandContext,
  ): CommandResult {
    return this.execute(projectId, context, "acknowledgeAgentHandoff", { messageId, recipientRunId }, (state) => [
      decideAcknowledgeAgentHandoff(state, messageId, recipientRunId),
    ]);
  }

  recordEvidence(projectId: string, evidence: Evidence, context: CommandContext): CommandResult {
    return this.execute(projectId, context, "recordEvidence", evidence, (state) => [
      decideRecordEvidence(state, evidence),
    ]);
  }

  recordBudgetEntry(projectId: string, entry: BudgetEntry, context: CommandContext): CommandResult {
    return this.execute(projectId, context, "recordBudgetEntry", entry, (state) => [
      decideRecordBudgetEntry(state, entry),
    ]);
  }

  requestDecision(
    projectId: string,
    decision: DecisionRequest,
    context: CommandContext,
  ): CommandResult {
    return this.execute(projectId, context, "requestDecision", decision, (state) => [
      decideRequestDecision(state, decision),
    ]);
  }

  requestDecisionAndPause(
    projectId: string,
    decision: DecisionRequest,
    context: CommandContext,
  ): CommandResult {
    return this.execute(projectId, context, "requestDecisionAndPause", decision, (state) =>
      decisionPauseEvents(state, decision),
    );
  }

  resolveDecision(
    projectId: string,
    decisionId: string,
    selectedOptionId: string,
    context: CommandContext,
  ): CommandResult {
    return this.execute(
      projectId,
      context,
      "resolveDecision",
      { decisionId, selectedOptionId },
      (state) => [decideResolveDecision(state, decisionId, selectedOptionId)],
    );
  }

  importKNow(
    projectId: string,
    sourceText: string,
    sourcePath: string,
    context: CommandContext,
  ): CommandResult {
    const importer = new KNowImporter();
    const current = this.load(projectId);
    const initialPlan = importer.plan(current.state, sourceText, sourcePath);
    if (initialPlan.duplicate) return { revision: current.revision, state: current.state, events: [] };
    return this.execute(
      projectId,
      context,
      "importKNow",
      { sourcePath, sourceHash: initialPlan.sourceHash },
      (state) => importer.plan(state, sourceText, sourcePath).events,
    );
  }

  private execute(
    projectId: string,
    context: CommandContext,
    commandName: string,
    commandPayload: unknown,
    decide: (state: ProjectState) => DomainEvent[],
  ): CommandResult {
    const streamId = projectStreamId(projectId);
    const commandHash = fingerprintValue({
      commandName,
      commandPayload,
      expectedRevision: context.expectedRevision,
    });
    const replayedEvents = this.store.replayCommand(
      context.idempotencyKey,
      streamId,
      commandHash,
    );
    if (replayedEvents) {
      return {
        revision: replayedEvents.at(-1)?.revision ?? context.expectedRevision,
        state: this.load(projectId).state,
        events: replayedEvents,
      };
    }
    const current = this.load(projectId);
    const domainEvents = decide(current.state);
    const nextState = domainEvents.reduce(evolveProject, current.state);
    const pendingEvents: PendingEvent[] = domainEvents.map((event) => ({
      ...event,
      actorType: context.actorType,
      actorId: context.actorId ?? null,
    }));
    const storedEvents = this.store.append({
      streamId,
      streamType: "project",
      expectedRevision: context.expectedRevision,
      idempotencyKey: context.idempotencyKey,
      commandHash,
      events: pendingEvents,
      projection: nextState,
    });
    const revision = storedEvents.at(-1)?.revision ?? context.expectedRevision;
    this.onCommitted?.(storedEvents);
    return { revision, state: nextState, events: storedEvents };
  }
}

function projectStreamId(projectId: string): string {
  return `project:${projectId}`;
}

function toDomainEvent(event: StoredEvent): DomainEvent {
  return { eventType: event.eventType, payload: event.payload } as DomainEvent;
}
