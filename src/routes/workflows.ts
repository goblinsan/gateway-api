import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { WorkflowStore } from "../store/workflow-store.js";
import type { Workflow } from "../types/workflow.js";
import { validateCreate, validateUpdate, validateSleep } from "../validation/workflow.js";
import { executeWorkflow } from "./internal-workflows.js";

function paramId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0]! : id;
}

export function createWorkflowRouter(store: WorkflowStore): Router {
  const router = Router();

  // List all workflows
  router.get("/", async (_req: Request, res: Response): Promise<void> => {
    const workflows = await store.list();
    res.json(workflows);
  });

  // Get a single workflow
  router.get("/:id", async (req: Request, res: Response): Promise<void> => {
    const workflow = await store.get(paramId(req));
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    res.json(workflow);
  });

  // Create a workflow
  router.post("/", async (req: Request, res: Response): Promise<void> => {
    const { error, value } = validateCreate(req.body);
    if (error || !value) {
      res.status(400).json({ error });
      return;
    }

    const now = new Date().toISOString();
    const workflow: Workflow = {
      id: crypto.randomUUID(),
      name: value.name,
      enabled: value.enabled ?? true,
      schedule: value.schedule,
      sleepUntil: null,
      target: value.target,
      input: value.input,
      secrets: value.secrets,
      timeoutSeconds: value.timeoutSeconds,
      retryPolicy: value.retryPolicy,
      lastRunAt: null,
      lastStatus: "idle",
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };

    await store.create(workflow);
    res.status(201).json(workflow);
  });

  // Update a workflow
  router.put("/:id", async (req: Request, res: Response): Promise<void> => {
    const existing = await store.get(paramId(req));
    if (!existing) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    const { error, value } = validateUpdate(req.body);
    if (error || !value) {
      res.status(400).json({ error });
      return;
    }

    const updated = await store.update(paramId(req), {
      ...value,
      updatedAt: new Date().toISOString(),
    });
    res.json(updated);
  });

  // Delete a workflow
  router.delete("/:id", async (req: Request, res: Response): Promise<void> => {
    const deleted = await store.delete(paramId(req));
    if (!deleted) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }
    res.status(204).end();
  });

  // Enable a workflow
  router.post("/:id/enable", async (req: Request, res: Response): Promise<void> => {
    const existing = await store.get(paramId(req));
    if (!existing) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    const updated = await store.update(paramId(req), {
      enabled: true,
      updatedAt: new Date().toISOString(),
    });
    res.json(updated);
  });

  // Disable a workflow
  router.post("/:id/disable", async (req: Request, res: Response): Promise<void> => {
    const existing = await store.get(paramId(req));
    if (!existing) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    const updated = await store.update(paramId(req), {
      enabled: false,
      updatedAt: new Date().toISOString(),
    });
    res.json(updated);
  });

  // Sleep a workflow until a given timestamp
  router.post("/:id/sleep", async (req: Request, res: Response): Promise<void> => {
    const existing = await store.get(paramId(req));
    if (!existing) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    const { error, value } = validateSleep(req.body);
    if (error || !value) {
      res.status(400).json({ error });
      return;
    }

    const updated = await store.update(paramId(req), {
      sleepUntil: value.until,
      lastStatus: "sleeping",
      updatedAt: new Date().toISOString(),
    });
    res.json(updated);
  });

  // Resume a sleeping workflow
  router.post("/:id/resume", async (req: Request, res: Response): Promise<void> => {
    const existing = await store.get(paramId(req));
    if (!existing) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    const updated = await store.update(paramId(req), {
      sleepUntil: null,
      lastStatus: existing.lastStatus === "sleeping" ? "idle" : existing.lastStatus,
      updatedAt: new Date().toISOString(),
    });
    res.json(updated);
  });

  // Trigger a workflow run (public management route)
  router.post("/:id/run", async (req: Request, res: Response): Promise<void> => {
    const existing = await store.get(paramId(req));
    if (!existing) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    if (!existing.enabled) {
      res.status(409).json({ error: "Workflow is disabled" });
      return;
    }

    if (existing.lastStatus === "running") {
      res.status(409).json({ error: "Workflow is already running" });
      return;
    }

    const result = await executeWorkflow(store, existing.id);
    res.json(result);
  });

  return router;
}
