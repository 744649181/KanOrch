# KanOrch runtime (internal directory: `strew/`)

KanOrch builds on this local-first, model-neutral director for multi-agent software delivery. A human
creates a project goal; KanOrch can turn it into an independently reviewed work graph, then
routes Codex, Claude Code, and OpenCode through
isolated Git worktrees, records every run and artifact, enforces review/test/budget gates,
and merges only when policy authorizes it. Drift, repeated failures, permissions, conflicts,
and budget overruns are converted into persisted decisions instead of hidden retry loops.

The legacy Python K-now board is a compatibility input; a Cline Kanban 0.1.70 snapshot remains
in older worktrees and is not required to run this branch. SQLite and the domain model in this
directory are the source of truth. KanOrch is standalone: Herdr is design reference only.
The current adapters launch coding CLIs directly. An interactive PTY session and terminal
pane now support input, resize, stop, and browser reconnect while the runtime stays alive.

## Requirements

- Node.js 24 or newer (`node:sqlite` is used directly)
- pnpm 11
- Git
- On Windows, a supported x64 `node-pty` prebuilt binary (validated locally); other platforms
  require their own native-module installation check
- At least one installed CLI for manual runs; a complete automatic delivery crew needs an
  implementation agent, a distinct review identity, and a testing agent

The default adapters invoke `codex`, `claude`, and `opencode` from `PATH`. KanOrch never uses
the dangerous permission-bypass modes of Codex or Claude Code. OpenCode runs with a scoped
`OPENCODE_CONFIG_CONTENT` policy: reads are allowed except `.env` files, writes require approval
in an interactive terminal, batch `workspace-auto` allows edits, shell/network commands require approval,
subagents and external directories are denied. Its `external-sandbox-auto` mode is rejected;
KanOrch never passes `--auto`. These are OpenCode permission prompts, not an OS sandbox. A
separate process/container sandbox is needed before relying on filesystem or network isolation.

## Run locally

```powershell
cd strew
pnpm install
pnpm start
```

Open <http://127.0.0.1:4174>. The runtime binds to loopback only. By default it stores its
database at `strew/.strew/strew.db`; override the location and port with `KANORCH_DATA_DIR` and
`KANORCH_PORT`. The former `STREW_*` names remain accepted for existing setups.

From the Web director:

1. Create a project with its local path, target branch, and objective. A missing or empty
   directory is initialized as a Git repository with a safe empty first commit. An already
   initialized but empty Git repository also gets that commit when its branch matches the
   selected base branch; repositories containing unknown files are left untouched.
2. Register at least two profiles: one planner and a different independent reviewer.
3. Choose **从项目目标生成 DAG**. The planning Agent inspects the repository read-only;
   a different Agent checks goal coverage before the graph is persisted.
4. Inspect or extend the generated work items, acceptance criteria, code scopes, and edges.
5. Select a Ready card and choose **自动实现 → 审查 → 测试 → 合并**.
6. Inspect Run events, logs, diff artifacts, evidence, budget, and any requested decisions.

For a manual interactive run, select a Ready work item, choose an Agent profile and stage, and
click **开启交互终端**. The CLI runs in a task-specific Git worktree. Closing or refreshing the
browser does not stop its process; select the run again to reconnect. **停止** cancels the run
and releases its lease. A successful CLI exit alone does not complete the work item.
The **Agents** page shows all active project terminals side by side; each can be controlled
independently, and **查看任务** opens its work item.
The PTY sets `TERM=xterm-256color` even if the parent shell reports `TERM=dumb`.
Starting a task terminal passes its goal, acceptance criteria, code scopes, and existing
directed handoffs as the CLI's initial prompt. This records delivery intent, not an Agent
read receipt.

Each active Agent run also receives `KANORCH_INBOX_ORIGIN` and a run-specific
`KANORCH_INBOX_TOKEN` in its environment. With `Authorization: Bearer <token>`, it can
`GET /api/agent/inbox`, fetch each attachment at
`GET /api/agent/inbox/<messageId>/artifacts/<artifactId>`, and then
`POST /api/agent/inbox/<messageId>/ack`. The API records attachment fetches and refuses
acknowledgement until that run has fetched every attachment. The token expires when the
run ends; do not copy it into task logs. A confirmation proves the run requested the
content, not that the model understood it. New messages can be polled during a run.

### Multiple projects and new repositories

Use **＋ 新建项目** or the plus button in **项目工作区** to add another project. Selecting a
project changes only the foreground workspace: a non-selected project with an active AgentRun
is labeled **后台运行**, while an idle project is labeled **待命 · 状态已保留**. Switching does
not cancel runs, discard cards, close worktrees, or delete project state. The Web director
refreshes all project summaries while keeping a realtime stream for the foreground project.

KanOrch automatically runs `git init` and creates an empty base commit only when the target path
does not exist or is empty. It deliberately refuses to initialize a non-empty non-Git directory,
because automatically committing unknown files could capture secrets or unrelated data. In that
case, inspect the directory and create its first Git commit manually before registering it.

### Automatic DAG planning

Planner output uses a strict versioned JSON contract surrounded by `STREW_PLAN_JSON` and
`STREW_PLAN_END`. KanOrch rejects the entire plan if IDs are duplicated, parents or edges are
dangling, a directed cycle exists, decomposition exceeds project policy, a code scope is
absolute or escapes the repository, or the plan exceeds 64 work items / 256 dependencies.
The graph is committed in one SQLite transaction; zero-incoming-edge items enter `Ready`.

Invalid generation or independent review is retried up to `maxAttemptsPerStage`. Exhaustion,
permission requests, budget violations, or repository modifications during planning pause
`STREW-PLAN` and create a complete DecisionRequest. Automatic planning never overwrites
native work items already present in a project.

The target Git worktree must be clean for automatic merge. KanOrch-owned `.strew/` artifacts
do not block merge; any other user change does. Failed or conflicting merges are aborted and
sent to the decision workspace.

## Architecture

```text
React Web UI
    │ HTTP + ordered WebSocket cursor
KanOrch local runtime
    ├─ ProjectRepository + SQLite WAL event store
    ├─ Scheduler + dependency DAG + workspace leases
    ├─ Director + quality gates + Replanner
    ├─ AgentRun protocol + interactive PTY sessions
    │    ├─ Codex adapter
    │    ├─ Claude Code adapter
    │    └─ OpenCode adapter
    └─ Cline execution boundary
         ├─ isolated Git worktrees
         ├─ complete tracked/untracked diff capture
         └─ guarded Git merge
```

Large logs and diffs live under `<repository>/.strew/artifacts`; their SHA-256 hashes and
metadata are persisted in the project event stream. The artifact store adds `/.strew/` to the
repository's local `.git/info/exclude` without replacing existing rules, so these files do not
dirty the user's working tree. A runtime restart recovers active runs
as cancelled, releases their leases, pauses the affected subgraph, and creates a decision.

## K-now migration

Use **导入 K-now** and select an absolute `.kanban/*.json` path. Imports are content-hash
idempotent. Cards preserve their observed status and are labeled `K-now history`; imported
agent profiles are inactive. Historical evidence is marked `imported` and is deliberately
excluded from KanOrch quality gates, so it cannot silently authorize new execution or merge.

## Verification

```powershell
cd strew
pnpm typecheck
pnpm test
pnpm build:web
```

The test suite covers transactional append/replay, stale revisions, command idempotency,
schema reopening, dependency cycles, routing and leases, all three adapters, real child
process event capture, real Git worktrees/diffs/merge, artifacts and hashes, independent
review/test gates, budgets, replanning, K-now migration, crash recovery, runtime/WebSocket
APIs, static Web serving, a real PTY/WebSocket reconnect, and the end-to-end Director pipeline.

Interactive PTYs are not preserved across runtime restarts. Recovery cancels orphaned runs;
resume through each CLI's native session mechanism remains future work. Directed handoffs are
included at batch and interactive launch; handoffs recorded after launch require a new delivery
path, and Agent read receipts are not yet implemented. On Windows,
node-pty may print `AttachConsole failed` during stop because of an upstream ConPTY race.

The current product boundary and next acceptance criteria are in
[`../PROJECT.md`](../PROJECT.md) and [`../docs/roadmap.md`](../docs/roadmap.md).
