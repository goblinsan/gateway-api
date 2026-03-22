import fs from "node:fs/promises";
import path from "node:path";
import type { Workflow } from "../types/workflow.js";

export class WorkflowStore {
  private workflows: Map<string, Workflow> = new Map();
  private filePath: string;
  private loaded = false;

  constructor(filePath?: string) {
    this.filePath =
      filePath ?? path.join(process.cwd(), "data", "workflows.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const records: Workflow[] = JSON.parse(raw);
      this.workflows = new Map(records.map((w) => [w.id, w]));
    } catch {
      // File doesn't exist yet — start empty
      this.workflows = new Map();
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const data = JSON.stringify([...this.workflows.values()], null, 2);
    await fs.writeFile(this.filePath, data, "utf-8");
  }

  async list(): Promise<Workflow[]> {
    await this.load();
    return [...this.workflows.values()];
  }

  async get(id: string): Promise<Workflow | undefined> {
    await this.load();
    return this.workflows.get(id);
  }

  async create(workflow: Workflow): Promise<Workflow> {
    await this.load();
    this.workflows.set(workflow.id, workflow);
    await this.persist();
    return workflow;
  }

  async update(id: string, patch: Partial<Workflow>): Promise<Workflow | undefined> {
    await this.load();
    const existing = this.workflows.get(id);
    if (!existing) return undefined;
    const updated: Workflow = { ...existing, ...patch, id: existing.id };
    this.workflows.set(id, updated);
    await this.persist();
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    await this.load();
    const existed = this.workflows.delete(id);
    if (existed) await this.persist();
    return existed;
  }
}
