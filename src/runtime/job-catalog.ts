import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface JobMetadata {
  id: string;
  name: string;
  description: string;
}

export interface LoadedJobModule {
  meta: JobMetadata;
  run: (context: unknown) => Promise<unknown>;
}

function getCatalogDir(): string {
  return process.env.GATEWAY_JOB_CATALOG_DIR?.trim() || path.join(process.cwd(), "jobs", "catalog");
}

function assertJobId(jobId: string): void {
  if (!/^[a-z0-9_-]+$/i.test(jobId)) {
    throw new Error(`Invalid job id: ${jobId}`);
  }
}

async function importJobModule(filePath: string): Promise<LoadedJobModule> {
  const imported = await import(pathToFileURL(filePath).href) as Record<string, unknown>;
  const meta = imported.meta;
  const run = imported.run;

  if (!meta || typeof meta !== "object") {
    throw new Error(`Job module ${filePath} is missing exported meta`);
  }
  if (typeof run !== "function") {
    throw new Error(`Job module ${filePath} is missing exported run(context)`);
  }

  const record = meta as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()) {
    throw new Error(`Job module ${filePath} has invalid meta.id`);
  }
  if (typeof record.name !== "string" || !record.name.trim()) {
    throw new Error(`Job module ${filePath} has invalid meta.name`);
  }
  if (typeof record.description !== "string" || !record.description.trim()) {
    throw new Error(`Job module ${filePath} has invalid meta.description`);
  }

  return {
    meta: {
      id: record.id,
      name: record.name,
      description: record.description,
    },
    run: run as (context: unknown) => Promise<unknown>,
  };
}

export async function loadJobModule(jobId: string): Promise<LoadedJobModule> {
  assertJobId(jobId);
  const filePath = path.join(getCatalogDir(), `${jobId}.js`);
  try {
    await access(filePath);
  } catch {
    throw new Error(`Job not found: ${jobId}`);
  }
  return importJobModule(filePath);
}

export async function listJobModules(): Promise<JobMetadata[]> {
  const dir = getCatalogDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const jobs: JobMetadata[] = [];
  for (const entry of entries.filter((candidate) => candidate.endsWith(".js")).sort()) {
    const module = await importJobModule(path.join(dir, entry));
    jobs.push(module.meta);
  }
  return jobs;
}
