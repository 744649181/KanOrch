# Architecture and technology

```text
Browser or Electron window
        │ local HTTP / WebSocket
Node 24 control plane
        ├─ SQLite WAL event store and project repository
        ├─ bounded DAG scheduler, worktree leases, and decision queue
        ├─ directed inbox, artifact store, review/test/merge gates
        └─ node-pty sessions and CLI adapters
             └─ isolated Git worktrees
```

The headless and desktop modes share `apps/runtime`. Electron only owns a window and a child
Node process; the browser renderer has Node integration disabled, context isolation enabled,
and sandboxing enabled. Runtime HTTP and WebSocket endpoints accept loopback traffic only.
Desktop mode uses the operating system's user-data location; headless mode defaults to a
repository-local `.strew` directory. One data directory must have one running instance.

| Concern | Current choice | Reason |
|---|---|---|
| Control plane | TypeScript on Node 24 | Existing scheduler and direct `node:sqlite` support |
| State | SQLite WAL and hashed file artifacts | Local persistence without another service |
| UI | React 18, Vite, `@xterm/xterm` | Kanban, decisions, and interactive terminal in one board |
| Native terminal | `node-pty` | ConPTY on Windows and PTYs on Unix |
| Window | Electron 44 | Same Web UI in a desktop window |
| Agents | Direct Codex, Claude Code, OpenCode adapters | Product does not depend on Herdr |
| Isolation | Git worktrees and single-writer leases | Separate edits and auditable integration |

The desktop launcher deliberately uses the installed system Node 24 for the runtime. Electron
has a different native-module ABI, while `node-pty` is installed for the system Node. A
self-contained desktop installer will need to bundle a compatible Node runtime and build
native dependencies for each target architecture.

Agent CLI approval prompts are not an operating-system sandbox. The OpenCode policy restricts
its own tool permissions, while process and filesystem isolation need a separate boundary.
Task handoffs use persisted messages and artifact IDs; terminal text is an observation, not
proof of receipt or a quality-gate result. After a runtime crash, persisted state remains but
the old PTY process cannot be reattached automatically.
