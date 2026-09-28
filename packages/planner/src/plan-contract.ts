import { z } from "zod";

import { DomainRuleError, type ProjectPolicy } from "../../domain/src/index.ts";
import type { PlannedWorkItem, WorkGraphPlan } from "./types.ts";

const identifier = z.string().min(1).max(100).regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const nonEmptyText = (max: number) => z.string().trim().min(1).max(max);
const planSchema = z.object({
  version: z.literal(1),
  summary: nonEmptyText(5_000),
  workItems: z.array(z.object({
    workItemId: identifier,
    parentWorkItemId: identifier.nullable().default(null),
    kind: z.enum(["goal", "epic", "story", "task", "bug", "review", "test", "release"]),
    title: nonEmptyText(500),
    description: nonEmptyText(20_000),
    acceptanceCriteria: z.array(nonEmptyText(2_000)).min(1).max(20),
    requiredCapabilities: z.array(nonEmptyText(100)).max(20).default([]),
    codeScopes: z.array(nonEmptyText(500)).min(1).max(20),
  })).min(1).max(64),
  dependencies: z.array(z.object({
    upstreamWorkItemId: identifier,
    downstreamWorkItemId: identifier,
    kind: z.enum(["blocks", "produces", "conflicts_with"]),
  })).max(256).default([]),
}).strict();

export function parseWorkGraphPlan(output: string, policy: ProjectPolicy): WorkGraphPlan {
  const match = /STREW_PLAN_JSON\s*([\s\S]*?)\s*STREW_PLAN_END/i.exec(output);
  if (!match?.[1]) throw new DomainRuleError("planner output is missing STREW_PLAN_JSON / STREW_PLAN_END markers");
  if (new TextEncoder().encode(match[1]).byteLength > 250_000) {
    throw new DomainRuleError("planner output exceeds the 250 KB structured plan limit");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(match[1].replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch (error) {
    throw new DomainRuleError(`planner output contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = planSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new DomainRuleError(`planner output violates the DAG contract: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  const plan = parsed.data as WorkGraphPlan;
  validateGraph(plan, policy);
  return { ...plan, workItems: orderParentsFirst(plan.workItems) };
}

export function collectPlanningOutput(events: readonly { message?: string }[]): string {
  return events.map((event) => event.message ?? "").filter(Boolean).join("\n");
}

export function buildPlanningPrompt(input: {
  goal: string;
  maxDecompositionDepth: number;
  availableCapabilities: readonly string[];
  previousFailures: readonly string[];
}): string {
  const retry = input.previousFailures.length
    ? `\nPrevious invalid attempts; correct every issue:\n${input.previousFailures.map((failure) => `- ${failure}`).join("\n")}\n`
    : "";
  return `You are Strew's planning agent. Inspect the repository read-only and turn the user's single high-level requirement into a complete, bounded software-delivery DAG. Do not edit any file.\n\nUSER REQUIREMENT:\n${input.goal}\n\nCONSTRAINTS:\n- Maximum parent decomposition depth: ${input.maxDecompositionDepth}.\n- Emit 1-64 concise work items with unique safe IDs; total JSON must stay below 250 KB.\n- Every work item needs a concrete description, measurable acceptance criteria, repository-relative codeScopes, and only necessary capabilities.\n- requiredCapabilities may use only this registered capability set: ${input.availableCapabilities.join(", ") || "(none; emit empty arrays)"}. Use an empty array when no special capability is necessary.\n- Dependencies must reference emitted IDs. blocks/produces edges must be acyclic.\n- Separate architecture, implementation, integration, tests, migration, documentation, and release work only when the requirement needs them.\n- Keep independently executable items parallel; add an edge only for a real prerequisite.\n- Do not assign named agents; Strew's scheduler owns routing.${retry}\nOUTPUT EXACTLY:\nSTREW_PLAN_JSON\n{"version":1,"summary":"...","workItems":[{"workItemId":"S-001","parentWorkItemId":null,"kind":"task","title":"...","description":"...","acceptanceCriteria":["..."],"requiredCapabilities":["typescript"],"codeScopes":["src"]}],"dependencies":[{"upstreamWorkItemId":"S-001","downstreamWorkItemId":"S-002","kind":"blocks"}]}\nSTREW_PLAN_END`;
}

export function buildPlanReviewPrompt(goal: string, plan: WorkGraphPlan): string {
  return `You are the independent Strew plan reviewer. You did not author this plan. Review it against the user's requirement and the repository. Do not edit files.\n\nUSER REQUIREMENT:\n${goal}\n\nPROPOSED DAG:\n${JSON.stringify(plan, null, 2)}\n\nCheck goal coverage, missing migration/integration/test/release work, dependency direction, parallelism, measurable acceptance criteria, realistic code scopes, and hidden assumptions.\n\nEnd with exactly one machine verdict line:\nSTREW_VERDICT: PASS\nor\nSTREW_VERDICT: FAIL\nIf FAIL, explain concrete corrections before the verdict.`;
}

function validateGraph(plan: WorkGraphPlan, policy: ProjectPolicy): void {
  const ids = new Set<string>();
  for (const item of plan.workItems) {
    if (item.workItemId.toUpperCase() === "STREW-PLAN") throw new DomainRuleError("planner may not use reserved id STREW-PLAN");
    if (ids.has(item.workItemId)) throw new DomainRuleError(`planner emitted duplicate work item '${item.workItemId}'`);
    ids.add(item.workItemId);
    for (const scope of item.codeScopes) validateScope(scope, item.workItemId);
  }
  for (const item of plan.workItems) {
    if (item.parentWorkItemId && !ids.has(item.parentWorkItemId)) {
      throw new DomainRuleError(`work item '${item.workItemId}' has missing parent '${item.parentWorkItemId}'`);
    }
    hierarchyDepth(item, plan.workItems, policy.maxDecompositionDepth);
  }
  const edgeKeys = new Set<string>();
  const adjacency = new Map<string, string[]>();
  for (const edge of plan.dependencies) {
    if (!ids.has(edge.upstreamWorkItemId) || !ids.has(edge.downstreamWorkItemId)) {
      throw new DomainRuleError(`dependency '${edge.upstreamWorkItemId}' -> '${edge.downstreamWorkItemId}' references a missing work item`);
    }
    if (edge.upstreamWorkItemId === edge.downstreamWorkItemId) throw new DomainRuleError("planner emitted a self dependency");
    const key = `${edge.kind}:${edge.upstreamWorkItemId}:${edge.downstreamWorkItemId}`;
    if (edgeKeys.has(key)) throw new DomainRuleError(`planner emitted duplicate dependency '${key}'`);
    edgeKeys.add(key);
    if (edge.kind === "conflicts_with") continue;
    adjacency.set(edge.upstreamWorkItemId, [...(adjacency.get(edge.upstreamWorkItemId) ?? []), edge.downstreamWorkItemId]);
  }
  detectCycle(adjacency, ids);
}

function hierarchyDepth(item: PlannedWorkItem, items: PlannedWorkItem[], maximum: number): number {
  const byId = new Map(items.map((candidate) => [candidate.workItemId, candidate]));
  const seen = new Set<string>([item.workItemId]);
  let depth = 0;
  let parentId = item.parentWorkItemId;
  while (parentId) {
    if (seen.has(parentId)) throw new DomainRuleError(`parent hierarchy for '${item.workItemId}' contains a cycle`);
    seen.add(parentId);
    depth += 1;
    if (depth > maximum) throw new DomainRuleError(`work item '${item.workItemId}' exceeds maxDecompositionDepth ${maximum}`);
    parentId = byId.get(parentId)?.parentWorkItemId ?? null;
  }
  return depth;
}

function orderParentsFirst(items: PlannedWorkItem[]): PlannedWorkItem[] {
  return [...items].sort((left, right) => hierarchyDepth(left, items, Number.MAX_SAFE_INTEGER) - hierarchyDepth(right, items, Number.MAX_SAFE_INTEGER));
}

function validateScope(scope: string, workItemId: string): void {
  const normalized = scope.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new DomainRuleError(`work item '${workItemId}' has unsafe code scope '${scope}'`);
  }
}

function detectCycle(adjacency: Map<string, string[]>, ids: Set<string>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new DomainRuleError(`planner emitted a directed dependency cycle at '${id}'`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}
