# Delivery and acceptance

| Stage | Scope | Exit evidence |
|---|---|---|
| 1. Independent core | Plans, leases, terminals, handoffs, gates, decisions | Windows tests and real pilot task |
| 2. Two launch modes | Loopback headless server and Electron window | Both start, render the board, and shut down cleanly |
| 3. Three-platform source | Install and test on Windows, Linux, macOS | CI matrix passes on all three operating systems and both macOS architectures |
| 4. Coordination acceptance | Two parallel tasks and a dependent receiver | Real agent fetches an artifact, acknowledges it, and dependent work proceeds |
| 5. Distribution | Backup, upgrade, packaged desktop runtime | Clean machine runs without preinstalled Node or Herdr |

Stages 1 and 2 have Windows and Ubuntu (WSL) evidence. Stage 3 has a workflow but no completed remote CI run.
Stage 4 is partly covered by simulator tests and one real OpenCode delivery, not a complete
multi-agent interaction. Stage 5 is not implemented.

This repository is the source and manual-acceptance checkout. Legacy K-now worktrees are
retained as historical evidence; a separate repository was used only as a pilot target.
