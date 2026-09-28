import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { PendingEvent, StoredEvent } from "../../domain/src/events.ts";

export class RevisionConflictError extends Error {
  readonly streamId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(
    streamId: string,
    expectedRevision: number,
    actualRevision: number,
  ) {
    super(
      `stream '${streamId}' expected revision ${expectedRevision} but current revision is ${actualRevision}`,
    );
    this.name = "RevisionConflictError";
    this.streamId = streamId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class IdempotencyConflictError extends Error {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(`idempotency key '${idempotencyKey}' was already used for a different command`);
    this.name = "IdempotencyConflictError";
    this.idempotencyKey = idempotencyKey;
  }
}

export interface AppendCommand {
  streamId: string;
  streamType: string;
  expectedRevision: number;
  idempotencyKey: string;
  commandHash?: string;
  events: PendingEvent[];
  projection?: unknown;
}

export interface StreamSnapshot<TState> {
  streamId: string;
  streamType: string;
  revision: number;
  state: TState;
  updatedAt: string;
}

interface CommandRow {
  command_hash: string;
  stream_id: string;
  first_sequence: number;
  last_sequence: number;
}

interface RevisionRow {
  revision: number;
}

interface EventRow {
  sequence: number;
  event_id: string;
  stream_id: string;
  stream_type: string;
  revision: number;
  event_type: string;
  payload_json: string;
  actor_type: StoredEvent["actorType"];
  actor_id: string | null;
  created_at: string;
}

export class SqliteEventStore {
  readonly database: DatabaseSync;
  private readonly selectCommand: StatementSync;
  private readonly selectRevision: StatementSync;
  private readonly insertEvent: StatementSync;
  private readonly insertCommand: StatementSync;
  private readonly upsertSnapshot: StatementSync;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    if (databasePath !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL");
    this.migrate();
    this.selectCommand = this.database.prepare(
      "SELECT command_hash, stream_id, first_sequence, last_sequence FROM commands WHERE idempotency_key = ?",
    );
    this.selectRevision = this.database.prepare(
      "SELECT COALESCE(MAX(revision), 0) AS revision FROM events WHERE stream_id = ?",
    );
    this.insertEvent = this.database.prepare(`
      INSERT INTO events (
        event_id, stream_id, stream_type, revision, event_type, payload_json,
        actor_type, actor_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertCommand = this.database.prepare(`
      INSERT INTO commands (
        idempotency_key, command_hash, stream_id, first_sequence, last_sequence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.upsertSnapshot = this.database.prepare(`
      INSERT INTO stream_snapshots (stream_id, stream_type, revision, state_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(stream_id) DO UPDATE SET
        stream_type = excluded.stream_type,
        revision = excluded.revision,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `);
  }

  append(command: AppendCommand): StoredEvent[] {
    if (!command.streamId.trim()) throw new TypeError("streamId is required");
    if (!command.streamType.trim()) throw new TypeError("streamType is required");
    if (!command.idempotencyKey.trim()) throw new TypeError("idempotencyKey is required");
    if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 0) {
      throw new TypeError("expectedRevision must be a non-negative integer");
    }
    if (command.events.length === 0) throw new TypeError("at least one event is required");

    const commandHash = command.commandHash ?? hashCommand(command);
    const prior = this.selectCommand.get(command.idempotencyKey) as unknown as CommandRow | undefined;
    if (prior) return this.replayPriorCommand(prior, command, commandHash);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.selectCommand.get(command.idempotencyKey) as unknown as CommandRow | undefined;
      if (duplicate) {
        const replay = this.replayPriorCommand(duplicate, command, commandHash);
        this.database.exec("COMMIT");
        return replay;
      }
      const revisionRow = this.selectRevision.get(command.streamId) as unknown as RevisionRow;
      const actualRevision = Number(revisionRow.revision);
      if (actualRevision !== command.expectedRevision) {
        throw new RevisionConflictError(command.streamId, command.expectedRevision, actualRevision);
      }
      let revision = actualRevision;
      let firstSequence = 0;
      let lastSequence = 0;
      for (const pending of command.events) {
        revision += 1;
        const createdAt = pending.createdAt ?? new Date().toISOString();
        const result = this.insertEvent.run(
          pending.eventId ?? randomUUID(),
          command.streamId,
          command.streamType,
          revision,
          pending.eventType,
          JSON.stringify(pending.payload),
          pending.actorType,
          pending.actorId ?? null,
          createdAt,
        );
        const sequence = Number(result.lastInsertRowid);
        if (firstSequence === 0) firstSequence = sequence;
        lastSequence = sequence;
      }
      if (command.projection !== undefined) {
        this.upsertSnapshot.run(
          command.streamId,
          command.streamType,
          revision,
          JSON.stringify(command.projection),
          new Date().toISOString(),
        );
      }
      this.insertCommand.run(
        command.idempotencyKey,
        commandHash,
        command.streamId,
        firstSequence,
        lastSequence,
        new Date().toISOString(),
      );
      this.database.exec("COMMIT");
      return this.readSequenceRange(firstSequence, lastSequence);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  readStream(streamId: string, afterRevision = 0): StoredEvent[] {
    const rows = this.database
      .prepare("SELECT * FROM events WHERE stream_id = ? AND revision > ? ORDER BY revision")
      .all(streamId, afterRevision) as unknown as EventRow[];
    return rows.map(mapEventRow);
  }

  replayCommand(
    idempotencyKey: string,
    streamId: string,
    commandHash: string,
  ): StoredEvent[] | null {
    const prior = this.selectCommand.get(idempotencyKey) as unknown as CommandRow | undefined;
    if (!prior) return null;
    if (prior.command_hash !== commandHash || prior.stream_id !== streamId) {
      throw new IdempotencyConflictError(idempotencyKey);
    }
    return this.readSequenceRange(prior.first_sequence, prior.last_sequence);
  }

  readAll(afterSequence = 0, limit = 500): StoredEvent[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
      throw new TypeError("limit must be an integer between 1 and 5000");
    }
    const rows = this.database
      .prepare("SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?")
      .all(afterSequence, limit) as unknown as EventRow[];
    return rows.map(mapEventRow);
  }

  currentRevision(streamId: string): number {
    const row = this.selectRevision.get(streamId) as unknown as RevisionRow;
    return Number(row.revision);
  }

  loadSnapshot<TState>(streamId: string): StreamSnapshot<TState> | null {
    const row = this.database
      .prepare(
        "SELECT stream_id, stream_type, revision, state_json, updated_at FROM stream_snapshots WHERE stream_id = ?",
      )
      .get(streamId) as unknown as
      | {
          stream_id: string;
          stream_type: string;
          revision: number;
          state_json: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      streamId: row.stream_id,
      streamType: row.stream_type,
      revision: Number(row.revision),
      state: JSON.parse(row.state_json) as TState,
      updatedAt: row.updated_at,
    };
  }

  listSnapshots<TState>(streamType: string): StreamSnapshot<TState>[] {
    const rows = this.database
      .prepare(
        "SELECT stream_id, stream_type, revision, state_json, updated_at FROM stream_snapshots WHERE stream_type = ? ORDER BY updated_at DESC",
      )
      .all(streamType) as unknown as Array<{
      stream_id: string;
      stream_type: string;
      revision: number;
      state_json: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      streamId: row.stream_id,
      streamType: row.stream_type,
      revision: Number(row.revision),
      state: JSON.parse(row.state_json) as TState,
      updatedAt: row.updated_at,
    }));
  }

  close(): void {
    this.database.close();
  }

  private replayPriorCommand(
    prior: CommandRow,
    command: AppendCommand,
    commandHash: string,
  ): StoredEvent[] {
    if (prior.command_hash !== commandHash || prior.stream_id !== command.streamId) {
      throw new IdempotencyConflictError(command.idempotencyKey);
    }
    return this.readSequenceRange(prior.first_sequence, prior.last_sequence);
  }

  private readSequenceRange(firstSequence: number, lastSequence: number): StoredEvent[] {
    const rows = this.database
      .prepare("SELECT * FROM events WHERE sequence BETWEEN ? AND ? ORDER BY sequence")
      .all(firstSequence, lastSequence) as unknown as EventRow[];
    return rows.map(mapEventRow);
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        stream_id TEXT NOT NULL,
        stream_type TEXT NOT NULL,
        revision INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        actor_type TEXT NOT NULL CHECK(actor_type IN ('user', 'system', 'agent')),
        actor_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(stream_id, revision)
      );

      CREATE INDEX IF NOT EXISTS idx_events_stream_revision
        ON events(stream_id, revision);
      CREATE INDEX IF NOT EXISTS idx_events_sequence
        ON events(sequence);

      CREATE TABLE IF NOT EXISTS commands (
        idempotency_key TEXT PRIMARY KEY,
        command_hash TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        first_sequence INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(first_sequence) REFERENCES events(sequence),
        FOREIGN KEY(last_sequence) REFERENCES events(sequence)
      );

      CREATE TABLE IF NOT EXISTS stream_snapshots (
        stream_id TEXT PRIMARY KEY,
        stream_type TEXT NOT NULL,
        revision INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function hashCommand(command: AppendCommand): string {
  return fingerprintValue({
    streamId: command.streamId,
    streamType: command.streamType,
    expectedRevision: command.expectedRevision,
    events: command.events,
    projection: command.projection,
  });
}

export function fingerprintValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function mapEventRow(row: EventRow): StoredEvent {
  return {
    sequence: Number(row.sequence),
    eventId: row.event_id,
    streamId: row.stream_id,
    streamType: row.stream_type,
    revision: Number(row.revision),
    eventType: row.event_type,
    payload: JSON.parse(row.payload_json) as unknown,
    actorType: row.actor_type,
    actorId: row.actor_id,
    createdAt: row.created_at,
  };
}
