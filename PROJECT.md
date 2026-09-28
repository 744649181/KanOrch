# KanOrch product goal

KanOrch is a standalone, local-first multi-agent scheduling application. A Kanban board makes
work visible; a dependency graph plans it; isolated Git worktrees, agent terminals, directed
messages, artifacts, independent review, and test evidence coordinate delivery. It replaces
the Herdr interface for this workflow. Herdr may inform interaction design but is not a runtime
dependency.

## User outcome

1. Create a project from a Git repository and state its goal and acceptance criteria.
2. Generate a bounded task graph, have a separate agent check it, and adjust the plan.
3. Run ready tasks in leased worktrees using Codex, Claude Code, or OpenCode, with multiple
   terminals visible in the board.
4. Send directed handoffs with artifacts between runs; record retrieval and acknowledgement.
5. Require matching implementation artifacts plus independent review and tests before merge.
   Send permission, budget, conflict, drift, and retry failures to an explicit decision queue.

## Delivery modes

- **Headless:** Node 24 runtime and same-origin Web board, bound to `127.0.0.1`.
- **Desktop:** Electron window launches that runtime as a separate Node process and opens the
  board. The window closes its child runtime on exit.
- Windows, Linux, and macOS use the same source. Native dependencies are installed per platform;
  cross-platform checks live in `.github/workflows/cross-platform.yml`.

This repository is the KanOrch source. A separate test repository was used for pilot
acceptance; it is not a runtime dependency. Historical K-now and Strew worktrees retain
their original material and are not required to run this repository.

## Current evidence and limits

The Windows baseline passed 63 tests, type checking, and a Web build before the two launch
modes were added. Both new entry points have been smoke-tested on Windows. Existing runtime
tests cover task plans, leases, HTTP/WebSocket, PTY reconnect, inbox retrieval, and gates;
the pilot repository previously completed a real OpenCode implementation, independent review,
test, and merge. Real agent inbox use, a parallel dependency graph, and full recovery of an
interactive CLI session still need end-to-end acceptance. Runtime restart preserves project
state but cancels PTYs that belonged to the old process.

Windows and Ubuntu (WSL) source launch checks have passed; macOS and the CI matrix remain
unverified. Source launch requires Node and pnpm; signed installers and a bundled Node runtime
have not been produced.

See [architecture](docs/architecture.md), [roadmap](docs/roadmap.md), and
[reference material](docs/references.md).
