import { Router, type Request, type Response } from "express";
import type { WorkflowStore } from "../store/workflow-store.js";
import type { Workflow } from "../types/workflow.js";

function paramId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0]! : id;
}

export interface ExecutionResult {
  workflowId: string;
  status: Workflow["lastStatus"];
  startedAt: string;
  completedAt: string;
  error?: string;
}

/**
 * Core execution logic shared by both the public /run and internal /execute paths.
 * This is a stub — replace with real execution dispatch when the workflow engine is built.
 */
export async function executeWorkflow(
  store: WorkflowStore,
  workflowId: string
): Promise<ExecutionResult> {
  const startedAt = new Date().toISOString();

  // Mark as running
  await store.update(workflowId, {
    lastStatus: "running",
    lastRunAt: startedAt,
    lastError: null,
    updatedAt: startedAt,
  });

  // --- Stub: replace with real execution dispatch ---
  // In a real implementation this would invoke the target (e.g. shell command,
  // HTTP call, container run) and stream/await results. For now we simulate
  // an immediate success.
  const completedAt = new Date().toISOString();

  await store.update(workflowId, {
    lastStatus: "success",
    lastError: null,
    updatedAt: completedAt,
  });

  return {
    workflowId,
    status: "success",
    startedAt,
    completedAt,
  };
}

export function createInternalWorkflowRouter(store: WorkflowStore): Router {
  const router = Router();

  // Internal execution hook — called by the control plane scheduler
  router.post("/:id/execute", async (req: Request, res: Response): Promise<void> => {
    const workflow = await store.get(paramId(req));
    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    if (workflow.lastStatus === "running") {
      res.status(409).json({ error: "Workflow is already running" });
      return;
    }

    const result = await executeWorkflow(store, workflow.id);
    res.json(result);
  });

  return router;
}
