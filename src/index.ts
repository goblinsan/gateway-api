import { createApp } from "./app.js";
import { WorkflowScheduler } from "./runtime/scheduler.js";

const { app, workflowStore } = createApp();
const port = process.env.PORT ?? 3000;
const host = process.env.HOST ?? "0.0.0.0";

const schedulerEnabled =
  (process.env.WORKFLOW_SCHEDULER_ENABLED ?? "true") === "true";

app.listen(port, () => {
  console.log(`Gateway API listening on ${host}:${port}`);

  if (schedulerEnabled) {
    const scheduler = new WorkflowScheduler(workflowStore);
    scheduler.start();
  }
});
