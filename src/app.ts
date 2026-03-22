import express from "express";
import { plansToProjectRouter } from "./routes/plans-to-project.js";
import { createWorkflowRouter } from "./routes/workflows.js";
import { createInternalWorkflowRouter } from "./routes/internal-workflows.js";
import { WorkflowStore } from "./store/workflow-store.js";

export function createApp(store?: WorkflowStore) {
  const app = express();
  const workflowStore = store ?? new WorkflowStore();

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/plans-to-project", plansToProjectRouter);
  app.use("/api/workflows", createWorkflowRouter(workflowStore));
  app.use("/internal/workflows", createInternalWorkflowRouter(workflowStore));

  return { app, workflowStore };
}
