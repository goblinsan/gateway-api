import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { plansToProjectRouter } from "./routes/plans-to-project.js";
import { createWorkflowRouter } from "./routes/workflows.js";
import { createInternalWorkflowRouter } from "./routes/internal-workflows.js";
import { WorkflowStore } from "./store/workflow-store.js";

function getConfiguredPlanApiKey(): string | undefined {
  const value = process.env.GATEWAY_API_KEY?.trim();
  return value ? value : undefined;
}

function getPresentedApiKey(req: Request): string | undefined {
  const xApiKey = req.header("x-api-key")?.trim();
  if (xApiKey) {
    return xApiKey;
  }

  const authorization = req.header("authorization")?.trim();
  if (!authorization) {
    return undefined;
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return undefined;
  }

  return token.trim() || undefined;
}

function apiKeysMatch(expected: string, presented: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const presentedBuffer = Buffer.from(presented);
  if (expectedBuffer.length !== presentedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, presentedBuffer);
}

function requirePlanApiKey(req: Request, res: Response, next: NextFunction): void {
  const configuredKey = getConfiguredPlanApiKey();
  if (!configuredKey) {
    next();
    return;
  }

  const presentedKey = getPresentedApiKey(req);
  if (!presentedKey) {
    res.status(401).json({ error: "Missing API key" });
    return;
  }

  if (!apiKeysMatch(configuredKey, presentedKey)) {
    res.status(403).json({ error: "Invalid API key" });
    return;
  }

  next();
}

export function createApp(store?: WorkflowStore) {
  const app = express();
  const workflowStore = store ?? new WorkflowStore();

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/plans-to-project", requirePlanApiKey, plansToProjectRouter);
  app.use("/api/workflows", createWorkflowRouter(workflowStore));
  app.use("/internal/workflows", createInternalWorkflowRouter(workflowStore));

  return { app, workflowStore };
}
