import type { PersistedRunEvent } from "../../agent-protocol/src/index.ts";
import type { StoredEvent } from "../../domain/src/index.ts";
import { SqliteEventStore } from "../../event-store/src/index.ts";

export interface RunStreamProjection {
  runId: string;
  revision: number;
  lastEventType: PersistedRunEvent["type"];
  status: "running" | "waiting_approval" | "succeeded" | "failed" | "cancelled";
  lastSequence: number;
  updatedAt: string;
}

export class RunEventRecorder {
  readonly store: SqliteEventStore;

  constructor(store: SqliteEventStore) {
    this.store = store;
  }

  record(event: PersistedRunEvent): StoredEvent[] {
    const streamId = `run:${event.runId}`;
    const expectedRevision = this.store.currentRevision(streamId);
    const projection: RunStreamProjection = {
      runId: event.runId,
      revision: expectedRevision + 1,
      lastEventType: event.type,
      status: statusFromEvent(event.type),
      lastSequence: event.sequence,
      updatedAt: event.occurredAt,
    };
    return this.store.append({
      streamId,
      streamType: "agent-run",
      expectedRevision,
      idempotencyKey: event.eventId,
      events: [
        {
          eventId: event.eventId,
          eventType: `agent_run.${event.type}`,
          payload: event,
          actorType: "agent",
          actorId: event.runId,
          createdAt: event.occurredAt,
        },
      ],
      projection,
    });
  }
}

function statusFromEvent(type: PersistedRunEvent["type"]): RunStreamProjection["status"] {
  if (type === "approval.requested") return "waiting_approval";
  if (type === "run.succeeded") return "succeeded";
  if (type === "run.failed") return "failed";
  if (type === "run.cancelled") return "cancelled";
  return "running";
}
