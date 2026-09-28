import { randomBytes } from "node:crypto";

import { LocalArtifactStore } from "../../artifact-store/src/index.ts";
import { DomainRuleError, type AgentHandoff, type Artifact } from "../../domain/src/index.ts";
import { type ProjectRepository } from "../../control-plane/src/index.ts";

interface Scope { projectId: string; runId: string; agentId: string; workItemId: string }

export class AgentInboxAuthError extends Error {}

/** Ephemeral bearer capabilities are bound to active runs; receipts remain in the event store. */
export class AgentInbox {
  private readonly projects: ProjectRepository;
  private origin: string | null = null;
  private readonly scopes = new Map<string, Scope>();
  private readonly runTokens = new Map<string, string>();

  constructor(projects: ProjectRepository) { this.projects = projects; }

  setOrigin(origin: string | null): void { this.origin = origin; }

  openRun(projectId: string, runId: string): Record<string, string> | null {
    if (!this.origin) return null;
    const run = this.projects.load(projectId).state.runs[runId];
    if (!run || run.finishedAt) throw new DomainRuleError("inbox requires an active run");
    this.closeRun(projectId, runId);
    const token = randomBytes(32).toString("hex");
    this.scopes.set(token, { projectId, runId, agentId: run.agentId, workItemId: run.workItemId });
    this.runTokens.set(`${projectId}\0${runId}`, token);
    return { KANORCH_INBOX_ORIGIN: this.origin, KANORCH_INBOX_TOKEN: token };
  }

  closeRun(projectId: string, runId: string): void {
    const key = `${projectId}\0${runId}`;
    const token = this.runTokens.get(key);
    if (token) this.scopes.delete(token);
    this.runTokens.delete(key);
  }

  list(token: string): AgentHandoff[] {
    const scope = this.scope(token);
    return Object.values(this.projects.load(scope.projectId).state.handoffs)
      .filter((message) => message.workItemId === scope.workItemId && message.recipientAgentId === scope.agentId);
  }

  async fetchArtifact(token: string, messageId: string, artifactId: string): Promise<{ artifact: Artifact; content: Buffer }> {
    const scope = this.scope(token);
    const state = this.projects.load(scope.projectId).state;
    const handoff = state.handoffs[messageId];
    const artifact = state.artifacts[artifactId];
    if (!handoff || handoff.workItemId !== scope.workItemId || handoff.recipientAgentId !== scope.agentId ||
        !handoff.artifactIds.includes(artifactId) || !artifact || !state.project) {
      throw new DomainRuleError("artifact is not attached to this run's inbox");
    }
    const content = await new LocalArtifactStore(state.project.repositoryPath).read(artifact);
    this.scope(token);
    const current = this.projects.load(scope.projectId);
    if (!current.state.handoffs[messageId]?.artifactReads?.[scope.runId]?.[artifactId]) {
      this.projects.fetchHandoffArtifact(scope.projectId, messageId, artifactId, scope.runId, {
        expectedRevision: current.revision,
        idempotencyKey: `inbox-fetch:${scope.runId}:${messageId}:${artifactId}`,
        actorType: "agent", actorId: scope.agentId,
      });
    }
    return { artifact, content };
  }

  acknowledge(token: string, messageId: string): AgentHandoff {
    const scope = this.scope(token);
    const current = this.projects.load(scope.projectId);
    const handoff = current.state.handoffs[messageId];
    if (handoff?.acknowledgedByRunId === scope.runId) return handoff;
    const result = this.projects.acknowledgeAgentHandoff(scope.projectId, messageId, scope.runId, {
      expectedRevision: current.revision,
      idempotencyKey: `inbox-ack:${scope.runId}:${messageId}`,
      actorType: "agent", actorId: scope.agentId,
    });
    return result.state.handoffs[messageId]!;
  }

  private scope(token: string): Scope {
    const scope = this.scopes.get(token);
    if (!scope) throw new AgentInboxAuthError("invalid or expired agent inbox token");
    const run = this.projects.load(scope.projectId).state.runs[scope.runId];
    if (!run || run.finishedAt !== null) throw new AgentInboxAuthError("agent inbox run has ended");
    return scope;
  }
}

export const AGENT_INBOX_PROMPT = "KanOrch inbox: use KANORCH_INBOX_ORIGIN and KANORCH_INBOX_TOKEN from your environment. GET /api/agent/inbox with Authorization: Bearer <token>; GET /api/agent/inbox/<messageId>/artifacts/<artifactId> to fetch each attachment; POST /api/agent/inbox/<messageId>/ack after reviewing it. Never print the token.";
