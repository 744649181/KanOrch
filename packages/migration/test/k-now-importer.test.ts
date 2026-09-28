import assert from "node:assert/strict";
import test from "node:test";

import {
  decideCreateProject,
  emptyProjectState,
  evolveProject,
} from "../../domain/src/index.ts";
import { evaluateQualityGates } from "../../quality-gates/src/index.ts";
import { KNowImporter } from "../src/index.ts";

test("K-now import preserves cards and evidence as history without satisfying Strew execution gates", () => {
  let state = emptyProjectState();
  state = evolveProject(
    state,
    decideCreateProject(state, {
      projectId: "strew-project",
      name: "Strew",
      repositoryPath: "C:/workspace/strew",
      goal: "Import history safely",
    }),
  );
  const importer = new KNowImporter();
  const plan = importer.plan(state, JSON.stringify(legacyBoard()), "C:/workspace/.kanban/demo.json");
  assert.equal(plan.duplicate, false);
  state = plan.events.reduce(evolveProject, state);

  assert.equal(state.workItems["card-1"]?.origin, "k-now");
  assert.equal(state.workItems["card-1"]?.ownStatus, "done");
  assert.equal(state.agents.reviewer?.active, false);
  const evidence = Object.values(state.evidence)[0];
  assert.equal(evidence?.imported, true);
  assert.equal(evidence?.kind, "review");
  assert.equal(Object.keys(state.runs).length, 0, "history must not fabricate AgentRun execution");
  assert.equal(evaluateQualityGates(state, "card-1").passed, false, "legacy evidence must not open Strew gates");
  assert.equal(Object.values(state.importReceipts)[0]?.sourceRevision, 12);

  const duplicate = importer.plan(state, JSON.stringify(legacyBoard()), "C:/workspace/.kanban/demo.json");
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.events, []);
});

function legacyBoard(): unknown {
  return {
    schema_version: 1,
    board_id: "demo-board",
    goal: "Legacy goal",
    revision: 12,
    models: {
      reviewer: {
        model_id: "reviewer",
        display_name: "Review model",
        capabilities: ["audit"],
        roles: ["review"],
        reliability: 0.88,
        active: true,
      },
    },
    cards: {
      "card-1": {
        card_id: "card-1",
        title: "Legacy reviewed card",
        description: "Completed in K-now",
        required_capabilities: ["typescript"],
        allowed_roles: ["implementation"],
        acceptance_criteria: ["Legacy checks passed"],
        column: "done",
        created_at: "2026-08-23T09:36:08.838166Z",
      },
    },
    evidence: [
      {
        evidence_id: "evidence-review",
        card_id: "card-1",
        model_id: "reviewer",
        role: "review",
        result: "passed",
        summary: "No blocking issues found.",
        command: null,
        created_at: "2026-08-23T09:36:08.838166Z",
      },
    ],
  };
}
