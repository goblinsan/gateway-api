import { Router, type Request, type Response } from "express";
import type { WorkflowStore } from "../store/workflow-store.js";
import { dispatch, type ExecutionResult } from "../runtime/dispatcher.js";

function paramId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0]! : id;
}

export { type ExecutionResult };

export async function executeWorkflow(
  store: WorkflowStore,
  workflowId: string
): Promise<ExecutionResult> {
  const workflow = await store.get(workflowId);
  if (!workflow) {
    throw new Error(`Workflow not found: ${workflowId}`);
  }
  return dispatch(store, workflow);
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

    const result = await dispatch(store, workflow);
    res.json(result);
  });

  return router;
}
