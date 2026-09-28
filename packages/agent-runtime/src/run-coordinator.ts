import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

import type {
  AgentAdapterKind,
  AgentHandoff,
  Artifact,
  BudgetEntry,
  Evidence,
  EvidenceKind,
  FunctionalRole,
} from "../../domain/src/index.ts";
import { DomainRuleError } from "../../domain/src/index.ts";
import type {
  AgentAdapterRegistry,
  AgentPermissionMode,
  PersistedRunEvent,
} from "../../agent-protocol/src/index.ts";
import { LocalArtifactStore } from "../../artifact-store/src/index.ts";
import { ClineExecutionAdapter, type WorkspaceChanges } from "../../adapters/src/index.ts";
import type { ProjectRepository } from "../../control-plane/src/index.ts";
import { Scheduler } from "../../scheduler/src/index.ts";
import { AgentProcessRunner, type AgentProcessResult } from "./process-runner.ts";
import { RunEventRecorder } from "./run-event-recorder.ts";
import { AGENT_INBOX_PROMPT, type AgentInbox } from "./agent-inbox.ts";

export interface ExecuteAgentRunInput {
  projectId: string;
  workItemId: string;
  role: FunctionalRole;
  prompt: string;
  permissionMode: AgentPermissionMode;
  agentId?: string;
  runId?: string;
  attempt?: number;
  delegationDepth?: number;
  baseRef?: string;
  model?: string;
  sessionId?: string;
  maxBudgetUsd?: number;
  subjectRunId?: string | null;
  signal?: AbortSignal;
  onEvent?: (event: PersistedRunEvent) => void | Promise<void>;
}

export interface ExecuteAgentRunResult {
  runId: string;
  agentId: string;
  status: "succeeded" | "failed" | "cancelled";
  events: PersistedRunEvent[];
  worktreePath: string;
  branchName: string;
  baseCommit: string;
  artifacts: Artifact[];
  evidence: Evidence | null;
  budgetEntry: BudgetEntry;
  process: AgentProcessResult | null;
  changes: WorkspaceChanges | null;
}

export interface RunCoordinatorOptions {
  repository: ProjectRepository;
  adapters: AgentAdapterRegistry;
  runner?: AgentProcessRunner;
  scheduler?: Scheduler;
  execution?: ClineExecutionAdapter;
  worktreeRoot?: (repositoryPath: string, projectId: string) => string;
  artifactStore?: (repositoryPath: string) => LocalArtifactStore;
  onStoredEvents?: (events: import("../../domain/src/index.ts").StoredEvent[]) => void;
  inbox?: AgentInbox;
}

export class RunCoordinator {
  private readonly repository: ProjectRepository;
  private readonly adapters: AgentAdapterRegistry;
  private readonly runner: AgentProcessRunner;
  private readonly scheduler: Scheduler;
  private readonly execution: ClineExecutionAdapter;
  private readonly worktreeRoot: NonNullable<RunCoordinatorOptions["worktreeRoot"]>;
  private readonly artifactStore: NonNullable<RunCoordinatorOptions["artifactStore"]>;
  private readonly onStoredEvents: RunCoordinatorOptions["onStoredEvents"];
  private readonly inbox: AgentInbox | undefined;

  constructor(options: RunCoordinatorOptions) {
    this.repository = options.repository;
    this.adapters = options.adapters;
    this.runner = options.runner ?? new AgentProcessRunner();
    this.scheduler = options.scheduler ?? new Scheduler();
    this.execution = options.execution ?? new ClineExecutionAdapter();
    this.worktreeRoot =
      options.worktreeRoot ??
      ((repositoryPath, projectId) =>
        resolve(
          dirname(repositoryPath),
          ".strew-worktrees",
          `${safeSegment(projectId)}-${createHash("sha256").update(resolve(repositoryPath)).digest("hex").slice(0, 10)}`,
        ));
    this.artifactStore = options.artifactStore ?? ((repositoryPath) => new LocalArtifactStore(repositoryPath));
    this.onStoredEvents = options.onStoredEvents;
    this.inbox = options.inbox;
  }

  async execute(input: ExecuteAgentRunInput): Promise<ExecuteAgentRunResult> {
    const initial = this.repository.load(input.projectId);
    const project = initial.state.project;
    if (!project) throw new DomainRuleError(`project '${input.projectId}' does not exist`);
    const item = initial.state.workItems[input.workItemId];
    if (!item) throw new DomainRuleError(`work item '${input.workItemId}' does not exist`);
    const route = input.agentId
      ? { agentId: input.agentId }
      : this.scheduler.route(initial.state, input.workItemId, input.role);
    const agent = initial.state.agents[route.agentId];
    if (!agent) throw new DomainRuleError(`agent '${route.agentId}' does not exist`);
    const adapter = this.adapters.get(agent.adapterKind);
    const runId = input.runId ?? randomUUID();
    const branchName = `strew/${safeSegment(input.workItemId)}/${safeSegment(input.role)}/${safeSegment(runId).slice(0, 24)}`;
    const worktree = await this.execution.ensureWorktree({
      repositoryPath: project.repositoryPath,
      worktreeRoot: this.worktreeRoot(project.repositoryPath, project.projectId),
      runId,
      branchName,
      baseRef: input.baseRef,
    });
    const leaseId = `lease-${runId}`;
    const started = this.repository.load(input.projectId);
    const prompt = appendAgentHandoffs(input.prompt, Object.values(started.state.handoffs), input.workItemId, agent.agentId);
    this.repository.startAgentRunWithLease(
      input.projectId,
      {
        runId,
        workItemId: input.workItemId,
        agentId: agent.agentId,
        role: input.role,
        attempt: input.attempt ?? 1,
        delegationDepth: input.delegationDepth ?? 0,
        worktreePath: worktree.worktreePath,
        branchName: worktree.branchName,
      },
      {
        leaseId,
        runId,
        workItemId: input.workItemId,
        worktreePath: worktree.worktreePath,
        branchName: worktree.branchName,
        codeScopes: item.codeScopes,
      },
      systemContext(started.revision, `start:${runId}`),
    );
    const runRecorder = new RunEventRecorder(this.repository.store);
    const events: PersistedRunEvent[] = [];
    const startedAt = Date.now();
    let processResult: AgentProcessResult | null = null;
    let terminalStatus: ExecuteAgentRunResult["status"] = "failed";
    let processError: unknown = null;
    try {
      const inboxEnvironment = this.inbox?.openRun(input.projectId, runId);
      processResult = await this.runner.run(
        adapter,
        {
          runId,
          prompt: inboxEnvironment ? `${prompt}\n\n${AGENT_INBOX_PROMPT}` : prompt,
          workspacePath: worktree.worktreePath,
          permissionMode: input.permissionMode,
          model: input.model,
          sessionId: input.sessionId,
          maxBudgetUsd: input.maxBudgetUsd,
          extraEnvironment: inboxEnvironment ?? undefined,
        },
        {
          signal: input.signal,
          onEvent: async (event) => {
            events.push(event);
            const storedEvents = runRecorder.record(event);
            this.onStoredEvents?.(storedEvents);
            await input.onEvent?.(event);
          },
        },
      );
      terminalStatus = terminalStatusFrom(processResult);
    } catch (error) {
      processError = error;
      terminalStatus = input.signal?.aborted ? "cancelled" : "failed";
    }
    this.inbox?.closeRun(input.projectId, runId);
    const explicitVerdict = inferStageVerdict(input.role, events);
    if (
      terminalStatus === "succeeded" &&
      ["review", "testing"].includes(input.role) &&
      explicitVerdict !== "passed"
    ) {
      terminalStatus = "failed";
    }

    const artifacts: Artifact[] = [];
    let workspaceChanges: WorkspaceChanges | null = null;
    const artifactStore = this.artifactStore(project.repositoryPath);
    const logArtifact = await artifactStore.write({
      projectId: project.projectId,
      workItemId: item.workItemId,
      runId,
      kind: "log",
      content: `${events.map((event) => JSON.stringify(event)).join("\n")}${events.length ? "\n" : ""}${
        processError ? `${JSON.stringify({ type: "coordinator.error", message: errorMessage(processError) })}\n` : ""
      }`,
      mediaType: "application/x-ndjson",
      extension: "jsonl",
    });
    artifacts.push(logArtifact);

    if (terminalStatus === "succeeded" && input.role === "implementation") {
      try {
        const commit = await this.execution.commitAll({
          worktreePath: worktree.worktreePath,
          message: `Implement ${item.workItemId}: ${item.title}`.slice(0, 200),
        });
        artifacts.push(
          await artifactStore.write({
            projectId: project.projectId,
            workItemId: item.workItemId,
            runId,
            kind: "commit",
            content: `${commit.commitSha}\n${commit.committed ? "created by Strew" : "agent workspace was already clean"}\n`,
            mediaType: "text/plain",
            extension: "txt",
          }),
        );
      } catch (error) {
        artifacts.push(
          await artifactStore.write({
            projectId: project.projectId,
            workItemId: item.workItemId,
            runId,
            kind: "report",
            content: `Automatic commit failed: ${errorMessage(error)}\n`,
            mediaType: "text/plain",
            extension: "txt",
          }),
        );
        terminalStatus = "failed";
      }
    }

    try {
      const changes = await this.execution.captureChanges({
        worktreePath: worktree.worktreePath,
        baseCommit: worktree.baseCommit,
      });
      workspaceChanges = changes;
      if (changes.isDirty) {
        artifacts.push(
          await artifactStore.write({
            projectId: project.projectId,
            workItemId: item.workItemId,
            runId,
            kind: "diff",
            content: changes.patch,
            mediaType: "text/x-diff",
            extension: "patch",
          }),
        );
      }
    } catch (error) {
      artifacts.push(
        await artifactStore.write({
          projectId: project.projectId,
          workItemId: item.workItemId,
          runId,
          kind: "report",
          content: `Change capture failed: ${errorMessage(error)}\n`,
          mediaType: "text/plain",
          extension: "txt",
        }),
      );
      terminalStatus = "failed";
    }

    for (const artifact of artifacts) {
      const current = this.repository.load(input.projectId);
      this.repository.recordArtifact(
        input.projectId,
        artifact,
        systemContext(current.revision, `artifact:${artifact.artifactId}`),
      );
    }

    const usage = aggregateUsage(events);
    const budgetEntry: BudgetEntry = {
      budgetEntryId: `budget-${runId}`,
      projectId: project.projectId,
      workItemId: item.workItemId,
      runId,
      kind: "actual",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
      wallClockSeconds: (Date.now() - startedAt) / 1_000,
      createdAt: new Date().toISOString(),
    };
    let current = this.repository.load(input.projectId);
    this.repository.recordBudgetEntry(
      input.projectId,
      budgetEntry,
      systemContext(current.revision, `budget:${runId}`),
    );
    current = this.repository.load(input.projectId);
    this.repository.finishAgentRunAndReleaseLease(
      input.projectId,
      runId,
      terminalStatus,
      leaseId,
      systemContext(current.revision, `finish:${runId}`),
    );

    let evidence: Evidence | null = null;
    const evidenceKind = evidenceKindFor(input.role);
    if (evidenceKind && (terminalStatus === "succeeded" || ["review", "testing"].includes(input.role))) {
      const verdict = terminalStatus === "succeeded"
        ? "passed"
        : explicitVerdict === "failed"
          ? "failed"
          : "informational";
      evidence = {
        evidenceId: `evidence-${runId}`,
        projectId: project.projectId,
        workItemId: item.workItemId,
        runId,
        producerAgentId: agent.agentId,
        kind: evidenceKind,
        verdict,
        summary:
          verdict === "passed"
            ? `${adapter.displayName} completed the ${input.role} stage with an explicit PASS verdict`
            : verdict === "failed"
              ? `${adapter.displayName} reported an explicit FAIL verdict for the ${input.role} stage`
              : `${adapter.displayName} did not provide the required machine-readable verdict for the ${input.role} stage`,
        artifactIds: artifacts.map((artifact) => artifact.artifactId),
        subjectRunId: input.subjectRunId ?? null,
        imported: false,
        createdAt: new Date().toISOString(),
      };
      current = this.repository.load(input.projectId);
      this.repository.recordEvidence(
        input.projectId,
        evidence,
        systemContext(current.revision, `evidence:${runId}`),
      );
    }
    return {
      runId,
      agentId: agent.agentId,
      status: terminalStatus,
      events,
      worktreePath: worktree.worktreePath,
      branchName: worktree.branchName,
      baseCommit: worktree.baseCommit,
      artifacts,
      evidence,
      budgetEntry,
      process: processResult,
      changes: workspaceChanges,
    };
  }
}

export function appendAgentHandoffs(
  prompt: string,
  messages: readonly AgentHandoff[],
  workItemId: string,
  agentId: string,
): string {
  const handoffs = messages
    .filter((message) => message.workItemId === workItemId && message.recipientAgentId === agentId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return handoffs.length
    ? `${prompt}\n\nKanOrch handoffs for this agent and work item:\n${handoffs.map((message) => JSON.stringify(message)).join("\n")}`
    : prompt;
}

function terminalStatusFrom(result: AgentProcessResult): ExecuteAgentRunResult["status"] {
  const terminal = [...result.events]
    .reverse()
    .find((event) => ["run.succeeded", "run.failed", "run.cancelled"].includes(event.type));
  if (terminal?.type === "run.cancelled") return "cancelled";
  if (terminal?.type === "run.failed") return "failed";
  return terminal?.type === "run.succeeded" || result.exitCode === 0 ? "succeeded" : "failed";
}

export function aggregateUsage(events: readonly PersistedRunEvent[]): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let stepInput = 0;
  let stepOutput = 0;
  let stepCost = 0;
  for (const event of events) {
    if (event.type === "usage.updated" && /^step[._]finish$/.test(event.providerEventType ?? "")) {
      stepInput += event.inputTokens ?? 0;
      stepOutput += event.outputTokens ?? 0;
      stepCost += event.costUsd ?? 0;
      continue;
    }
    inputTokens = Math.max(inputTokens, event.inputTokens ?? 0);
    outputTokens = Math.max(outputTokens, event.outputTokens ?? 0);
    costUsd = Math.max(costUsd, event.costUsd ?? 0);
  }
  return {
    inputTokens: Math.max(inputTokens, stepInput),
    outputTokens: Math.max(outputTokens, stepOutput),
    costUsd: Math.max(costUsd, stepCost),
  };
}

function evidenceKindFor(role: FunctionalRole): EvidenceKind | null {
  if (role === "implementation") return "implementation";
  if (role === "review") return "review";
  if (role === "testing") return "test";
  if (role === "integration") return "integration";
  return null;
}

export function inferStageVerdict(
  role: FunctionalRole,
  events: readonly PersistedRunEvent[],
): "passed" | "failed" | "missing" {
  if (!["review", "testing"].includes(role)) return "passed";
  const messages = events.map((event) => event.message ?? "");
  for (const message of messages.toReversed()) {
    if (/STREW_VERDICT\s*:\s*FAIL\b/i.test(message)) return "failed";
    if (/STREW_VERDICT\s*:\s*PASS\b/i.test(message)) return "passed";
  }
  return "missing";
}

function systemContext(expectedRevision: number, idempotencyKey: string) {
  return {
    expectedRevision,
    idempotencyKey,
    actorType: "system" as const,
    actorId: "strew-director",
  };
}

function safeSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (!normalized) throw new DomainRuleError("identifier must contain a safe Git/path segment");
  return normalized;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
