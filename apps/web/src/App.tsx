import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type {
  AgentProfile,
  AgentRun,
  DecisionRequest,
  Dependency,
  FunctionalRole,
  ProjectState,
  StoredEvent,
  WorkItem,
  WorkItemStatus,
} from "../../../packages/domain/src/index.ts";
import { calculateBudgetTotals, evaluateQualityGates } from "../../../packages/quality-gates/src/quality-gates.ts";
import {
  addWorkItem,
  addDependency,
  ApiError,
  changeWorkItemStatus,
  cancelAgentRun,
  createProject,
  deliverWorkItem,
  executeAgentRun,
  startAgentTerminal,
  getArtifactText,
  getProject,
  getRunEvents,
  importKNow,
  integrateVerifiedWorkItem,
  listProjects,
  planProject,
  registerAgent,
  recordAgentHandoff,
  resolveDecision,
  setWorkItemRoles,
  type ProjectView,
} from "./api.ts";
import { projectPresence } from "./project-presence.ts";
import { useProjectStream } from "./use-project-stream.ts";
import { TerminalPane } from "./TerminalPane.tsx";

type MainView = "board" | "graph" | "agents" | "quality" | "budget" | "decisions";

const BOARD_COLUMNS: Array<{ status: WorkItemStatus; label: string }> = [
  { status: "backlog", label: "Backlog" },
  { status: "ready", label: "Ready" },
  { status: "running", label: "In progress" },
  { status: "waiting_review", label: "Review" },
  { status: "verifying", label: "Verify" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

const DEFAULT_AGENT_PROFILES: Array<Omit<AgentProfile, "createdAt">> = [
  {
    agentId: "codex-local",
    displayName: "Codex",
    adapterKind: "codex",
    capabilities: ["architecture", "git", "node", "python", "react", "review", "sqlite", "testing", "typescript"],
    roles: ["planning", "architecture", "implementation", "review", "testing", "integration"],
    reliability: 0.9,
    costPerMillionTokens: null,
    active: true,
    maxConcurrentRuns: 2,
  },
  {
    agentId: "claude-code-local",
    displayName: "Claude Code",
    adapterKind: "claude-code",
    capabilities: ["architecture", "git", "node", "python", "react", "review", "sqlite", "testing", "typescript"],
    roles: ["planning", "architecture", "implementation", "review", "testing", "integration"],
    reliability: 0.88,
    costPerMillionTokens: null,
    active: true,
    maxConcurrentRuns: 2,
  },
  {
    agentId: "opencode-local",
    displayName: "OpenCode",
    adapterKind: "opencode",
    capabilities: ["git", "node", "python", "react", "review", "sqlite", "testing", "typescript"],
    roles: ["implementation", "review", "testing", "integration"],
    reliability: 0.82,
    costPerMillionTokens: null,
    active: true,
    maxConcurrentRuns: 2,
  },
];

export function App(): React.ReactElement {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [active, setActive] = useState<ProjectView | null>(null);
  const [view, setView] = useState<MainView>("board");
  const [selectedWorkItemId, setSelectedWorkItemId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddWork, setShowAddWork] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showAddDependency, setShowAddDependency] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [planningProjectIds, setPlanningProjectIds] = useState<Set<string>>(() => new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const activeProjectIdRef = useRef<string | null>(null);
  activeProjectIdRef.current = active?.state.project?.projectId ?? null;

  const applyProjectUpdate = useCallback((updated: ProjectView) => {
    const updatedId = updated.state.project?.projectId;
    if (!updatedId) return;
    setProjects((current) => {
      const exists = current.some((candidate) => candidate.state.project?.projectId === updatedId);
      return exists
        ? current.map((candidate) => candidate.state.project?.projectId === updatedId ? updated : candidate)
        : [...current, updated];
    });
    setActive((current) => current?.state.project?.projectId === updatedId ? updated : current);
  }, []);

  const reloadProject = useCallback(async () => {
    const projectId = active?.state.project?.projectId;
    if (!projectId) return;
    try {
      const fresh = await getProject(projectId);
      applyProjectUpdate(fresh);
    } catch (reason) {
      setError(readReason(reason));
    }
  }, [active?.state.project?.projectId, applyProjectUpdate]);

  const stream = useProjectStream(active?.state.project?.projectId ?? null, reloadProject);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await listProjects();
        setProjects(loaded);
        setActive(loaded[0] ?? null);
      } catch (reason) {
        setError(readReason(reason));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (loading) return;
    const timer = window.setInterval(() => {
      void listProjects().then((loaded) => {
        setProjects(loaded);
        setActive((current) => {
          const currentId = current?.state.project?.projectId;
          return loaded.find((candidate) => candidate.state.project?.projectId === currentId) ?? loaded[0] ?? null;
        });
      }).catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [loading]);

  if (loading) return <CenteredMessage title="正在连接 KanOrch runtime…" />;
  if (!active) {
    return (
      <ProjectSetup
        error={error}
        onCreated={(project) => {
          setProjects([project]);
          setActive(project);
          setError(null);
        }}
      />
    );
  }

  const state = active.state;
  const project = state.project;
  if (!project) return <CenteredMessage title="项目投影无效" detail="缺少 Project 根实体。" />;
  const pendingDecisions = Object.values(state.decisions).filter((decision) => decision.status === "pending");
  const selectedItem = selectedWorkItemId ? state.workItems[selectedWorkItemId] ?? null : null;
  const planning = planningProjectIds.has(project.projectId);
  const selectProject = (projectId: string) => {
    const next = projects.find((candidate) => candidate.state.project?.projectId === projectId);
    if (!next) return;
    setActive(next);
    setSelectedWorkItemId(null);
    setError(null);
    setNotice(null);
    void getProject(projectId).then(applyProjectUpdate).catch((reason) => setError(readReason(reason)));
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">K</span><strong>KanOrch</strong></div>
        <label className="project-picker">
          <span className="sr-only">当前项目</span>
          <select
            value={project.projectId}
            onChange={(event) => selectProject(event.target.value)}
          >
            {projects.map((candidate) => (
              <option key={candidate.state.project?.projectId} value={candidate.state.project?.projectId}>
                {candidate.state.project?.name} · {projectPresence(candidate, project.projectId, planningProjectIds).label}
              </option>
            ))}
          </select>
        </label>
        <button className="new-project-button" type="button" onClick={() => setShowCreateProject(true)}>＋ 新建项目</button>
        <div className="goal-line"><strong>{project.name}</strong><span>{project.goal}</span></div>
        <div className={`connection ${stream.connected ? "online" : "offline"}`}>
          <span className="status-dot" />{stream.connected ? "实时连接" : "正在重连"} · r{active.revision}
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <ProjectWorkspace
            projects={projects}
            activeProjectId={project.projectId}
            planningProjectIds={planningProjectIds}
            onSelect={selectProject}
            onCreate={() => setShowCreateProject(true)}
          />
          <div className="sidebar-divider" />
          <NavButton active={view === "board"} onClick={() => setView("board")}>项目看板</NavButton>
          <NavButton active={view === "graph"} onClick={() => setView("graph")}>依赖图</NavButton>
          <NavButton active={view === "agents"} onClick={() => setView("agents")}>Agents</NavButton>
          <NavButton active={view === "quality"} onClick={() => setView("quality")}>质量证据</NavButton>
          <NavButton active={view === "budget"} onClick={() => setView("budget")}>成本预算</NavButton>
          <NavButton active={view === "decisions"} onClick={() => setView("decisions")} count={pendingDecisions.length}>决策台</NavButton>
        </aside>

        <main className="main-area">
          {error ? <div className="error-banner" role="alert">{error}<button type="button" onClick={() => setError(null)}>关闭</button></div> : null}
          {notice ? <div className="notice-banner" role="status">{notice}<button type="button" onClick={() => setNotice(null)}>关闭</button></div> : null}
          <div className="section-head">
            <div><h1>{viewTitle(view)}</h1><p>{viewSubtitle(view, state)}</p></div>
            {view === "board" ? <div className="section-actions"><button
              className="primary-button"
              type="button"
              disabled={planning || !canGeneratePlan(state)}
              title={planningBlockReason(state)}
              onClick={() => {
                const requestedProjectId = project.projectId;
                setPlanningProjectIds((current) => new Set(current).add(requestedProjectId));
                setError(null);
                setNotice(null);
                void planProject(requestedProjectId, active.revision)
                  .then((result) => {
                    applyProjectUpdate(result.project);
                    if (activeProjectIdRef.current !== requestedProjectId) return;
                    if (result.status === "planned") {
                      setNotice(`已生成 ${result.plan?.workItems.length ?? 0} 个工作项和 ${result.plan?.dependencies.length ?? 0} 条依赖，入口任务已进入 Ready。`);
                    } else {
                      const decision = result.decisionId ? result.project.state.decisions[result.decisionId] : null;
                      const detail = result.attempts.at(-1) ?? decision?.currentState ?? "规划或独立审查未完成";
                      setNotice(`规划已暂停：${detail}`);
                      setView("decisions");
                    }
                  })
                  .catch((reason) => {
                    if (activeProjectIdRef.current === requestedProjectId) setError(readReason(reason));
                  })
                  .finally(() => setPlanningProjectIds((current) => {
                    const next = new Set(current);
                    next.delete(requestedProjectId);
                    return next;
                  }));
              }}
            >{planning ? "Agent 正在规划…" : "从项目目标生成 DAG"}</button><button type="button" onClick={() => setShowImport(true)}>导入 K-now</button><button type="button" onClick={() => setShowAddWork(true)}>新增工作项</button></div> : null}
            {view === "graph" ? <div className="section-actions"><button className="primary-button" type="button" onClick={() => setShowAddDependency(true)}>新增依赖</button></div> : null}
          </div>

          {view === "board" ? (
            <Board state={state} selectedId={selectedWorkItemId} onSelect={setSelectedWorkItemId} />
          ) : null}
          {view === "graph" ? (
            <DependencyGraph state={state} selectedId={selectedWorkItemId} onSelect={setSelectedWorkItemId} />
          ) : null}
          {view === "agents" ? (
            <AgentCenter
              state={state}
              revision={active.revision}
              projectId={project.projectId}
              onSelectWorkItem={setSelectedWorkItemId}
              onUpdated={(result) => applyProjectUpdate({ revision: result.revision, state: result.state })}
              onError={(reason) => setError(readReason(reason))}
            />
          ) : null}
          {view === "quality" ? <QualityCenter state={state} /> : null}
          {view === "budget" ? <BudgetCenter state={state} /> : null}
          {view === "decisions" ? (
            <DecisionList
              decisions={pendingDecisions}
              revision={active.revision}
              projectId={project.projectId}
              onUpdated={(result) => applyProjectUpdate({ revision: result.revision, state: result.state })}
              onError={(reason) => setError(readReason(reason))}
            />
          ) : null}

          {selectedItem ? (
            <WorkInspector
              state={state}
              item={selectedItem}
              projectId={project.projectId}
              revision={active.revision}
              onUpdated={applyProjectUpdate}
              onError={(reason) => setError(readReason(reason))}
              onClose={() => setSelectedWorkItemId(null)}
            />
          ) : null}
        </main>

        <aside className="decision-rail">
          <div className="rail-head"><div><h2>等待你决定</h2><p>其他环节继续自动运行</p></div><span>{pendingDecisions.length}</span></div>
          {pendingDecisions.length === 0 ? <EmptyState title="没有待决策事项" detail="偏移、失败、预算或权限风险出现时会集中到这里。" /> : (
            <DecisionList
              decisions={pendingDecisions}
              revision={active.revision}
              projectId={project.projectId}
              compact
              onUpdated={(result) => applyProjectUpdate({ revision: result.revision, state: result.state })}
              onError={(reason) => setError(readReason(reason))}
            />
          )}
        </aside>
      </div>

      {showAddWork ? (
        <AddWorkDialog
          projectId={project.projectId}
          revision={active.revision}
          state={state}
          onClose={() => setShowAddWork(false)}
          onAdded={(result) => {
            applyProjectUpdate({ revision: result.revision, state: result.state });
            setShowAddWork(false);
          }}
          onError={(reason) => setError(readReason(reason))}
        />
      ) : null}
      {showImport ? (
        <ImportKNowDialog
          projectId={project.projectId}
          revision={active.revision}
          onClose={() => setShowImport(false)}
          onImported={(result) => {
            applyProjectUpdate({ revision: result.revision, state: result.state });
            setShowImport(false);
          }}
          onError={(reason) => setError(readReason(reason))}
        />
      ) : null}
      {showAddDependency ? (
        <AddDependencyDialog
          projectId={project.projectId}
          revision={active.revision}
          state={state}
          onClose={() => setShowAddDependency(false)}
          onAdded={(result) => {
            applyProjectUpdate({ revision: result.revision, state: result.state });
            setShowAddDependency(false);
          }}
          onError={(reason) => setError(readReason(reason))}
        />
      ) : null}
      {showCreateProject ? (
        <ProjectSetup
          error={null}
          onCancel={() => setShowCreateProject(false)}
          onCreated={(created) => {
            applyProjectUpdate(created);
            setActive(created);
            setSelectedWorkItemId(null);
            setShowCreateProject(false);
            setView("board");
            setNotice("新项目已创建；若目录为空，KanOrch 已初始化 Git 仓库与首个提交。");
          }}
        />
      ) : null}
    </div>
  );
}

function ProjectWorkspace({
  projects,
  activeProjectId,
  planningProjectIds,
  onSelect,
  onCreate,
}: {
  projects: ProjectView[];
  activeProjectId: string;
  planningProjectIds: Set<string>;
  onSelect: (projectId: string) => void;
  onCreate: () => void;
}) {
  return <section className="project-workspace" aria-label="项目工作区">
    <header><span>项目工作区</span><button type="button" onClick={onCreate} aria-label="新建项目">＋</button></header>
    <div className="project-roster">{projects.map((candidate) => {
      const candidateId = candidate.state.project?.projectId;
      if (!candidateId) return null;
      const presence = projectPresence(candidate, activeProjectId, planningProjectIds);
      return <button
        className={`project-entry ${candidateId === activeProjectId ? "active" : ""}`}
        type="button"
        key={candidateId}
        onClick={() => onSelect(candidateId)}
      >
        <span className={`status-dot project-${presence.kind}`} />
        <span className="project-entry-copy"><strong>{candidate.state.project?.name}</strong><small>{presence.label}</small></span>
      </button>;
    })}</div>
  </section>;
}

function NavButton({ active, count, onClick, children }: { active: boolean; count?: number; onClick: () => void; children: React.ReactNode }) {
  return <button className={active ? "active" : ""} type="button" onClick={onClick}>{children}{count ? <span className="nav-count">{count}</span> : null}</button>;
}

function Board({ state, selectedId, onSelect }: { state: ProjectState; selectedId: string | null; onSelect: (id: string) => void }) {
  const items = Object.values(state.workItems);
  return (
    <div className="board">
      {BOARD_COLUMNS.map((column) => {
        const cards = items.filter((item) => item.ownStatus === column.status);
        return (
          <section className="board-column" key={column.status}>
            <header><span>{column.label}</span><span>{cards.length}</span></header>
            {cards.map((item) => (
              <button className={`work-card ${selectedId === item.workItemId ? "selected" : ""}`} type="button" key={item.workItemId} onClick={() => onSelect(item.workItemId)}>
                <span className="card-id">{item.workItemId} · depth {item.decompositionDepth}</span>
                <strong>{item.title}</strong>
                <span className="card-meta">{item.kind} · {item.origin === "k-now" ? "K-now history · " : ""}{item.requiredCapabilities.join(", ") || "no capability constraint"}</span>
              </button>
            ))}
            {cards.length === 0 ? <span className="column-empty">—</span> : null}
          </section>
        );
      })}
    </div>
  );
}

function DependencyGraph({ state, selectedId, onSelect }: { state: ProjectState; selectedId: string | null; onSelect: (id: string) => void }) {
  const items = Object.values(state.workItems);
  if (items.length === 0) return <EmptyState title="暂无依赖图" detail="新增工作项和依赖后，调度阻塞链会显示在这里。" />;
  const layout = layoutGraph(items, Object.values(state.dependencies));
  return (
    <div className="graph-wrap">
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label="项目任务依赖图">
        <defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
        {layout.edges.map((edge) => <line key={edge.id} x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} markerEnd="url(#arrow)" />)}
        {layout.nodes.map((node) => (
          <g key={node.item.workItemId} className={selectedId === node.item.workItemId ? "selected" : ""} onClick={() => onSelect(node.item.workItemId)} role="button" aria-label={node.item.title}>
            <rect x={node.x} y={node.y} width="176" height="66" rx="8" />
            <text x={node.x + 12} y={node.y + 25}>{trimLabel(node.item.title, 22)}</text>
            <text className="node-meta" x={node.x + 12} y={node.y + 47}>{node.item.workItemId} · {node.item.ownStatus}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function AgentCenter({
  state,
  projectId,
  revision,
  onSelectWorkItem,
  onUpdated,
  onError,
}: {
  state: ProjectState;
  projectId: string;
  revision: number;
  onSelectWorkItem: (workItemId: string) => void;
  onUpdated: (result: { revision: number; state: ProjectState }) => void;
  onError: (error: unknown) => void;
}) {
  const [registering, setRegistering] = useState<string | null>(null);
  const agents = Object.values(state.agents);
  const missing = DEFAULT_AGENT_PROFILES.filter((profile) => !state.agents[profile.agentId]);
  const terminals = Object.values(state.runs).filter((run) => run.mode === "terminal" && ["queued", "starting", "running", "waiting_approval"].includes(run.status));
  return <div className="stacked-section">
    <section aria-label="交互终端工作区">
      <h2>交互终端工作区 · {terminals.length} 个活动会话</h2>
      {terminals.length ? <div className="terminal-workspace">{terminals.map((run) => <article className="terminal-workspace-card" key={run.runId}>
        <header><div><strong>{state.agents[run.agentId]?.displayName ?? run.agentId}</strong><span>{run.role} · {run.workItemId} · {state.workItems[run.workItemId]?.title ?? "工作项"}</span></div><button type="button" onClick={() => onSelectWorkItem(run.workItemId)}>查看任务</button></header>
        <TerminalPane projectId={projectId} runId={run.runId} />
      </article>)}</div> : <p className="muted">从看板的 Ready 工作项开启交互终端后，会话会出现在这里。</p>}
    </section>
    {missing.length ? <div className="adapter-actions"><span>注册本机 CLI 适配器</span>{missing.map((profile) => <button
      type="button"
      key={profile.agentId}
      disabled={registering !== null}
      onClick={() => {
        setRegistering(profile.agentId);
        void registerAgent(projectId, revision, profile)
          .then(onUpdated)
          .catch(onError)
          .finally(() => setRegistering(null));
      }}
    >{registering === profile.agentId ? "注册中…" : profile.displayName}</button>)}</div> : null}
    {agents.length === 0 ? <EmptyState title="尚未注册 Agent" detail="注册 Codex、Claude Code 或 OpenCode 的能力档案后，调度器才能选择执行者。" /> : <div className="data-list">{agents.map((agent) => {
      const activeRuns = Object.values(state.runs).filter((run) => run.agentId === agent.agentId && ["queued", "starting", "running", "waiting_approval"].includes(run.status));
      const completedRuns = Object.values(state.runs).filter((run) => run.agentId === agent.agentId && ["succeeded", "failed", "cancelled"].includes(run.status));
      return <article key={agent.agentId}><div><strong>{agent.displayName}</strong><span>{agent.adapterKind} · {agent.roles.join(", ")} · reliability {Math.round(agent.reliability * 100)}%</span></div><div className="list-end"><span className={`status-dot ${agent.active ? "online" : "offline"}`} />{activeRuns.length ? `${activeRuns.length} 个运行` : `空闲 · ${completedRuns.length} 次完成`}</div></article>;
    })}</div>}
  </div>;
}

function QualityCenter({ state }: { state: ProjectState }) {
  const evidence = Object.values(state.evidence).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const reports = Object.keys(state.workItems).sort().map((workItemId) => evaluateQualityGates(state, workItemId));
  if (evidence.length === 0 && reports.length === 0) return <EmptyState title="尚无质量证据" detail="独立审查、测试和集成运行完成后，其证据和门禁结论会显示在这里。" />;
  return <div className="stacked-section">
    <div className="gate-grid">{reports.map((report) => <article key={report.workItemId} className={report.passed ? "gate-pass" : "gate-blocked"}><header><strong>{report.workItemId} · {state.workItems[report.workItemId]?.title}</strong><span>{report.passed ? "可完成" : "门禁未通过"}</span></header><ul>{report.checks.map((check) => <li key={check.key} className={check.passed ? "pass" : "fail"}>{check.passed ? "✓" : "×"} {check.summary}</li>)}</ul></article>)}</div>
    <div className="data-list">{evidence.map((entry) => <article key={entry.evidenceId}><div><strong>{entry.kind} · {entry.summary}</strong><span>{entry.producerAgentId} · run {entry.runId}{entry.imported ? " · imported" : ""}</span></div><div className={`list-end verdict-${entry.verdict}`}>{entry.verdict} · {entry.artifactIds.length} artifacts</div></article>)}</div>
  </div>;
}

function BudgetCenter({ state }: { state: ProjectState }) {
  const policy = state.project?.policy;
  const budget = state.project?.budget;
  const entries = Object.values(state.budgetEntries);
  const totals = calculateBudgetTotals(entries);
  return <div className="policy-grid">
    <Policy label="输入 tokens" value={totals.inputTokens.toLocaleString()} limit={formatLimit(budget?.maxInputTokens, "")} />
    <Policy label="输出 tokens" value={totals.outputTokens.toLocaleString()} limit={formatLimit(budget?.maxOutputTokens, "")} />
    <Policy label="实际成本" value={`$${totals.costUsd.toFixed(4)}`} limit={formatLimit(budget?.maxCostUsd, "$")} />
    <Policy label="运行时间" value={`${totals.wallClockSeconds.toFixed(1)}s`} limit={formatLimit(budget?.maxWallClockSeconds, "", "s")} />
    <Policy label="阶段重试" value={policy?.maxAttemptsPerStage ?? 0} />
    <Policy label="任务拆解深度" value={policy?.maxDecompositionDepth ?? 0} />
    <Policy label="Agent 委派深度" value={policy?.maxAgentDelegationDepth ?? 0} />
    <Policy label="后规划深度" value={policy?.maxReplanDepth ?? 0} />
    {entries.length === 0 ? <EmptyState title="尚无用量记录" detail="AgentRun 开始后记录 token、时间和金额的预留与实际消耗。" /> : <div className="budget-table">{entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map((entry) => <div key={entry.budgetEntryId}><span>{entry.workItemId} · {entry.runId}</span><span>{entry.inputTokens + entry.outputTokens} tokens</span><span>${entry.costUsd.toFixed(4)}</span><span>{entry.wallClockSeconds.toFixed(1)}s</span></div>)}</div>}
  </div>;
}

function Policy({ label, value, limit }: { label: string; value: string | number; limit?: string }) {
  return <div className="policy-cell"><span>{label}</span><strong>{value}</strong>{limit ? <small>limit {limit}</small> : null}</div>;
}

function DecisionList({ decisions, projectId, revision, compact = false, onUpdated, onError }: { decisions: DecisionRequest[]; projectId: string; revision: number; compact?: boolean; onUpdated: (result: { revision: number; state: ProjectState }) => void; onError: (error: unknown) => void }) {
  if (decisions.length === 0) return <EmptyState title="没有待决策事项" detail="系统会继续自动推进。" />;
  return <div className={`decision-list ${compact ? "compact" : ""}`}>{decisions.map((decision) => <DecisionCard key={decision.decisionId} decision={decision} projectId={projectId} revision={revision} onUpdated={onUpdated} onError={onError} />)}</div>;
}

function DecisionCard({ decision, projectId, revision, onUpdated, onError }: { decision: DecisionRequest; projectId: string; revision: number; onUpdated: (result: { revision: number; state: ProjectState }) => void; onError: (error: unknown) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  return <article className="decision-card">
    <span className="decision-trigger">{decision.trigger} · {decision.decisionId}</span>
    <h3>{decision.bottleneck}</h3>
    <p>{decision.currentState}</p>
    <dl><div><dt>架构</dt><dd>{decision.architectureSummary}</dd></div><div><dt>影响</dt><dd>{decision.affectedWorkItemIds.join(", ") || "项目级"}</dd></div></dl>
    <div className="decision-options">{decision.options.map((option) => <button type="button" className={selected === option.optionId ? "selected" : ""} key={option.optionId} onClick={() => setSelected(option.optionId)}><strong>{option.title}{option.optionId === decision.recommendedOptionId ? " · 推荐" : ""}</strong><span>{option.description}</span></button>)}</div>
    <button className="primary-button full" type="button" disabled={!selected || submitting} onClick={() => {
      if (!selected) return;
      setSubmitting(true);
      void resolveDecision(projectId, decision.decisionId, selected, revision).then(onUpdated).catch(onError).finally(() => setSubmitting(false));
    }}>{submitting ? "正在记录…" : "批准所选方案"}</button>
  </article>;
}

function WorkInspector({
  state,
  item,
  projectId,
  revision,
  onUpdated,
  onError,
  onClose,
}: {
  state: ProjectState;
  item: WorkItem;
  projectId: string;
  revision: number;
  onUpdated: (project: ProjectView) => void;
  onError: (error: unknown) => void;
  onClose: () => void;
}) {
  const runs = runsFor(state, item.workItemId).sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""));
  const [selectedRunId, setSelectedRunId] = useState<string | null>(runs[0]?.runId ?? null);
  const [runEvents, setRunEvents] = useState<StoredEvent[]>([]);
  const [artifactPreview, setArtifactPreview] = useState<{ title: string; content: string } | null>(null);
  const [role, setRole] = useState<FunctionalRole>("implementation");
  const [agentId, setAgentId] = useState("");
  const [allowedRoles, setAllowedRoles] = useState<FunctionalRole[]>(item.allowedRoles);
  const [busy, setBusy] = useState(false);
  useEffect(() => setAllowedRoles(item.allowedRoles), [item.workItemId, item.allowedRoles.join(",")]);
  const selectedRun = runs.find((run) => run.runId === selectedRunId) ?? null;
  const artifacts = Object.values(state.artifacts).filter((artifact) => artifact.workItemId === item.workItemId);
  const evidence = Object.values(state.evidence).filter((entry) => entry.workItemId === item.workItemId);
  const handoffs = Object.values(state.handoffs).filter((message) => message.workItemId === item.workItemId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const recipients = Object.values(state.agents).filter((agent) => agent.active && agent.agentId !== selectedRun?.agentId);
  const eligibleAgents = Object.values(state.agents).filter((agent) => agent.active && agent.roles.includes(role));
  const selectedAgent = eligibleAgents.find((agent) => agent.agentId === agentId) ?? eligibleAgents[0];

  useEffect(() => {
    if (!selectedRunId) {
      setRunEvents([]);
      return;
    }
    let active = true;
    const load = () => void getRunEvents(projectId, selectedRunId).then((events) => {
      if (active) setRunEvents(events);
    }).catch(onError);
    load();
    const isRunning = selectedRun && ["queued", "starting", "running", "waiting_approval"].includes(selectedRun.status);
    const timer = isRunning ? window.setInterval(load, 1_000) : null;
    return () => {
      active = false;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [projectId, selectedRunId, selectedRun?.status]);

  const latestImplementation = runs.find((run) => run.role === "implementation" && run.status === "succeeded");
  const verifiedImplementation = runs.find((run) => run.role === "implementation" && run.status === "succeeded" && evaluateQualityGates(state, item.workItemId, run.runId).passed);
  return <section className="inspector">
    <header><div><span>{item.workItemId} · {item.ownStatus} · scopes {item.codeScopes.join(", ")}</span><h2>{item.title}</h2></div><button type="button" onClick={onClose}>关闭</button></header>
    <p>{item.description}</p>
    <div className="inspector-actions">
      <button className="primary-button" type="button" disabled={busy || ["done", "cancelled", "running"].includes(item.ownStatus) || !hasDeliveryCrew(state)} onClick={() => {
        setBusy(true);
        void deliverWorkItem(projectId, item.workItemId, revision)
          .then((result) => onUpdated(result.project))
          .catch(onError)
          .finally(() => setBusy(false));
      }}>{busy ? "自动交付中…" : hasDeliveryCrew(state) ? "自动实现 → 审查 → 测试 → 合并" : "需注册实现/审查/测试 Agent"}</button>
      {verifiedImplementation && state.project?.policy.autoMerge && !["done", "cancelled"].includes(item.ownStatus) ? <button type="button" disabled={busy} onClick={() => {
        setBusy(true);
        void integrateVerifiedWorkItem(projectId, item.workItemId, revision, verifiedImplementation.runId)
          .then((result) => onUpdated(result.project)).catch(onError).finally(() => setBusy(false));
      }}>合并已验证实现</button> : null}
      {item.ownStatus !== "ready" && !["running", "done", "cancelled"].includes(item.ownStatus) ? <button type="button" disabled={busy} onClick={() => {
        setBusy(true);
        void changeWorkItemStatus(projectId, item.workItemId, "ready", revision)
          .then((result) => onUpdated({ revision: result.revision, state: result.state }))
          .catch(onError)
          .finally(() => setBusy(false));
      }}>标记为 Ready</button> : null}
      <select value={role} onChange={(event) => setRole(event.target.value as FunctionalRole)} aria-label="运行阶段">
        {(["planning", "architecture", "implementation", "review", "testing", "integration"] as FunctionalRole[]).map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
      </select>
      <select value={selectedAgent?.agentId ?? ""} onChange={(event) => setAgentId(event.target.value)} aria-label="执行 Agent">
        {eligibleAgents.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.displayName}</option>)}
      </select>
      <button className="primary-button" type="button" disabled={busy || item.ownStatus !== "ready" || eligibleAgents.length === 0} onClick={() => {
        const agent = selectedAgent;
        if (!agent) return;
        setBusy(true);
        const prompt = [
          `Work item ${item.workItemId}: ${item.title}`,
          item.description,
          "Acceptance criteria:",
          ...item.acceptanceCriteria.map((criterion) => `- ${criterion}`),
          `Allowed code scopes: ${item.codeScopes.join(", ")}`,
        ].join("\n");
        void executeAgentRun(projectId, item.workItemId, revision, {
          role,
          prompt,
          permissionMode: "workspace-auto",
          agentId: agent.agentId,
          baseRef: role === "implementation" ? undefined : latestImplementation?.branchName,
          subjectRunId: role === "review" ? latestImplementation?.runId ?? null : null,
        }).then((result) => onUpdated(result.project)).catch(onError).finally(() => setBusy(false));
      }}>{busy ? "运行中…" : eligibleAgents.length ? `运行 ${role}` : "没有匹配 Agent"}</button>
      <button type="button" disabled={busy || item.ownStatus !== "ready" || !selectedAgent || selectedAgent.adapterKind === "external"} onClick={() => {
        if (!selectedAgent) return;
        setBusy(true);
        void startAgentTerminal(projectId, item.workItemId, revision, { agentId: selectedAgent.agentId, role })
          .then((result) => { onUpdated(result.project); setSelectedRunId(result.terminal.runId); })
          .catch(onError).finally(() => setBusy(false));
      }}>开启交互终端</button>
    </div>
    <h3>验收条件</h3><ul>{item.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
    <details><summary>允许的 Agent 角色</summary><p className="muted">不选表示不限角色；活动运行或已完成任务不可修改。</p>
      <div className="inspector-actions">{(["planning", "architecture", "implementation", "review", "testing", "integration", "monitoring"] as FunctionalRole[]).map((candidate) =>
        <label key={candidate}><input type="checkbox" checked={allowedRoles.includes(candidate)} onChange={(event) => setAllowedRoles((current) => event.target.checked ? [...current, candidate] : current.filter((role) => role !== candidate))} />{candidate}</label>)}</div>
      <button type="button" disabled={busy || ["running", "done", "cancelled"].includes(item.ownStatus)} onClick={() => {
        setBusy(true);
        void setWorkItemRoles(projectId, item.workItemId, allowedRoles, revision)
          .then((result) => onUpdated({ revision: result.revision, state: result.state }))
          .catch(onError).finally(() => setBusy(false));
      }}>保存角色</button>
    </details>
    <div className="inspector-grid">
      <div><h3>Agent Runs</h3>{runs.length ? runs.map((run) => <button className={`run-row ${selectedRunId === run.runId ? "selected" : ""}`} type="button" key={run.runId} onClick={() => setSelectedRunId(run.runId)}><strong>{run.role} · {run.agentId}</strong><span>{run.status} · attempt {run.attempt}</span></button>) : <p className="muted">尚未创建运行。</p>}
        {selectedRun?.mode !== "terminal" && selectedRun && ["queued", "starting", "running", "waiting_approval"].includes(selectedRun.status)
          ? <div className="inspector-actions"><button type="button" onClick={() => { void cancelAgentRun(projectId, selectedRun.runId).catch(onError); }}>停止批量运行</button></div>
          : null}
      </div>
      <div><h3>{selectedRun?.mode === "terminal" ? "交互终端" : "运行日志"}</h3>{selectedRun?.mode === "terminal" ? <><TerminalPane projectId={projectId} runId={selectedRun.runId} /><details><summary>持久运行记录</summary><pre className="terminal-log">{runEvents.map(formatRunEvent).join("\n")}</pre></details></> : selectedRun ? <pre className="terminal-log">{runEvents.length ? runEvents.map(formatRunEvent).join("\n") : "正在等待运行事件…"}</pre> : <p className="muted">选择一个 AgentRun 查看日志。</p>}</div>
    </div>
    <h3>Agent 交接</h3>
    <p className="muted">接收运行需用专属凭据取回工件并确认。确认只证明该运行发出请求，不证明其理解内容。</p>
    {handoffs.length ? <div className="artifact-list">{handoffs.map((message) => <div key={message.messageId}><strong>{message.kind} · {state.agents[state.runs[message.sourceRunId]?.agentId ?? ""]?.displayName ?? message.sourceRunId} → {state.agents[message.recipientAgentId]?.displayName ?? message.recipientAgentId}</strong><p>{message.summary}</p><span>{message.artifactIds.length} 个工件 · {message.acknowledgedAt ? `运行 ${message.acknowledgedByRunId} 已确认领取 · ${message.acknowledgedAt}` : "待领取确认"} · {message.createdAt}</span></div>)}</div> : <p className="muted">尚无交接。</p>}
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!selectedRun) return;
      const form = event.currentTarget;
      const data = new FormData(form);
      setBusy(true);
      void recordAgentHandoff(projectId, revision, {
        workItemId: item.workItemId,
        sourceRunId: selectedRun.runId,
        recipientAgentId: String(data.get("recipientAgentId") ?? ""),
        kind: String(data.get("kind") ?? "handoff") as "handoff" | "blocker" | "review_request",
        summary: String(data.get("summary") ?? ""),
        artifactIds: data.getAll("artifactId").map(String),
      }).then((result) => { onUpdated({ revision: result.revision, state: result.state }); form.reset(); })
        .catch(onError).finally(() => setBusy(false));
    }}>
      <div className="inspector-actions"><select name="recipientAgentId" aria-label="接收 Agent" required>{recipients.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.displayName}</option>)}</select><select name="kind" aria-label="交接类型"><option value="handoff">交接</option><option value="blocker">阻塞</option><option value="review_request">请求审查</option></select></div>
      <label>交接摘要<textarea name="summary" required maxLength={10000} rows={3} /></label>
      {artifacts.filter((artifact) => artifact.runId === selectedRun?.runId).map((artifact) => <label key={artifact.artifactId}><input type="checkbox" name="artifactId" value={artifact.artifactId} />{artifact.kind} · {artifact.relativePath}</label>)}
      <button type="submit" disabled={busy || !selectedRun || recipients.length === 0}>记录交接</button>
    </form>
    <h3>改动、diff 与证据</h3>
    <div className="artifact-list">{artifacts.map((artifact) => <button type="button" key={artifact.artifactId} onClick={() => {
      void getArtifactText(projectId, artifact.artifactId).then((content) => setArtifactPreview({ title: `${artifact.kind} · ${artifact.relativePath}`, content })).catch(onError);
    }}><strong>{artifact.kind}</strong><span>{artifact.byteLength.toLocaleString()} bytes · {artifact.contentHash.slice(0, 12)}</span></button>)}{artifacts.length === 0 ? <span className="muted">尚无运行产物。</span> : null}</div>
    {artifactPreview ? <div className="artifact-preview"><header><strong>{artifactPreview.title}</strong><button type="button" onClick={() => setArtifactPreview(null)}>关闭</button></header><pre>{artifactPreview.content || "（空内容）"}</pre></div> : null}
    {evidence.length ? <div className="evidence-strip">{evidence.map((entry) => <span key={entry.evidenceId} className={`verdict-${entry.verdict}`}>{entry.kind}: {entry.verdict} · {entry.producerAgentId}</span>)}</div> : null}
  </section>;
}

function ProjectSetup({
  error,
  onCreated,
  onCancel,
}: {
  error: string | null;
  onCreated: (project: ProjectView) => void;
  onCancel?: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const isDialog = Boolean(onCancel);
  const card = <section className={isDialog ? "dialog project-setup-dialog" : "setup-card"} role={isDialog ? "dialog" : undefined} aria-modal={isDialog ? "true" : undefined} aria-labelledby="project-setup-title">
    {isDialog ? <header><div><h2 id="project-setup-title">新建 KanOrch 项目</h2><p className="muted">创建后，其他项目继续在后台运行或保持待命。</p></div><button type="button" onClick={onCancel}>关闭</button></header> : <><span className="brand-mark large">K</span><h1 id="project-setup-title">创建第一个 KanOrch 项目</h1></>}
    <p className="project-setup-copy">输入人工目标；后续拆解、分配、实现、审查和测试由控制平面推进。路径不存在或为空时，KanOrch 会安全初始化 Git 和首个空提交。</p>
    {error || localError ? <div className="error-banner" role="alert">{error ?? localError}</div> : null}
    <form onSubmit={(event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    setSubmitting(true);
    setLocalError(null);
    void createProject({
      projectId: slug(name),
      name,
      repositoryPath: String(data.get("repositoryPath") ?? ""),
      baseBranch: String(data.get("baseBranch") ?? "main"),
      goal: String(data.get("goal") ?? ""),
      policy: {
        maxAttemptsPerStage: Number(data.get("maxAttemptsPerStage")),
        maxDecompositionDepth: Number(data.get("maxDecompositionDepth")),
        maxAgentDelegationDepth: Number(data.get("maxAgentDelegationDepth")),
        maxReplanDepth: Number(data.get("maxReplanDepth")),
      },
      budget: {
        maxInputTokens: optionalNumber(data.get("maxInputTokens")),
        maxOutputTokens: optionalNumber(data.get("maxOutputTokens")),
        maxCostUsd: optionalNumber(data.get("maxCostUsd")),
        maxWallClockSeconds: optionalNumber(data.get("maxWallClockSeconds")),
      },
    }).then((result) => onCreated({ revision: result.revision, state: result.state })).catch((reason) => setLocalError(readReason(reason))).finally(() => setSubmitting(false));
  }}><label>项目名称<input name="name" required defaultValue={isDialog ? "" : "KanOrch"} placeholder="例如 history+map" /></label><label>本地仓库路径<input name="repositoryPath" required placeholder="C:\workspace\project" /></label><label>目标分支<input name="baseBranch" required defaultValue="main" /></label><label>项目目标<textarea name="goal" required rows={5} placeholder="描述希望交付的结果与成功标准" /></label><details><summary>自动化深度、重试与预算</summary><div className="advanced-grid"><label>每阶段最多尝试<input name="maxAttemptsPerStage" type="number" min="1" step="1" defaultValue="3" required /></label><label>任务拆解深度<input name="maxDecompositionDepth" type="number" min="0" step="1" defaultValue="4" required /></label><label>Agent 委派深度<input name="maxAgentDelegationDepth" type="number" min="0" step="1" defaultValue="2" required /></label><label>后规划深度<input name="maxReplanDepth" type="number" min="0" step="1" defaultValue="2" required /></label><label>输入 token 上限<input name="maxInputTokens" type="number" min="0" step="1" placeholder="不限" /></label><label>输出 token 上限<input name="maxOutputTokens" type="number" min="0" step="1" placeholder="不限" /></label><label>成本上限 USD<input name="maxCostUsd" type="number" min="0" step="0.01" placeholder="不限" /></label><label>运行秒数上限<input name="maxWallClockSeconds" type="number" min="0" step="1" placeholder="不限" /></label></div></details><p className="form-hint">非空且尚未初始化 Git 的目录不会被自动提交；请先人工检查并建立首个提交。</p><button className="primary-button full" disabled={submitting}>{submitting ? "正在创建…" : "创建项目"}</button></form>
  </section>;
  return isDialog ? <div className="dialog-backdrop" role="presentation">{card}</div> : <div className="setup-page">{card}</div>;
}

function ImportKNowDialog({
  projectId,
  revision,
  onClose,
  onImported,
  onError,
}: {
  projectId: string;
  revision: number;
  onClose: () => void;
  onImported: (result: { revision: number; state: ProjectState }) => void;
  onError: (error: unknown) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  return <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="import-k-now-title"><header><div><h2 id="import-k-now-title">导入 K-now 历史</h2><p className="muted">卡片、模型和证据会保留来源标记；历史证据不会通过 KanOrch 的新质量门禁。</p></div><button type="button" onClick={onClose}>关闭</button></header><form onSubmit={(event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    void importKNow(projectId, revision, String(form.get("sourcePath")))
      .then(onImported)
      .catch(onError)
      .finally(() => setSubmitting(false));
  }}><label>K-now board JSON 绝对路径<input name="sourcePath" required placeholder="C:\workspace\project\.kanban\project.json" /></label><button className="primary-button full" disabled={submitting}>{submitting ? "正在导入…" : "导入为历史记录"}</button></form></section></div>;
}

function AddDependencyDialog({
  projectId,
  revision,
  state,
  onClose,
  onAdded,
  onError,
}: {
  projectId: string;
  revision: number;
  state: ProjectState;
  onClose: () => void;
  onAdded: (result: { revision: number; state: ProjectState }) => void;
  onError: (error: unknown) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const items = Object.values(state.workItems);
  return <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-dependency-title"><header><div><h2 id="add-dependency-title">新增任务依赖</h2><p className="muted">上游未 Done 前，blocks / produces 会阻止下游调度；有向环会被拒绝。</p></div><button type="button" onClick={onClose}>关闭</button></header>{items.length < 2 ? <EmptyState title="至少需要两个工作项" detail="先创建可连接的上游与下游任务。" /> : <form onSubmit={(event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    void addDependency(projectId, revision, {
      upstreamWorkItemId: String(form.get("upstreamWorkItemId")),
      downstreamWorkItemId: String(form.get("downstreamWorkItemId")),
      kind: String(form.get("kind")) as Dependency["kind"],
    }).then(onAdded).catch(onError).finally(() => setSubmitting(false));
  }}><label>上游工作项<select name="upstreamWorkItemId">{items.map((item) => <option key={item.workItemId} value={item.workItemId}>{item.workItemId} · {item.title}</option>)}</select></label><label>关系<select name="kind" defaultValue="blocks"><option value="blocks">blocks · 阻塞</option><option value="produces">produces · 产出供下游使用</option><option value="conflicts_with">conflicts_with · 代码冲突</option></select></label><label>下游工作项<select name="downstreamWorkItemId" defaultValue={items[1]?.workItemId}>{items.map((item) => <option key={item.workItemId} value={item.workItemId}>{item.workItemId} · {item.title}</option>)}</select></label><button className="primary-button full" disabled={submitting}>{submitting ? "正在保存…" : "创建依赖"}</button></form>}</section></div>;
}

function AddWorkDialog({ projectId, revision, state, onClose, onAdded, onError }: { projectId: string; revision: number; state: ProjectState; onClose: () => void; onAdded: (result: { revision: number; state: ProjectState }) => void; onError: (error: unknown) => void }) {
  const [submitting, setSubmitting] = useState(false);
  return <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-work-title"><header><h2 id="add-work-title">新增工作项</h2><button type="button" onClick={onClose}>关闭</button></header><form onSubmit={(event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    void addWorkItem(projectId, revision, {
      workItemId: String(form.get("workItemId")),
      parentWorkItemId: String(form.get("parentWorkItemId") || "") || null,
      kind: String(form.get("kind")) as WorkItem["kind"],
      title: String(form.get("title")),
      description: String(form.get("description")),
      acceptanceCriteria: String(form.get("acceptanceCriteria")).split("\n").map((value) => value.trim()).filter(Boolean),
      requiredCapabilities: String(form.get("capabilities")).split(",").map((value) => value.trim()).filter(Boolean),
      allowedRoles: ["implementation", "review", "testing"],
      codeScopes: String(form.get("codeScopes")).split(",").map((value) => value.trim()).filter(Boolean),
    }).then(onAdded).catch(onError).finally(() => setSubmitting(false));
  }}><label>ID<input name="workItemId" required placeholder="S-001" /></label><label>类型<select name="kind" defaultValue="task"><option value="goal">Goal</option><option value="epic">Epic</option><option value="story">Story</option><option value="task">Task</option><option value="bug">Bug</option></select></label><label>父工作项<select name="parentWorkItemId" defaultValue=""><option value="">无（顶层）</option>{Object.values(state.workItems).map((item) => <option key={item.workItemId} value={item.workItemId}>{item.workItemId} · {item.title}</option>)}</select></label><label>标题<input name="title" required /></label><label>描述<textarea name="description" rows={4} required /></label><label>验收条件（每行一条）<textarea name="acceptanceCriteria" rows={4} required /></label><label>所需能力（逗号分隔）<input name="capabilities" placeholder="typescript, sqlite" /></label><label>代码范围（逗号分隔）<input name="codeScopes" defaultValue="." placeholder="src/runtime, packages/domain" /></label><button className="primary-button full" disabled={submitting}>{submitting ? "正在保存…" : "创建工作项"}</button></form></section></div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) { return <div className="empty-state"><strong>{title}</strong><span>{detail}</span></div>; }
function CenteredMessage({ title, detail }: { title: string; detail?: string }) { return <div className="centered-message"><strong>{title}</strong>{detail ? <span>{detail}</span> : null}</div>; }
function runsFor(state: ProjectState, workItemId: string): AgentRun[] { return Object.values(state.runs).filter((run) => run.workItemId === workItemId); }
function viewTitle(view: MainView): string { return { board: "项目看板", graph: "任务依赖图", agents: "Agent 运行中心", quality: "质量证据", budget: "成本与预算", decisions: "决策台" }[view]; }
function viewSubtitle(view: MainView, state: ProjectState): string { const items = Object.values(state.workItems); if (view === "board") return `${items.filter((item) => item.ownStatus === "running").length} 项运行中 · ${items.filter((item) => item.ownStatus === "blocked").length} 项阻塞`; if (view === "graph") return `${Object.keys(state.dependencies).length} 条受调度器执行的依赖`; if (view === "agents") return `${Object.keys(state.agents).length} 个已注册 Agent`; if (view === "decisions") return `${Object.values(state.decisions).filter((decision) => decision.status === "pending").length} 项等待人工决定`; return "来自真实运行记录与项目策略"; }
function slug(value: string): string { return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `project-${Date.now()}`; }
function readReason(reason: unknown): string { if (reason instanceof ApiError || reason instanceof Error) return reason.message; return "发生未知错误"; }
function trimLabel(value: string, max: number): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
function formatLimit(value: number | null | undefined, prefix: string, suffix = ""): string { return value === null || value === undefined ? "unlimited" : `${prefix}${value.toLocaleString()}${suffix}`; }
function optionalNumber(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? "").trim();
  return text ? Number(text) : null;
}
function formatRunEvent(event: StoredEvent): string {
  const payload = event.payload as {
    occurredAt?: string;
    type?: string;
    message?: string;
    toolName?: string;
    providerEventType?: string;
  };
  const timestamp = payload.occurredAt ? new Date(payload.occurredAt).toLocaleTimeString() : `r${event.revision}`;
  const label = payload.type ?? event.eventType.replace(/^agent_run\./, "");
  const detail = payload.message ?? payload.toolName ?? payload.providerEventType ?? "";
  return `[${timestamp}] ${label}${detail ? ` · ${detail}` : ""}`;
}
function hasDeliveryCrew(state: ProjectState): boolean {
  const active = Object.values(state.agents).filter((agent) => agent.active);
  const hasImplementation = active.some((agent) => agent.roles.includes("implementation"));
  const hasTesting = active.some((agent) => agent.roles.includes("testing"));
  const hasIndependentReview = active.some(
    (reviewer) =>
      reviewer.roles.includes("review") &&
      active.some((implementer) => implementer.roles.includes("implementation") && implementer.agentId !== reviewer.agentId),
  );
  return hasImplementation && hasTesting && (!state.project?.policy.requireIndependentReview || hasIndependentReview);
}

function canGeneratePlan(state: ProjectState): boolean {
  const activeAgents = Object.values(state.agents).filter((agent) => agent.active);
  const hasPlannerPair = activeAgents.some(
    (planner) => planner.roles.includes("planning") && activeAgents.some((reviewer) => reviewer.agentId !== planner.agentId && reviewer.roles.includes("review")),
  );
  const hasNativeWork = Object.values(state.workItems).some(
    (item) => item.origin === "native" && item.workItemId !== "STREW-PLAN",
  );
  const pendingPlanDecision = Object.values(state.decisions).some(
    (decision) => decision.status === "pending" && (decision.workItemId === "STREW-PLAN" || decision.affectedWorkItemIds.includes("STREW-PLAN")),
  );
  return hasPlannerPair && !hasNativeWork && !pendingPlanDecision;
}

function planningBlockReason(state: ProjectState): string {
  const activeAgents = Object.values(state.agents).filter((agent) => agent.active);
  if (!activeAgents.some((agent) => agent.roles.includes("planning"))) return "请先在 Agent 运行中心注册 Codex 或 Claude Code 规划 Agent";
  if (!activeAgents.some((planner) => planner.roles.includes("planning") && activeAgents.some((reviewer) => reviewer.agentId !== planner.agentId && reviewer.roles.includes("review")))) return "请再注册一个不同身份的独立规划审查 Agent";
  if (Object.values(state.decisions).some((decision) => decision.status === "pending" && (decision.workItemId === "STREW-PLAN" || decision.affectedWorkItemIds.includes("STREW-PLAN")))) return "请先处理规划相关决策";
  if (Object.values(state.workItems).some((item) => item.origin === "native" && item.workItemId !== "STREW-PLAN")) return "已有原生工作项；自动规划不会覆盖现有 DAG";
  return "";
}

function layoutGraph(items: WorkItem[], dependencies: Dependency[]) {
  const incoming = new Map(items.map((item) => [item.workItemId, 0]));
  for (const edge of dependencies) if (edge.kind !== "conflicts_with") incoming.set(edge.downstreamWorkItemId, (incoming.get(edge.downstreamWorkItemId) ?? 0) + 1);
  const levels = new Map<string, number>();
  const queue = items.filter((item) => (incoming.get(item.workItemId) ?? 0) === 0).map((item) => item.workItemId);
  while (queue.length) { const current = queue.shift(); if (!current) continue; const level = levels.get(current) ?? 0; for (const edge of dependencies.filter((candidate) => candidate.upstreamWorkItemId === current && candidate.kind !== "conflicts_with")) { levels.set(edge.downstreamWorkItemId, Math.max(levels.get(edge.downstreamWorkItemId) ?? 0, level + 1)); incoming.set(edge.downstreamWorkItemId, (incoming.get(edge.downstreamWorkItemId) ?? 1) - 1); if (incoming.get(edge.downstreamWorkItemId) === 0) queue.push(edge.downstreamWorkItemId); } }
  const grouped = new Map<number, WorkItem[]>();
  for (const item of items) { const level = levels.get(item.workItemId) ?? 0; grouped.set(level, [...(grouped.get(level) ?? []), item]); }
  const nodes = items.map((item) => { const level = levels.get(item.workItemId) ?? 0; const row = grouped.get(level)?.findIndex((candidate) => candidate.workItemId === item.workItemId) ?? 0; return { item, x: 30 + level * 220, y: 30 + row * 92 }; });
  const nodeMap = new Map(nodes.map((node) => [node.item.workItemId, node]));
  const edges = dependencies.map((edge) => { const from = nodeMap.get(edge.upstreamWorkItemId); const to = nodeMap.get(edge.downstreamWorkItemId); return from && to ? { id: edge.dependencyId, x1: from.x + 176, y1: from.y + 33, x2: to.x, y2: to.y + 33 } : null; }).filter((edge): edge is NonNullable<typeof edge> => edge !== null);
  return { nodes, edges, width: Math.max(500, ...nodes.map((node) => node.x + 206)), height: Math.max(240, ...nodes.map((node) => node.y + 96)) };
}
