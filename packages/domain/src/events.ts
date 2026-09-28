import type {
  Artifact,
  AgentProfile,
  AgentRun,
  AgentHandoff,
  BudgetEntry,
  DecisionRequest,
  Dependency,
  Evidence,
  FunctionalRole,
  LegacyImportReceipt,
  Project,
  WorkItem,
  WorkItemStatus,
  WorkspaceLease,
} from "./model.ts";

export type DomainEvent =
  | { eventType: "project.created"; payload: { project: Project } }
  | { eventType: "work_item.added"; payload: { workItem: WorkItem } }
  | { eventType: "work_item.roles_changed"; payload: { workItemId: string; allowedRoles: FunctionalRole[] } }
  | { eventType: "work_item.status_changed"; payload: { workItemId: string; status: WorkItemStatus } }
  | { eventType: "dependency.added"; payload: { dependency: Dependency } }
  | { eventType: "agent.registered"; payload: { agent: AgentProfile } }
  | { eventType: "agent_run.started"; payload: { run: AgentRun } }
  | { eventType: "agent_handoff.recorded"; payload: { handoff: AgentHandoff } }
  | { eventType: "agent_handoff.artifact_fetched"; payload: { messageId: string; artifactId: string; recipientRunId: string; fetchedAt: string } }
  | { eventType: "agent_handoff.acknowledged"; payload: { messageId: string; recipientRunId: string; acknowledgedAt: string } }
  | { eventType: "workspace_lease.acquired"; payload: { lease: WorkspaceLease } }
  | {
      eventType: "workspace_lease.released";
      payload: { leaseId: string; releasedAt: string };
    }
  | { eventType: "artifact.recorded"; payload: { artifact: Artifact } }
  | { eventType: "evidence.recorded"; payload: { evidence: Evidence } }
  | { eventType: "budget.recorded"; payload: { entry: BudgetEntry } }
  | { eventType: "legacy_import.recorded"; payload: { receipt: LegacyImportReceipt } }
  | {
      eventType: "agent_run.finished";
      payload: { runId: string; status: "succeeded" | "failed" | "cancelled"; finishedAt: string };
    }
  | { eventType: "decision.requested"; payload: { decision: DecisionRequest } }
  | {
      eventType: "decision.resolved";
      payload: { decisionId: string; selectedOptionId: string; resolvedAt: string };
    };

export interface StoredEvent<TPayload = unknown> {
  sequence: number;
  eventId: string;
  streamId: string;
  streamType: string;
  revision: number;
  eventType: string;
  payload: TPayload;
  actorType: "user" | "system" | "agent";
  actorId: string | null;
  createdAt: string;
}

export interface PendingEvent<TPayload = unknown> {
  eventId?: string;
  eventType: string;
  payload: TPayload;
  actorType: "user" | "system" | "agent";
  actorId?: string | null;
  createdAt?: string;
}
