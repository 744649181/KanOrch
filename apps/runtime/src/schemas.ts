import { z } from "zod";

const commandEnvelope = z.object({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).max(200),
});

const projectPolicy = z
  .object({
    maxDecompositionDepth: z.number().int().nonnegative().optional(),
    maxAgentDelegationDepth: z.number().int().nonnegative().optional(),
    maxAttemptsPerStage: z.number().int().nonnegative().optional(),
    maxReplanDepth: z.number().int().nonnegative().optional(),
    requireIndependentReview: z.boolean().optional(),
    requireTestEvidence: z.boolean().optional(),
    autoMerge: z.boolean().optional(),
  })
  .optional();

const projectBudget = z
  .object({
    maxInputTokens: z.number().nonnegative().nullable().optional(),
    maxOutputTokens: z.number().nonnegative().nullable().optional(),
    maxCostUsd: z.number().nonnegative().nullable().optional(),
    maxWallClockSeconds: z.number().nonnegative().nullable().optional(),
  })
  .optional();

export const createProjectCommand = commandEnvelope.extend({
  project: z.object({
    projectId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    name: z.string().min(1).max(200),
    repositoryPath: z.string().min(1).max(2_000),
    baseBranch: z.string().min(1).max(500).optional(),
    goal: z.string().min(1).max(20_000),
    policy: projectPolicy,
    budget: projectBudget,
  }),
});

export const addWorkItemCommand = commandEnvelope.extend({
  workItem: z.object({
    workItemId: z.string().min(1).max(100),
    parentWorkItemId: z.string().min(1).max(100).nullable().optional(),
    kind: z.enum(["goal", "epic", "story", "task", "bug", "review", "test", "release"]),
    title: z.string().min(1).max(500),
    description: z.string().min(1).max(50_000),
    acceptanceCriteria: z.array(z.string().min(1).max(5_000)).min(1),
    requiredCapabilities: z.array(z.string().min(1).max(100)).optional(),
    allowedRoles: z
      .array(
        z.enum([
          "planning",
          "architecture",
          "implementation",
          "review",
          "testing",
          "integration",
          "monitoring",
        ]),
      )
      .optional(),
    codeScopes: z.array(z.string().min(1).max(500)).optional(),
  }),
});

export const setWorkItemRolesCommand = commandEnvelope.extend({
  allowedRoles: z.array(z.enum([
    "planning", "architecture", "implementation", "review", "testing", "integration", "monitoring",
  ])),
});

export const addDependencyCommand = commandEnvelope.extend({
  dependency: z.object({
    dependencyId: z.string().min(1).max(200).optional(),
    upstreamWorkItemId: z.string().min(1).max(100),
    downstreamWorkItemId: z.string().min(1).max(100),
    kind: z.enum(["blocks", "produces", "conflicts_with"]),
  }),
});

export const registerAgentCommand = commandEnvelope.extend({
  agent: z.object({
    agentId: z.string().min(1).max(100),
    displayName: z.string().min(1).max(200),
    adapterKind: z.enum(["codex", "claude-code", "opencode", "external"]),
    capabilities: z.array(z.string().min(1).max(100)),
    roles: z.array(
      z.enum(["planning", "architecture", "implementation", "review", "testing", "integration", "monitoring"]),
    ).min(1),
    reliability: z.number().min(0).max(1),
    costPerMillionTokens: z.number().nonnegative().nullable(),
    active: z.boolean(),
    maxConcurrentRuns: z.number().int().positive(),
  }),
});

export const executeAgentRunCommand = commandEnvelope.extend({
  run: z.object({
    runId: z.string().min(1).max(120).optional(),
    role: z.enum(["planning", "architecture", "implementation", "review", "testing", "integration", "monitoring"]),
    prompt: z.string().min(1).max(100_000),
    permissionMode: z.enum(["manual", "workspace-auto", "external-sandbox-auto"]),
    agentId: z.string().min(1).max(100).optional(),
    attempt: z.number().int().positive().optional(),
    delegationDepth: z.number().int().nonnegative().optional(),
    baseRef: z.string().min(1).max(500).optional(),
    model: z.string().min(1).max(200).optional(),
    sessionId: z.string().min(1).max(500).optional(),
    maxBudgetUsd: z.number().nonnegative().optional(),
    subjectRunId: z.string().min(1).max(120).nullable().optional(),
  }),
});

export const recordAgentHandoffCommand = commandEnvelope.extend({
  handoff: z.object({
    messageId: z.string().uuid(),
    workItemId: z.string().min(1).max(100),
    sourceRunId: z.string().min(1).max(120),
    recipientAgentId: z.string().min(1).max(100),
    kind: z.enum(["handoff", "blocker", "review_request"]),
    summary: z.string().trim().min(1).max(10_000),
    artifactIds: z.array(z.string().min(1).max(200)).max(100),
  }),
});

export const startTerminalCommand = commandEnvelope.extend({
  agentId: z.string().min(1).max(100),
  role: z.enum(["planning", "architecture", "implementation", "review", "testing", "integration", "monitoring"]),
  cols: z.number().int().min(20).max(400),
  rows: z.number().int().min(5).max(200),
});

export const importKNowCommand = commandEnvelope.extend({
  sourcePath: z.string().min(1).max(2_000),
});

export const deliverWorkItemCommand = commandEnvelope.extend({});

export const integrateWorkItemCommand = commandEnvelope.extend({
  implementationRunId: z.string().min(1).max(200),
});

export const planProjectCommand = commandEnvelope.extend({
  agentId: z.string().min(1).max(100).optional(),
});

export const changeStatusCommand = commandEnvelope.extend({
  status: z.enum([
    "backlog",
    "ready",
    "running",
    "waiting_review",
    "verifying",
    "blocked",
    "done",
    "cancelled",
  ]),
});

export const resolveDecisionCommand = commandEnvelope.extend({
  selectedOptionId: z.string().min(1).max(200),
});
