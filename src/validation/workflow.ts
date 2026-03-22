import type {
  CreateWorkflowBody,
  UpdateWorkflowBody,
  SleepBody,
  WorkflowTarget,
  RetryPolicy,
} from "../types/workflow.js";

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isValidTarget(v: unknown): v is WorkflowTarget {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return isNonEmptyString(obj.type) && isNonEmptyString(obj.ref);
}

function isValidRetryPolicy(v: unknown): v is RetryPolicy {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (
    obj.maxAttempts !== undefined &&
    (typeof obj.maxAttempts !== "number" || obj.maxAttempts < 1)
  )
    return false;
  if (
    obj.backoffSeconds !== undefined &&
    (typeof obj.backoffSeconds !== "number" || obj.backoffSeconds < 0)
  )
    return false;
  return true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

export function validateCreate(body: unknown): { error?: string; value?: CreateWorkflowBody } {
  if (!isPlainObject(body)) return { error: "Request body must be a JSON object" };

  if (!isNonEmptyString(body.name)) return { error: "'name' is required and must be a non-empty string" };
  if (!isNonEmptyString(body.schedule)) return { error: "'schedule' is required and must be a non-empty string" };
  if (!isValidTarget(body.target)) return { error: "'target' must be an object with non-empty 'type' and 'ref'" };

  if (body.enabled !== undefined && typeof body.enabled !== "boolean")
    return { error: "'enabled' must be a boolean" };
  if (body.input !== undefined && !isPlainObject(body.input))
    return { error: "'input' must be a JSON object" };
  if (body.secrets !== undefined && !isStringArray(body.secrets))
    return { error: "'secrets' must be an array of strings" };
  if (body.timeoutSeconds !== undefined && (typeof body.timeoutSeconds !== "number" || body.timeoutSeconds < 1))
    return { error: "'timeoutSeconds' must be a positive number" };
  if (body.retryPolicy !== undefined && !isValidRetryPolicy(body.retryPolicy))
    return { error: "'retryPolicy' must be an object with optional 'maxAttempts' (>=1) and 'backoffSeconds' (>=0)" };

  return {
    value: {
      name: body.name as string,
      schedule: body.schedule as string,
      target: body.target as WorkflowTarget,
      enabled: (body.enabled as boolean | undefined) ?? true,
      input: body.input as Record<string, unknown> | undefined,
      secrets: body.secrets as string[] | undefined,
      timeoutSeconds: body.timeoutSeconds as number | undefined,
      retryPolicy: body.retryPolicy as RetryPolicy | undefined,
    },
  };
}

export function validateUpdate(body: unknown): { error?: string; value?: UpdateWorkflowBody } {
  if (!isPlainObject(body)) return { error: "Request body must be a JSON object" };

  if (body.name !== undefined && !isNonEmptyString(body.name))
    return { error: "'name' must be a non-empty string" };
  if (body.schedule !== undefined && !isNonEmptyString(body.schedule))
    return { error: "'schedule' must be a non-empty string" };
  if (body.target !== undefined && !isValidTarget(body.target))
    return { error: "'target' must be an object with non-empty 'type' and 'ref'" };
  if (body.enabled !== undefined && typeof body.enabled !== "boolean")
    return { error: "'enabled' must be a boolean" };
  if (body.input !== undefined && !isPlainObject(body.input))
    return { error: "'input' must be a JSON object" };
  if (body.secrets !== undefined && !isStringArray(body.secrets))
    return { error: "'secrets' must be an array of strings" };
  if (body.timeoutSeconds !== undefined && (typeof body.timeoutSeconds !== "number" || body.timeoutSeconds < 1))
    return { error: "'timeoutSeconds' must be a positive number" };
  if (body.retryPolicy !== undefined && !isValidRetryPolicy(body.retryPolicy))
    return { error: "'retryPolicy' must be an object with optional 'maxAttempts' (>=1) and 'backoffSeconds' (>=0)" };

  const value: UpdateWorkflowBody = {};
  if (body.name !== undefined) value.name = body.name as string;
  if (body.schedule !== undefined) value.schedule = body.schedule as string;
  if (body.target !== undefined) value.target = body.target as WorkflowTarget;
  if (body.enabled !== undefined) value.enabled = body.enabled as boolean;
  if (body.input !== undefined) value.input = body.input as Record<string, unknown>;
  if (body.secrets !== undefined) value.secrets = body.secrets as string[];
  if (body.timeoutSeconds !== undefined) value.timeoutSeconds = body.timeoutSeconds as number;
  if (body.retryPolicy !== undefined) value.retryPolicy = body.retryPolicy as RetryPolicy;
  return { value };
}

export function validateSleep(body: unknown): { error?: string; value?: SleepBody } {
  if (!isPlainObject(body)) return { error: "Request body must be a JSON object" };
  if (!isNonEmptyString(body.until)) return { error: "'until' is required and must be an ISO 8601 timestamp" };

  const date = new Date(body.until as string);
  if (isNaN(date.getTime())) return { error: "'until' must be a valid ISO 8601 timestamp" };
  if (date.getTime() <= Date.now()) return { error: "'until' must be a future timestamp" };

  return { value: { until: date.toISOString() } };
}
