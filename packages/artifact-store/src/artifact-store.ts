import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { Artifact, ArtifactKind } from "../../domain/src/index.ts";

export interface WriteArtifactInput {
  artifactId?: string;
  projectId: string;
  workItemId: string;
  runId: string;
  kind: ArtifactKind;
  content: string | Uint8Array;
  mediaType: string;
  extension?: string;
  imported?: boolean;
  createdAt?: string;
}

export class LocalArtifactStore {
  readonly repositoryPath: string;
  readonly artifactsRoot: string;
  private ignoreReady: Promise<void> | null = null;

  constructor(repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath);
    this.artifactsRoot = resolve(this.repositoryPath, ".strew", "artifacts");
  }

  async write(input: WriteArtifactInput): Promise<Artifact> {
    this.ignoreReady ??= ensureArtifactsIgnored(this.repositoryPath);
    await this.ignoreReady;
    const content = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : Buffer.from(input.content);
    const contentHash = createHash("sha256").update(content).digest("hex");
    const artifactId = input.artifactId ?? randomUUID();
    const extension = normalizeExtension(input.extension);
    const directory = resolve(
      this.artifactsRoot,
      safeSegment(input.projectId),
      safeSegment(input.workItemId),
      safeSegment(input.runId),
    );
    const absolutePath = resolve(directory, `${safeSegment(artifactId)}-${contentHash.slice(0, 12)}${extension}`);
    assertDescendant(this.artifactsRoot, absolutePath);
    await mkdir(directory, { recursive: true });
    try {
      const handle = await open(absolutePath, "wx");
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await readFile(absolutePath);
      const existingHash = createHash("sha256").update(existing).digest("hex");
      if (existingHash !== contentHash) {
        throw new ArtifactStoreError(`artifact path collision at '${absolutePath}'`);
      }
    }
    return {
      artifactId,
      projectId: input.projectId,
      workItemId: input.workItemId,
      runId: input.runId,
      kind: input.kind,
      relativePath: relative(this.repositoryPath, absolutePath).replaceAll("\\", "/"),
      contentHash,
      byteLength: content.byteLength,
      mediaType: input.mediaType,
      imported: input.imported ?? false,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
  }

  async read(artifact: Artifact): Promise<Buffer> {
    const path = resolve(this.repositoryPath, artifact.relativePath);
    assertDescendant(this.artifactsRoot, path);
    const content = await readFile(path);
    const contentHash = createHash("sha256").update(content).digest("hex");
    if (contentHash !== artifact.contentHash) {
      throw new ArtifactStoreError(`artifact '${artifact.artifactId}' failed content hash verification`);
    }
    return content;
  }
}

async function ensureArtifactsIgnored(repositoryPath: string): Promise<void> {
  let gitPath: string;
  try {
    const { stdout } = await promisify(execFile)("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: repositoryPath, windowsHide: true,
    });
    gitPath = resolve(repositoryPath, stdout.trim());
  } catch {
    return; // ArtifactStore also supports plain directories in tests and imports.
  }
  let existing = "";
  try {
    existing = await readFile(gitPath, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
  }
  if (existing.split(/\r?\n/).some((line) => line.trim() === "/.strew/")) return;
  await appendFile(gitPath, `${existing && !existing.endsWith("\n") ? "\n" : ""}/.strew/\n`);
}

export class ArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

function safeSegment(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  if (!normalized) throw new ArtifactStoreError("artifact identifiers must contain a safe path segment");
  return normalized.slice(0, 120);
}

function normalizeExtension(value: string | undefined): string {
  if (!value) return "";
  const extension = value.startsWith(".") ? value : `.${value}`;
  if (!/^\.[a-zA-Z0-9_-]{1,16}$/.test(extension)) throw new ArtifactStoreError("artifact extension is invalid");
  return extension.toLowerCase();
}

function assertDescendant(root: string, candidate: string): void {
  if (!isAbsolute(root) || !isAbsolute(candidate)) throw new ArtifactStoreError("artifact paths must be absolute");
  const descendant = relative(root, candidate);
  if (!descendant || descendant === ".." || descendant.startsWith(`..\\`) || descendant.startsWith("../") || isAbsolute(descendant)) {
    throw new ArtifactStoreError(`artifact path '${candidate}' escapes '${root}'`);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}
