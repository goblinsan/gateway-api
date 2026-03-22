export interface WorkflowTarget {
  type: string;
  ref: string;
}

export interface RetryPolicy {
  maxAttempts?: number;
  backoffSeconds?: number;
}

export type WorkflowStatus = "idle" | "running" | "success" | "failed" | "sleeping";

export interface Workflow {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  sleepUntil: string | null;
  target: WorkflowTarget;
  input?: Record<string, unknown>;
  secrets?: string[];
  timeoutSeconds?: number;
  retryPolicy?: RetryPolicy;
  lastRunAt: string | null;
  lastStatus: WorkflowStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkflowBody {
  name: string;
  schedule: string;
  target: WorkflowTarget;
  enabled?: boolean;
  input?: Record<string, unknown>;
  secrets?: string[];
  timeoutSeconds?: number;
  retryPolicy?: RetryPolicy;
}

export interface UpdateWorkflowBody {
  name?: string;
  schedule?: string;
  target?: WorkflowTarget;
  enabled?: boolean;
  input?: Record<string, unknown>;
  secrets?: string[];
  timeoutSeconds?: number;
  retryPolicy?: RetryPolicy;
}

export interface SleepBody {
  until: string;
}
