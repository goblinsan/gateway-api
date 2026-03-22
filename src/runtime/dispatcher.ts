import type { Workflow } from "../types/workflow.js";
import type { WorkflowStore } from "../store/workflow-store.js";
import { executeAgentTurn } from "./agent-turn.js";

export interface ExecutionResult {
  workflowId: string;
  status: Workflow["lastStatus"];
  startedAt: string;
  completedAt: string;
  error?: string;
}

export async function dispatch(
  store: WorkflowStore,
  workflow: Workflow
): Promise<ExecutionResult> {
  const startedAt = new Date().toISOString();

  await store.update(workflow.id, {
    lastStatus: "running",
    lastRunAt: startedAt,
    lastError: null,
    updatedAt: startedAt,
  });

  let result: ExecutionResult;

  try {
    switch (workflow.target.type) {
      case "gateway-chat-platform.agent-turn":
        await executeAgentTurn(workflow);
        result = {
          workflowId: workflow.id,
          status: "success",
          startedAt,
          completedAt: new Date().toISOString(),
        };
        break;

      default:
        result = {
          workflowId: workflow.id,
          status: "failed",
          startedAt,
          completedAt: new Date().toISOString(),
          error: `Unsupported workflow target: ${workflow.target.type}`,
        };
        break;
    }
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unknown execution error";
    result = {
      workflowId: workflow.id,
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      error: message,
    };
  }

  await store.update(workflow.id, {
    lastStatus: result.status,
    lastError: result.error ?? null,
    updatedAt: result.completedAt,
  });

  return result;
}
