import type {
  AddDependencyInput,
  AddWorkItemInput,
  ProjectState,
} from "../../domain/src/index.ts";
import type { PersistedRunEvent } from "../../agent-protocol/src/index.ts";

export interface PlannedWorkItem {
  workItemId: string;
  parentWorkItemId: string | null;
  kind: AddWorkItemInput["kind"];
  title: string;
  description: string;
  acceptanceCriteria: string[];
  requiredCapabilities: string[];
  codeScopes: string[];
}

export interface PlannedDependency {
  upstreamWorkItemId: string;
  downstreamWorkItemId: string;
  kind: AddDependencyInput["kind"];
}

export interface WorkGraphPlan {
  version: 1;
  summary: string;
  workItems: PlannedWorkItem[];
  dependencies: PlannedDependency[];
}

export interface PlanningRunExecution {
  runId: string;
  agentId: string;
  status: "succeeded" | "failed" | "cancelled";
  events: PersistedRunEvent[];
}

export interface PlanningRunExecutor {
  execute(input: {
    projectId: string;
    workItemId: string;
    role: "planning" | "review";
    prompt: string;
    permissionMode: "workspace-auto";
    agentId?: string;
    attempt: number;
    subjectRunId?: string;
  }): Promise<PlanningRunExecution>;
}

export interface PlanProjectInput {
  projectId: string;
  agentId?: string;
}

export interface PlanProjectResult {
  status: "planned" | "blocked";
  planRootWorkItemId: string;
  runIds: string[];
  attempts: string[];
  plan: WorkGraphPlan | null;
  decisionId: string | null;
  project: { revision: number; state: ProjectState };
}
