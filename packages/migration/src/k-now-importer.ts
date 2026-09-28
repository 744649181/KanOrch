import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  decideAddWorkItem,
  decideChangeWorkItemStatus,
  decideRecordEvidence,
  decideRecordLegacyImport,
  decideRegisterAgent,
  evolveProject,
  type DomainEvent,
  type EvidenceKind,
  type FunctionalRole,
  type LegacyImportReceipt,
  type ProjectState,
  type WorkItemStatus,
} from "../../domain/src/index.ts";

const role = z.enum([
  "planning",
  "architecture",
  "implementation",
  "review",
  "testing",
  "integration",
  "monitoring",
]);

const kNowBoardSchema = z.object({
  schema_version: z.number().int().positive(),
  board_id: z.string().min(1),
  goal: z.string(),
  revision: z.number().int().nonnegative(),
  models: z.record(
    z.string(),
    z.object({
      model_id: z.string().min(1),
      display_name: z.string().min(1),
      capabilities: z.array(z.string()),
      roles: z.array(role),
      reliability: z.number().min(0).max(1),
      active: z.boolean(),
    }),
  ),
  cards: z.record(
    z.string(),
    z.object({
      card_id: z.string().min(1),
      title: z.string().min(1),
      description: z.string().min(1),
      required_capabilities: z.array(z.string()),
      allowed_roles: z.array(role),
      acceptance_criteria: z.array(z.string()),
      column: z.enum(["backlog", "ready", "in_progress", "review", "verify", "done", "blocked"]),
      created_at: z.string(),
    }),
  ),
  evidence: z.array(
    z.object({
      evidence_id: z.string().min(1),
      card_id: z.string().min(1),
      model_id: z.string().min(1),
      role,
      result: z.enum(["passed", "failed", "observed"]),
      summary: z.string().min(1),
      command: z.string().nullable().optional(),
      created_at: z.string(),
    }),
  ),
});

export interface KNowImportPlan {
  sourceHash: string;
  duplicate: boolean;
  events: DomainEvent[];
  receipt: LegacyImportReceipt | null;
}

export class KNowImporter {
  async planFile(state: ProjectState, sourcePath: string): Promise<KNowImportPlan> {
    return this.plan(state, await readFile(sourcePath, "utf8"), sourcePath);
  }

  plan(state: ProjectState, sourceText: string, sourcePath: string): KNowImportPlan {
    const project = state.project;
    if (!project) throw new KNowImportError("Strew project must exist before importing a K-now board");
    const sourceHash = createHash("sha256").update(sourceText).digest("hex");
    if (Object.values(state.importReceipts).some((receipt) => receipt.sourceHash === sourceHash)) {
      return { sourceHash, duplicate: true, events: [], receipt: null };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(sourceText) as unknown;
    } catch {
      throw new KNowImportError("K-now source is not valid JSON");
    }
    const board = kNowBoardSchema.parse(parsed);
    let working = structuredClone(state);
    const events: DomainEvent[] = [];
    const importedAgentIds: string[] = [];
    const importedWorkItemIds: string[] = [];
    const importedEvidenceIds: string[] = [];
    const skipped: string[] = [];

    const append = (event: DomainEvent) => {
      events.push(event);
      working = evolveProject(working, event);
    };
    for (const model of Object.values(board.models).sort((left, right) => left.model_id.localeCompare(right.model_id))) {
      if (working.agents[model.model_id]) {
        skipped.push(`agent:${model.model_id}:already-exists`);
        continue;
      }
      append(
        decideRegisterAgent(working, {
          agentId: model.model_id,
          displayName: `${model.display_name} (K-now history)`,
          adapterKind: "external",
          capabilities: model.capabilities,
          roles: model.roles,
          reliability: model.reliability,
          costPerMillionTokens: null,
          active: false,
          maxConcurrentRuns: 1,
          createdAt: new Date().toISOString(),
        }),
      );
      importedAgentIds.push(model.model_id);
    }
    for (const card of Object.values(board.cards).sort((left, right) => left.card_id.localeCompare(right.card_id))) {
      if (working.workItems[card.card_id]) {
        skipped.push(`card:${card.card_id}:already-exists`);
        continue;
      }
      append(
        decideAddWorkItem(working, {
          workItemId: card.card_id,
          kind: "task",
          title: card.title,
          description: card.description,
          acceptanceCriteria: card.acceptance_criteria.length ? card.acceptance_criteria : ["Imported historical card; acceptance criteria were not recorded"],
          requiredCapabilities: card.required_capabilities,
          allowedRoles: card.allowed_roles,
          codeScopes: ["."],
          origin: "k-now",
          createdAt: card.created_at,
        }),
      );
      const status = mapColumn(card.column);
      if (status !== "backlog") append(decideChangeWorkItemStatus(working, card.card_id, status));
      importedWorkItemIds.push(card.card_id);
    }
    for (const legacy of board.evidence) {
      if (!importedWorkItemIds.includes(legacy.card_id)) {
        skipped.push(`evidence:${legacy.evidence_id}:card-not-imported`);
        continue;
      }
      const evidenceId = `k-now:${board.board_id}:${legacy.evidence_id}`;
      if (working.evidence[evidenceId]) {
        skipped.push(`evidence:${legacy.evidence_id}:already-exists`);
        continue;
      }
      append(
        decideRecordEvidence(working, {
          evidenceId,
          projectId: project.projectId,
          workItemId: legacy.card_id,
          runId: `legacy:k-now:${board.board_id}:${legacy.evidence_id}`,
          producerAgentId: legacy.model_id,
          kind: mapEvidenceKind(legacy.role),
          verdict: legacy.result === "observed" ? "informational" : legacy.result,
          summary: `${legacy.summary}${legacy.command ? ` (command: ${legacy.command})` : ""}`,
          artifactIds: [],
          subjectRunId: null,
          imported: true,
          createdAt: legacy.created_at,
        }),
      );
      importedEvidenceIds.push(evidenceId);
    }
    const receipt: LegacyImportReceipt = {
      importId: `k-now-${sourceHash.slice(0, 16)}`,
      projectId: project.projectId,
      sourceKind: "k-now",
      sourcePath,
      sourceHash,
      sourceRevision: board.revision,
      importedWorkItemIds,
      importedEvidenceIds,
      importedAgentIds,
      skipped,
      createdAt: new Date().toISOString(),
    };
    append(decideRecordLegacyImport(working, receipt));
    return { sourceHash, duplicate: false, events, receipt };
  }
}

export class KNowImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KNowImportError";
  }
}

function mapColumn(column: string): WorkItemStatus {
  const statuses: Record<string, WorkItemStatus> = {
    backlog: "backlog",
    ready: "ready",
    in_progress: "running",
    review: "waiting_review",
    verify: "verifying",
    done: "done",
    blocked: "blocked",
  };
  return statuses[column] ?? "backlog";
}

function mapEvidenceKind(roleValue: FunctionalRole): EvidenceKind {
  if (roleValue === "review") return "review";
  if (roleValue === "testing") return "test";
  if (roleValue === "integration") return "integration";
  return "implementation";
}
