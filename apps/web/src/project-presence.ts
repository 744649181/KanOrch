import type { AgentRun } from "../../../packages/domain/src/index.ts";
import type { ProjectView } from "./api.ts";

const ACTIVE_RUN_STATUSES = new Set<AgentRun["status"]>([
  "queued",
  "starting",
  "running",
  "waiting_approval",
]);

export function projectPresence(
  project: ProjectView,
  activeProjectId: string,
  planningProjectIds: Set<string>,
): { kind: "foreground" | "background" | "standby"; label: string } {
  const projectId = project.state.project?.projectId ?? "";
  const activeRuns = Object.values(project.state.runs).filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).length;
  const isPlanning = planningProjectIds.has(projectId);
  if (projectId === activeProjectId) {
    const suffix = activeRuns || isPlanning ? ` · ${Math.max(activeRuns, isPlanning ? 1 : 0)} 项运行中` : "";
    return { kind: "foreground", label: `当前前台${suffix}` };
  }
  if (activeRuns || isPlanning) {
    return { kind: "background", label: `后台运行 · ${Math.max(activeRuns, isPlanning ? 1 : 0)} 项` };
  }
  return { kind: "standby", label: "待命 · 状态已保留" };
}
