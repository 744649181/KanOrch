import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

import { WebSocket, WebSocketServer } from "ws";
import { ZodError } from "zod";

import { DomainRuleError } from "../../../packages/domain/src/index.ts";
import { AgentInboxAuthError } from "../../../packages/agent-runtime/src/index.ts";
import type { StoredEvent } from "../../../packages/domain/src/index.ts";
import {
  IdempotencyConflictError,
  RevisionConflictError,
} from "../../../packages/event-store/src/index.ts";
import { StrewApplication } from "./application.ts";
import {
  addDependencyCommand,
  addWorkItemCommand,
  changeStatusCommand,
  createProjectCommand,
  deliverWorkItemCommand,
  integrateWorkItemCommand,
  executeAgentRunCommand,
  importKNowCommand,
  planProjectCommand,
  registerAgentCommand,
  recordAgentHandoffCommand,
  startTerminalCommand,
  resolveDecisionCommand,
  setWorkItemRolesCommand,
} from "./schemas.ts";

export interface RuntimeServer {
  readonly server: Server;
  readonly port: number;
  readonly host: string;
  close(): Promise<void>;
}

export async function startRuntimeServer(
  application: StrewApplication,
  options: { host?: string; port?: number; staticRoot?: string } = {},
): Promise<RuntimeServer> {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) throw new Error("KanOrch control server must bind to loopback");
  const requestedPort = options.port ?? 4174;
  const server = createServer((request, response) => {
    void routeRequest(application, request, response, options.staticRoot);
  });
  const sockets = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    if (!isAllowedLocalRequest(request)) {
      socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
    if (url.pathname !== "/api/events" && !/^\/api\/projects\/[^/]+\/terminals\/[^/]+\/stream$/.test(url.pathname)) {
      socket.destroy();
      return;
    }
    try {
      decodeURIComponent(url.pathname);
    } catch {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => {
      sockets.emit("connection", client, request);
    });
  });

  sockets.on("connection", (client: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? "/api/events", `http://${request.headers.host ?? host}`);
    const terminalMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/terminals\/([^/]+)\/stream$/);
    if (terminalMatch) {
      const projectId = decodeURIComponent(terminalMatch[1] ?? "");
      const runId = decodeURIComponent(terminalMatch[2] ?? "");
      const session = application.terminals.get(projectId, runId);
      if (!session) {
        client.close(1008, "terminal not found");
        return;
      }
      const unsubscribe = application.terminals.subscribe(projectId, runId, (event) => sendTerminalSocket(client, event));
      sendTerminalSocket(client, { type: "snapshot", data: session.output, status: session.status, truncated: session.truncated });
      client.on("message", (raw, binary) => {
        try {
          const frame = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? Buffer.from(raw) : raw;
          if (binary || frame.length > 16_384) throw new Error("invalid terminal frame");
          const command = JSON.parse(frame.toString("utf8")) as Record<string, unknown>;
          if (command.type === "input" && typeof command.data === "string") {
            application.terminals.write(projectId, runId, command.data);
          } else if (command.type === "resize" && typeof command.cols === "number" && typeof command.rows === "number") {
            application.terminals.resize(projectId, runId, command.cols, command.rows);
          } else if (command.type === "stop") {
            application.terminals.stop(projectId, runId);
          } else {
            throw new Error("invalid terminal command");
          }
        } catch {
          client.close(1008, "invalid terminal command");
        }
      });
      client.once("close", unsubscribe);
      client.once("error", unsubscribe);
      return;
    }
    const projectId = url.searchParams.get("projectId");
    const after = parseNonNegativeInteger(url.searchParams.get("after"), 0);
    const backlog = readEventBacklog(application, after).filter((event) =>
      !projectId || eventBelongsToProject(application, projectId, event),
    );
    for (const event of backlog) sendSocket(client, { type: "event", event });
    sendSocket(client, { type: "ready", cursor: backlog.at(-1)?.sequence ?? after });
    const unsubscribe = application.subscribe((events) => {
      for (const event of events) {
        if (!projectId || eventBelongsToProject(application, projectId, event)) {
          sendSocket(client, { type: "event", event });
        }
      }
    });
    client.once("close", unsubscribe);
    client.once("error", unsubscribe);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("runtime server did not bind a TCP port");
  application.inbox.setOrigin(`http://${host.includes(":") ? `[${host}]` : host}:${address.port}`);

  return {
    server,
    port: address.port,
    host,
    async close() {
      application.inbox.setOrigin(null);
      application.cancelAllBatchRuns();
      for (const client of sockets.clients) client.close(1001, "server shutdown");
      await new Promise<void>((resolve, reject) => {
        sockets.close(() => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      });
    },
  };
}

async function routeRequest(
  application: StrewApplication,
  request: IncomingMessage,
  response: ServerResponse,
  staticRoot?: string,
): Promise<void> {
  try {
    if (!isAllowedLocalRequest(request)) {
      sendJson(response, 403, { error: "local_origin_required" });
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, service: "kanorch-runtime" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/projects") {
      sendJson(response, 200, { projects: application.listProjects() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/agent/inbox") {
      sendJson(response, 200, { handoffs: application.inbox.list(inboxToken(request)) });
      return;
    }
    const inboxArtifactMatch = url.pathname.match(/^\/api\/agent\/inbox\/([^/]+)\/artifacts\/([^/]+)$/);
    if (request.method === "GET" && inboxArtifactMatch) {
      const loaded = await application.inbox.fetchArtifact(
        inboxToken(request),
        decodeURIComponent(inboxArtifactMatch[1] ?? ""),
        decodeURIComponent(inboxArtifactMatch[2] ?? ""),
      );
      sendBuffer(response, 200, loaded.content, loaded.artifact.mediaType);
      return;
    }
    const inboxAckMatch = url.pathname.match(/^\/api\/agent\/inbox\/([^/]+)\/ack$/);
    if (request.method === "POST" && inboxAckMatch) {
      const handoff = application.inbox.acknowledge(inboxToken(request), decodeURIComponent(inboxAckMatch[1] ?? ""));
      sendJson(response, 200, { handoff });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/projects") {
      const command = createProjectCommand.parse(await readJsonBody(request));
      const result = await application.createLocalProject(command.project, commandContext(command));
      sendJson(response, 201, result);
      return;
    }
    const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (request.method === "GET" && projectMatch) {
      const project = application.getProject(decodeURIComponent(projectMatch[1] ?? ""));
      if (!project) sendJson(response, 404, { error: "project_not_found" });
      else sendJson(response, 200, project);
      return;
    }
    const addItemMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/work-items$/);
    if (request.method === "POST" && addItemMatch) {
      const projectId = decodeURIComponent(addItemMatch[1] ?? "");
      const command = addWorkItemCommand.parse(await readJsonBody(request));
      const result = application.addWorkItem(projectId, command.workItem, commandContext(command));
      sendJson(response, 201, result);
      return;
    }
    const planProjectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/plan$/);
    if (request.method === "POST" && planProjectMatch) {
      const projectId = decodeURIComponent(planProjectMatch[1] ?? "");
      const command = planProjectCommand.parse(await readJsonBody(request));
      const current = application.getProject(projectId);
      if (!current) {
        sendJson(response, 404, { error: "project_not_found" });
        return;
      }
      if (current.revision !== command.expectedRevision) {
        throw new RevisionConflictError(`project:${projectId}`, command.expectedRevision, current.revision);
      }
      const planning = await application.planProject(projectId, command.agentId);
      sendJson(response, 200, planning);
      return;
    }
    const dependencyMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/dependencies$/);
    if (request.method === "POST" && dependencyMatch) {
      const projectId = decodeURIComponent(dependencyMatch[1] ?? "");
      const command = addDependencyCommand.parse(await readJsonBody(request));
      const result = application.addDependency(projectId, command.dependency, commandContext(command));
      sendJson(response, 201, result);
      return;
    }
    const agentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/agents$/);
    if (request.method === "POST" && agentMatch) {
      const projectId = decodeURIComponent(agentMatch[1] ?? "");
      const command = registerAgentCommand.parse(await readJsonBody(request));
      const result = application.registerAgent(
        projectId,
        { ...command.agent, createdAt: new Date().toISOString() },
        commandContext(command),
      );
      sendJson(response, 201, result);
      return;
    }
    const handoffMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/handoffs$/);
    if (request.method === "POST" && handoffMatch) {
      const projectId = decodeURIComponent(handoffMatch[1] ?? "");
      const command = recordAgentHandoffCommand.parse(await readJsonBody(request));
      const result = application.recordAgentHandoff(projectId, command.handoff, commandContext(command));
      sendJson(response, 201, result);
      return;
    }
    const setRolesMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/work-items\/([^/]+)\/roles$/);
    if (request.method === "POST" && setRolesMatch) {
      const projectId = decodeURIComponent(setRolesMatch[1] ?? "");
      const workItemId = decodeURIComponent(setRolesMatch[2] ?? "");
      const command = setWorkItemRolesCommand.parse(await readJsonBody(request));
      const result = application.setWorkItemRoles(projectId, workItemId, command.allowedRoles, commandContext(command));
      sendJson(response, 200, result);
      return;
    }
    const statusMatch = url.pathname.match(
      /^\/api\/projects\/([^/]+)\/work-items\/([^/]+)\/status$/,
    );
    if (request.method === "POST" && statusMatch) {
      const projectId = decodeURIComponent(statusMatch[1] ?? "");
      const workItemId = decodeURIComponent(statusMatch[2] ?? "");
      const command = changeStatusCommand.parse(await readJsonBody(request));
      const result = application.changeWorkItemStatus(
        projectId,
        workItemId,
        command.status,
        commandContext(command),
      );
      sendJson(response, 200, result);
      return;
    }
    const executeRunMatch = url.pathname.match(
      /^\/api\/projects\/([^/]+)\/work-items\/([^/]+)\/runs$/,
    );
    const startTerminalMatch = url.pathname.match(
      /^\/api\/projects\/([^/]+)\/work-items\/([^/]+)\/terminals$/,
    );
    if (request.method === "POST" && startTerminalMatch) {
      const projectId = decodeURIComponent(startTerminalMatch[1] ?? "");
      const workItemId = decodeURIComponent(startTerminalMatch[2] ?? "");
      const command = startTerminalCommand.parse(await readJsonBody(request));
      const terminal = await application.startTerminal({
        projectId, workItemId, agentId: command.agentId, role: command.role,
        cols: command.cols, rows: command.rows,
      }, commandContext(command));
      sendJson(response, 201, { terminal, project: application.getProject(projectId) });
      return;
    }
    if (request.method === "POST" && executeRunMatch) {
      const projectId = decodeURIComponent(executeRunMatch[1] ?? "");
      const workItemId = decodeURIComponent(executeRunMatch[2] ?? "");
      const command = executeAgentRunCommand.parse(await readJsonBody(request));
      const current = application.getProject(projectId);
      if (!current) {
        sendJson(response, 404, { error: "project_not_found" });
        return;
      }
      if (current.revision !== command.expectedRevision) {
        throw new RevisionConflictError(`project:${projectId}`, command.expectedRevision, current.revision);
      }
      const execution = await application.executeAgentRun({
        ...command.run,
        runId: command.run.runId ?? randomUUID(),
        projectId,
        workItemId,
      });
      sendJson(response, 200, { execution, project: application.getProject(projectId) });
      return;
    }
    const deliverMatch = url.pathname.match(
      /^\/api\/projects\/([^/]+)\/work-items\/([^/]+)\/deliver$/,
    );
    if (request.method === "POST" && deliverMatch) {
      const projectId = decodeURIComponent(deliverMatch[1] ?? "");
      const workItemId = decodeURIComponent(deliverMatch[2] ?? "");
      const command = deliverWorkItemCommand.parse(await readJsonBody(request));
      const current = application.getProject(projectId);
      if (!current) {
        sendJson(response, 404, { error: "project_not_found" });
        return;
      }
      if (current.revision !== command.expectedRevision) {
        throw new RevisionConflictError(`project:${projectId}`, command.expectedRevision, current.revision);
      }
      const delivery = await application.deliverWorkItem(projectId, workItemId);
      sendJson(response, 200, { delivery, project: application.getProject(projectId) });
      return;
    }
    const integrateMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/work-items\/([^/]+)\/integrate$/);
    if (request.method === "POST" && integrateMatch) {
      const projectId = decodeURIComponent(integrateMatch[1] ?? "");
      const workItemId = decodeURIComponent(integrateMatch[2] ?? "");
      const command = integrateWorkItemCommand.parse(await readJsonBody(request));
      const current = application.getProject(projectId);
      if (!current) { sendJson(response, 404, { error: "project_not_found" }); return; }
      if (current.revision !== command.expectedRevision) {
        throw new RevisionConflictError(`project:${projectId}`, command.expectedRevision, current.revision);
      }
      const merge = await application.integrateVerifiedWorkItem(projectId, workItemId, command.implementationRunId);
      sendJson(response, 200, { merge, project: application.getProject(projectId) });
      return;
    }
    const cancelRunMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancelRunMatch) {
      application.cancelAgentRun(
        decodeURIComponent(cancelRunMatch[1] ?? ""),
        decodeURIComponent(cancelRunMatch[2] ?? ""),
      );
      sendJson(response, 202, { cancelled: true });
      return;
    }
    const runEventsMatch = url.pathname.match(
      /^\/api\/projects\/([^/]+)\/runs\/([^/]+)\/events$/,
    );
    if (request.method === "GET" && runEventsMatch) {
      const projectId = decodeURIComponent(runEventsMatch[1] ?? "");
      const runId = decodeURIComponent(runEventsMatch[2] ?? "");
      const events = application.getRunEvents(
        projectId,
        runId,
        parseNonNegativeInteger(url.searchParams.get("afterRevision"), 0),
      );
      if (!events) sendJson(response, 404, { error: "run_not_found" });
      else sendJson(response, 200, { events });
      return;
    }
    const qualityMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/quality$/);
    if (request.method === "GET" && qualityMatch) {
      const projectId = decodeURIComponent(qualityMatch[1] ?? "");
      const reports = application.getQualityReports(projectId);
      if (!reports) sendJson(response, 404, { error: "project_not_found" });
      else sendJson(response, 200, { reports });
      return;
    }
    const artifactMatch = url.pathname.match(
      /^\/api\/projects\/([^/]+)\/artifacts\/([^/]+)$/,
    );
    if (request.method === "GET" && artifactMatch) {
      const projectId = decodeURIComponent(artifactMatch[1] ?? "");
      const artifactId = decodeURIComponent(artifactMatch[2] ?? "");
      const loaded = await application.readArtifact(projectId, artifactId);
      if (!loaded) sendJson(response, 404, { error: "artifact_not_found" });
      else sendBuffer(response, 200, loaded.content, loaded.artifact.mediaType);
      return;
    }
    const importKNowMatch = url.pathname.match(
      /^\/api\/projects\/([^/]+)\/imports\/k-now$/,
    );
    if (request.method === "POST" && importKNowMatch) {
      const projectId = decodeURIComponent(importKNowMatch[1] ?? "");
      const command = importKNowCommand.parse(await readJsonBody(request));
      const result = await application.importKNowFile(
        projectId,
        command.sourcePath,
        commandContext(command),
      );
      sendJson(response, 200, result);
      return;
    }
    const decisionMatch = url.pathname.match(
      /^\/api\/projects\/([^/]+)\/decisions\/([^/]+)\/resolve$/,
    );
    if (request.method === "POST" && decisionMatch) {
      const projectId = decodeURIComponent(decisionMatch[1] ?? "");
      const decisionId = decodeURIComponent(decisionMatch[2] ?? "");
      const command = resolveDecisionCommand.parse(await readJsonBody(request));
      const result = application.resolveDecision(
        projectId,
        decisionId,
        command.selectedOptionId,
        commandContext(command),
      );
      sendJson(response, 200, result);
      return;
    }
    if (request.method === "GET" && staticRoot && (await serveStatic(response, staticRoot, url.pathname))) {
      return;
    }
    sendJson(response, 404, { error: "route_not_found" });
  } catch (error) {
    handleError(response, error);
  }
}

async function serveStatic(
  response: ServerResponse,
  staticRoot: string,
  pathname: string,
): Promise<boolean> {
  const root = resolve(staticRoot);
  const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new RequestError(400, "invalid_static_path");
  }
  let filePath = candidate;
  try {
    if (!(await stat(filePath)).isFile()) return false;
  } catch {
    if (extname(relativePath)) return false;
    filePath = resolve(root, "index.html");
    try {
      if (!(await stat(filePath)).isFile()) return false;
    } catch {
      return false;
    }
  }
  const body = await readFile(filePath);
  const contentType =
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
    }[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": body.length,
    "cache-control": filePath.endsWith("index.html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
  });
  response.end(body);
  return true;
}

function commandContext(command: { expectedRevision: number; idempotencyKey: string }) {
  return {
    expectedRevision: command.expectedRevision,
    idempotencyKey: command.idempotencyKey,
    actorType: "user" as const,
    actorId: "local-owner",
  };
}

function inboxToken(request: IncomingMessage): string {
  const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization ?? "")?.[1];
  if (!token) throw new AgentInboxAuthError("missing agent inbox token");
  return token;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) throw new RequestError(413, "request_body_too_large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new RequestError(400, "request_body_required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RequestError(400, "invalid_json");
  }
}

function handleError(response: ServerResponse, error: unknown): void {
  if (error instanceof AgentInboxAuthError) {
    sendJson(response, 401, { error: "agent_inbox_unauthorized" });
    return;
  }
  if (error instanceof RequestError) {
    sendJson(response, error.status, { error: error.code });
    return;
  }
  if (error instanceof ZodError) {
    sendJson(response, 400, { error: "invalid_command", issues: error.issues });
    return;
  }
  if (
    error instanceof DomainRuleError ||
    error instanceof RevisionConflictError ||
    error instanceof IdempotencyConflictError
  ) {
    sendJson(response, 409, { error: error.name, message: error.message });
    return;
  }
  sendJson(response, 500, { error: "internal_error" });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
  });
  response.end(encoded);
}

function sendBuffer(
  response: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function sendSocket(socket: WebSocket, body: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
}

function sendTerminalSocket(socket: WebSocket, body: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 1_000_000) {
    socket.close(1013, "terminal client is too slow");
    return;
  }
  socket.send(JSON.stringify(body));
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isAllowedLocalRequest(request: IncomingMessage): boolean {
  try {
    const host = request.headers.host;
    if (!host) return false;
    const target = new URL(`http://${host}`);
    if (!isLoopbackHost(target.hostname.replace(/^\[|\]$/g, ""))) return false;
    const origin = request.headers.origin;
    if (!origin) return true;
    const source = new URL(origin);
    return source.protocol === "http:" && source.host === target.host;
  } catch {
    return false;
  }
}

function parseNonNegativeInteger(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

class RequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
  }
}

function readEventBacklog(application: StrewApplication, afterSequence: number): StoredEvent[] {
  const events: StoredEvent[] = [];
  let cursor = afterSequence;
  while (true) {
    const page = application.store.readAll(cursor, 5_000);
    events.push(...page);
    if (page.length < 5_000) return events;
    cursor = page.at(-1)?.sequence ?? cursor;
  }
}

function eventBelongsToProject(
  application: StrewApplication,
  projectId: string,
  event: StoredEvent,
): boolean {
  if (event.streamId === `project:${projectId}`) return true;
  if (!event.streamId.startsWith("run:")) return false;
  const runId = event.streamId.slice("run:".length);
  return Boolean(application.getProject(projectId)?.state.runs[runId]);
}
