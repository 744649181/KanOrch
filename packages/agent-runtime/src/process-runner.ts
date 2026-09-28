import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import type {
  AgentAdapter,
  AgentLaunchRequest,
  PersistedRunEvent,
} from "../../agent-protocol/src/index.ts";
import { resolveCliLaunch } from "./cli-launch.ts";

export interface AgentProcessRunOptions {
  signal?: AbortSignal;
  onEvent?: (event: PersistedRunEvent) => void | Promise<void>;
}

export interface AgentProcessResult {
  runId: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  events: PersistedRunEvent[];
}

export class AgentProcessRunner {
  async run(
    adapter: AgentAdapter,
    request: AgentLaunchRequest,
    options: AgentProcessRunOptions = {},
  ): Promise<AgentProcessResult> {
    const spec = adapter.buildLaunchSpec(request);
    const events: PersistedRunEvent[] = [];
    let sequence = 0;
    let eventQueue = Promise.resolve();
    const emit = (event: Omit<PersistedRunEvent, "eventId" | "runId" | "sequence" | "occurredAt">) => {
      const persisted: PersistedRunEvent = {
        ...event,
        eventId: randomUUID(),
        runId: request.runId,
        sequence: ++sequence,
        occurredAt: new Date().toISOString(),
      };
      events.push(persisted);
      eventQueue = eventQueue.then(async () => options.onEvent?.(persisted));
    };

    emit({ type: "run.started", raw: { adapterKind: adapter.kind, cwd: spec.cwd } });
    const environment = { ...process.env, ...spec.environment };
    const launch = resolveCliLaunch(spec.executable, spec.args, environment);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.executable, launch.args, {
        cwd: spec.cwd,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      emit({
        type: "run.failed",
        message: `Agent process could not start: ${error instanceof Error ? error.message : String(error)}`,
        raw: { processError: true, synchronous: true },
      });
      await eventQueue;
      throw new AgentProcessError(request.runId, events, error);
    }
    if (spec.stdin !== null) child.stdin.end(spec.stdin);
    else child.stdin.end();

    const removeAbort = bindAbort(child, options.signal, () =>
      emit({ type: "run.cancelled", message: "Agent run cancelled", raw: { reason: "abort" } }),
    );
    readLines(child.stdout, (line) => {
      try {
        for (const normalized of adapter.parseStdoutLine(line)) emit(normalized);
      } catch (error) {
        emit({
          type: "provider.event",
          message: `Adapter could not parse provider output: ${error instanceof Error ? error.message : String(error)}`,
          raw: { line, parseError: true },
        });
      }
    });
    readLines(child.stderr, (line) => {
      emit({ type: "output.delta", message: line, raw: { stream: "stderr", line } });
    });

    let result: { exitCode: number | null; signal: NodeJS.Signals | null };
    try {
      result = await waitForExit(child);
    } catch (error) {
      removeAbort();
      emit({
        type: "run.failed",
        message: `Agent process could not start or complete: ${error instanceof Error ? error.message : String(error)}`,
        raw: { processError: true },
      });
      await eventQueue;
      throw new AgentProcessError(request.runId, events, error);
    }
    removeAbort();
    const hasTerminalEvent = events.some((event) =>
      ["run.succeeded", "run.failed", "run.cancelled"].includes(event.type),
    );
    if (!hasTerminalEvent) {
      emit({
        type: result.exitCode === 0 ? "run.succeeded" : "run.failed",
        message: result.exitCode === 0 ? "Agent process completed" : `Agent process exited with code ${result.exitCode}`,
        raw: result,
      });
    }
    await eventQueue;
    return { runId: request.runId, ...result, events };
  }
}

export class AgentProcessError extends Error {
  readonly runId: string;
  readonly events: PersistedRunEvent[];
  readonly cause: unknown;

  constructor(runId: string, events: PersistedRunEvent[], cause: unknown) {
    super(`agent process '${runId}' failed before a normal exit`);
    this.name = "AgentProcessError";
    this.runId = runId;
    this.events = events;
    this.cause = cause;
  }
}

function readLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      onLine(pending.slice(0, newline).replace(/\r$/, ""));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (pending) onLine(pending.replace(/\r$/, ""));
  });
}

function bindAbort(
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): () => void {
  if (!signal) return () => undefined;
  const abort = () => {
    if (child.exitCode === null && child.signalCode === null) {
      onAbort();
      child.kill();
    }
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}
