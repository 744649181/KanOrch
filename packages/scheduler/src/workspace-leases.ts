import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import type { DomainEvent } from "../../domain/src/events.ts";
import {
  DomainRuleError,
  type ProjectState,
  type WorkspaceLease,
} from "../../domain/src/index.ts";

export interface AcquireWorkspaceLeaseInput {
  leaseId?: string;
  workItemId: string;
  runId: string;
  worktreePath: string;
  branchName: string;
  codeScopes?: string[];
  acquiredAt?: string;
}
export function decideAcquireWorkspaceLease(
  state: ProjectState,
  input: AcquireWorkspaceLeaseInput,
): DomainEvent {
  const project = state.project;
  if (!project) throw new DomainRuleError("project has not been created");
  const item = state.workItems[input.workItemId];
  if (!item) throw new DomainRuleError(`work item '${input.workItemId}' does not exist`);
  if (!input.runId.trim()) throw new DomainRuleError("workspace lease runId is required");
  if (!input.branchName.trim()) throw new DomainRuleError("workspace lease branchName is required");
  if (!isAbsolute(input.worktreePath)) throw new DomainRuleError("workspace lease worktreePath must be absolute");
  const repositoryPath = resolve(project.repositoryPath);
  const worktreePath = resolve(input.worktreePath);
  if (worktreePath === repositoryPath) {
    throw new DomainRuleError("agent workspace must be an isolated worktree, not the project root");
  }
  const scopes = normalizeScopes(input.codeScopes?.length ? input.codeScopes : item.codeScopes);
  const collision = Object.values(state.workspaceLeases)
    .filter((lease) => lease.status === "active")
    .find((lease) => scopesOverlap(scopes, lease.codeScopes));
  if (collision) {
    throw new DomainRuleError(
      `workspace lease conflicts with '${collision.leaseId}' on code scope ${describeOverlap(scopes, collision.codeScopes)}`,
    );
  }
  const lease: WorkspaceLease = {
    leaseId: input.leaseId ?? randomUUID(),
    projectId: project.projectId,
    workItemId: item.workItemId,
    runId: input.runId,
    worktreePath,
    branchName: input.branchName,
    codeScopes: scopes,
    status: "active",
    acquiredAt: input.acquiredAt ?? new Date().toISOString(),
    releasedAt: null,
  };
  if (state.workspaceLeases[lease.leaseId]) {
    throw new DomainRuleError(`workspace lease '${lease.leaseId}' already exists`);
  }
  return { eventType: "workspace_lease.acquired", payload: { lease } };
}

export function decideReleaseWorkspaceLease(
  state: ProjectState,
  leaseId: string,
  releasedAt = new Date().toISOString(),
): DomainEvent {
  const lease = state.workspaceLeases[leaseId];
  if (!lease) throw new DomainRuleError(`workspace lease '${leaseId}' does not exist`);
  if (lease.status !== "active") throw new DomainRuleError(`workspace lease '${leaseId}' is not active`);
  return { eventType: "workspace_lease.released", payload: { leaseId, releasedAt } };
}

export function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = normalizeScopes(left);
  const normalizedRight = normalizeScopes(right);
  return normalizedLeft.some((a) =>
    normalizedRight.some((b) => a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)),
  );
}

function normalizeScopes(scopes: readonly string[]): string[] {
  const normalized = scopes
    .map((scope) => scope.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""))
    .map((scope) => (scope === "" ? "." : scope))
    .map((scope) => scope.toLowerCase());
  if (normalized.some((scope) => scope === ".." || scope.startsWith("../") || isAbsolute(scope))) {
    throw new DomainRuleError("code scopes must be repository-relative paths");
  }
  return [...new Set(normalized)].sort();
}

function describeOverlap(left: readonly string[], right: readonly string[]): string {
  for (const a of left) for (const b of right) if (scopesOverlap([a], [b])) return `${a}<->${b}`;
  return "unknown";
}
