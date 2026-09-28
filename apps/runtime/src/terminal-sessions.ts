import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

import * as pty from "node-pty";

import type { AgentAdapterKind, FunctionalRole, StoredEvent } from "../../../packages/domain/src/index.ts";
import { DomainRuleError } from "../../../packages/domain/src/index.ts";
import type { AgentAdapterRegistry } from "../../../packages/agent-protocol/src/index.ts";
import { ClineExecutionAdapter, openCodeEnvironment } from "../../../packages/adapters/src/index.ts";
import type { CommandContext, ProjectRepository } from "../../../packages/control-plane/src/index.ts";
import { AGENT_INBOX_PROMPT, appendAgentHandoffs, RunEventRecorder, type AgentInbox } from "../../../packages/agent-runtime/src/index.ts";
import { resolveCliLaunch } from "../../../packages/agent-runtime/src/cli-launch.ts";

const MAX_BUFFER = 1_000_000;

export interface StartTerminalInput {
  projectId: string;
  workItemId: string;
  agentId: string;
  role: FunctionalRole;
  cols: number;
  rows: number;
}

export interface TerminalView {
  runId: string;
  projectId: string;
  workItemId: string;
  agentId: string;
  worktreePath: string;
  branchName: string;
  status: "running" | "exited";
  output: string;
  truncated: boolean;
}

type TerminalEvent = { type: "data"; data: string } | { type: "exit"; exitCode: number };

interface Session extends TerminalView {
  process: pty.IPty;
  sequence: number;
  stopRequested: boolean;
  listeners: Set<(event: TerminalEvent) => void>;
}

export class TerminalSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly recorder: RunEventRecorder;
  private readonly execution = new ClineExecutionAdapter();
  private readonly projects: ProjectRepository;
  private readonly adapters: AgentAdapterRegistry;
  private readonly launchForKind?: (kind: AgentAdapterKind) => { executable: string; args: string[] };
  private readonly onStoredEvents?: (events: StoredEvent[]) => void;
  private readonly inbox?: AgentInbox;
  private closed = false;

  constructor(
    projects: ProjectRepository,
    adapters: AgentAdapterRegistry,
    launchForKind?: (kind: AgentAdapterKind) => { executable: string; args: string[] },
    onStoredEvents?: (events: StoredEvent[]) => void,
    inbox?: AgentInbox,
  ) {
    this.projects = projects;
    this.adapters = adapters;
    this.launchForKind = launchForKind;
    this.onStoredEvents = onStoredEvents;
    this.inbox = inbox;
    this.recorder = new RunEventRecorder(projects.store);
  }

  async start(input: StartTerminalInput, context: CommandContext): Promise<TerminalView> {
    if (this.closed) throw new DomainRuleError("terminal manager is closed");
    validateSize(input.cols, input.rows);
    const current = this.projects.load(input.projectId);
    const project = current.state.project;
    if (!project) throw new DomainRuleError(`project '${input.projectId}' does not exist`);
    const agent = current.state.agents[input.agentId];
    if (!agent?.active) throw new DomainRuleError(`agent '${input.agentId}' is not active`);
    if (agent.adapterKind === "external" && !this.launchForKind) {
      throw new DomainRuleError("external agents have no interactive CLI");
    }
    const launch = this.launchForKind?.(agent.adapterKind) ?? {
      executable: this.adapters.get(agent.adapterKind).executable,
      args: [],
    };
    const hash = createHash("sha256").update(`${input.projectId}\0${context.idempotencyKey}`).digest("hex");
    const runId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const branchName = `kanorch/terminal/${runId}`;
    const worktreeRoot = resolve(
      dirname(project.repositoryPath),
      ".kanorch-worktrees",
      createHash("sha256").update(resolve(project.repositoryPath)).digest("hex").slice(0, 10),
    );
    const worktreePath = resolve(worktreeRoot, runId);
    const leaseId = `lease-${runId}`;
    const item = current.state.workItems[input.workItemId];
    if (!item) throw new DomainRuleError(`work item '${input.workItemId}' does not exist`);
    const prompt = appendAgentHandoffs([
      `Work item ${item.workItemId}: ${item.title}`,
      item.description,
      "Acceptance criteria:",
      ...item.acceptanceCriteria.map((criterion) => `- ${criterion}`),
      `Allowed code scopes: ${item.codeScopes.join(", ")}`,
    ].join("\n"), Object.values(current.state.handoffs), item.workItemId, agent.agentId);
    this.projects.startAgentRunWithLease(
      input.projectId,
      { runId, mode: "terminal", workItemId: input.workItemId, agentId: input.agentId,
        role: input.role, attempt: 1, delegationDepth: 0, worktreePath, branchName },
      { leaseId, runId, workItemId: input.workItemId, worktreePath, branchName, codeScopes: item.codeScopes },
      context,
    );
    const existing = this.sessions.get(runId);
    if (existing) return this.view(existing);
    if (current.state.runs[runId]) throw new DomainRuleError("terminal start was recorded but its live session is unavailable");

    let terminal: pty.IPty;
    try {
      await this.execution.ensureWorktree({ repositoryPath: project.repositoryPath, worktreeRoot, runId, branchName });
      const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key, value]) => !/^HERDR_/i.test(key) && value !== undefined),
      ) as Record<string, string>;
      environment.TERM = "xterm-256color";
      const inboxEnvironment = this.inbox?.openRun(input.projectId, runId);
      if (inboxEnvironment) Object.assign(environment, inboxEnvironment);
      if (agent.adapterKind === "opencode") Object.assign(environment, openCodeEnvironment(environment, "manual"));
      const command = resolveCliLaunch(launch.executable, [...launch.args, ...initialPromptArgs(agent.adapterKind, inboxEnvironment ? `${prompt}\n\n${AGENT_INBOX_PROMPT}` : prompt)], environment);
      terminal = pty.spawn(command.executable, command.args, {
        name: "xterm-256color", cols: input.cols, rows: input.rows,
        cwd: worktreePath, env: environment,
      });
    } catch (error) {
      this.inbox?.closeRun(input.projectId, runId);
      const failed = this.projects.load(input.projectId);
      this.projects.finishAgentRunAndReleaseLease(input.projectId, runId, "failed", leaseId, {
        expectedRevision: failed.revision, idempotencyKey: `terminal-start-failed:${runId}`,
        actorType: "system", actorId: "kanorch-terminal",
      });
      throw error;
    }

    const session: Session = {
      runId, projectId: input.projectId, workItemId: input.workItemId,
      agentId: input.agentId, worktreePath, branchName, status: "running",
      output: "", truncated: false, process: terminal, sequence: 0,
      stopRequested: false, listeners: new Set(),
    };
    this.sessions.set(runId, session);
    this.record(session, "run.started", "Interactive terminal started");
    terminal.onData((data) => {
      if (session.status !== "running") return;
      session.output += data;
      if (session.output.length > MAX_BUFFER) {
        session.output = session.output.slice(-MAX_BUFFER);
        session.truncated = true;
      }
      this.record(session, "output.delta", data);
      this.publish(session, { type: "data", data });
    });
    terminal.onExit(({ exitCode }) => this.finish(session, session.stopRequested || exitCode === 0 ? "cancelled" : "failed", exitCode));
    return this.view(session);
  }

  get(projectId: string, runId: string): TerminalView | null {
    const session = this.sessions.get(runId);
    return session?.projectId === projectId ? this.view(session) : null;
  }

  subscribe(projectId: string, runId: string, listener: (event: TerminalEvent) => void): () => void {
    const session = this.requireSession(projectId, runId);
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  write(projectId: string, runId: string, data: string): void {
    const session = this.requireRunning(projectId, runId);
    if (!data || data.length > 4096) throw new DomainRuleError("terminal input must be 1-4096 characters");
    session.process.write(data);
  }

  resize(projectId: string, runId: string, cols: number, rows: number): void {
    const session = this.requireRunning(projectId, runId);
    validateSize(cols, rows);
    session.process.resize(cols, rows);
  }

  stop(projectId: string, runId: string): void {
    const session = this.requireRunning(projectId, runId);
    session.stopRequested = true;
    session.process.kill();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.sessions.values()) {
      if (session.status !== "running") continue;
      session.stopRequested = true;
      this.finish(session, "cancelled", 0);
      session.process.kill();
    }
  }

  private requireSession(projectId: string, runId: string): Session {
    const session = this.sessions.get(runId);
    if (!session || session.projectId !== projectId) throw new DomainRuleError("terminal session does not exist in project");
    return session;
  }

  private requireRunning(projectId: string, runId: string): Session {
    const session = this.requireSession(projectId, runId);
    if (session.status !== "running") throw new DomainRuleError("terminal session has exited");
    return session;
  }

  private finish(session: Session, status: "cancelled" | "failed", exitCode: number): void {
    if (session.status !== "running") return;
    this.inbox?.closeRun(session.projectId, session.runId);
    session.status = "exited";
    const current = this.projects.load(session.projectId);
    this.projects.finishAgentRunAndReleaseLease(session.projectId, session.runId, status, `lease-${session.runId}`, {
      expectedRevision: current.revision, idempotencyKey: `terminal-exit:${session.runId}`,
      actorType: "system", actorId: "kanorch-terminal",
    });
    this.record(session, status === "failed" ? "run.failed" : "run.cancelled", `Terminal exited with code ${exitCode}`);
    this.publish(session, { type: "exit", exitCode });
  }

  private record(session: Session, type: "run.started" | "output.delta" | "run.failed" | "run.cancelled", message: string): void {
    const stored = this.recorder.record({
      eventId: randomUUID(), runId: session.runId, sequence: ++session.sequence,
      occurredAt: new Date().toISOString(), type, message,
      raw: { terminal: true },
    });
    this.onStoredEvents?.(stored);
  }

  private publish(session: Session, event: TerminalEvent): void {
    for (const listener of session.listeners) listener(event);
  }

  private view(session: Session): TerminalView {
    const { runId, projectId, workItemId, agentId, worktreePath, branchName, status, output, truncated } = session;
    return { runId, projectId, workItemId, agentId, worktreePath, branchName, status, output, truncated };
  }
}

export function initialPromptArgs(kind: AgentAdapterKind, prompt: string): string[] {
  if (kind === "opencode") return ["--agent", "build", "--prompt", prompt];
  if (kind === "codex" || kind === "claude-code") return [prompt];
  return [];
}

function validateSize(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || cols < 20 || cols > 400 || !Number.isInteger(rows) || rows < 5 || rows > 200) {
    throw new DomainRuleError("terminal size is outside 20-400 columns and 5-200 rows");
  }
}
