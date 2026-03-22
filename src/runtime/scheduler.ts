import { CronExpressionParser } from "cron-parser";
import type { WorkflowStore } from "../store/workflow-store.js";
import type { Workflow } from "../types/workflow.js";
import { dispatch } from "./dispatcher.js";

export class WorkflowScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastChecked = new Map<string, number>();

  constructor(
    private store: WorkflowStore,
    private intervalMs: number = Number(
      process.env.WORKFLOW_SCHEDULER_INTERVAL_MS ?? 30_000
    )
  ) {}

  start(): void {
    if (this.timer) return;
    console.log(
      `Workflow scheduler started (interval: ${this.intervalMs}ms)`
    );
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Run an initial tick immediately
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("Workflow scheduler stopped");
    }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const workflows = await this.store.list();
      const now = new Date();

      for (const workflow of workflows) {
        if (this.shouldRun(workflow, now)) {
          this.lastChecked.set(workflow.id, now.getTime());
          try {
            await dispatch(this.store, workflow);
          } catch (err) {
            console.error(
              `Scheduler: execution failed for workflow ${workflow.id}:`,
              err
            );
          }
        }
      }
    } catch (err) {
      console.error("Scheduler: tick error:", err);
    } finally {
      this.running = false;
    }
  }

  private shouldRun(workflow: Workflow, now: Date): boolean {
    if (!workflow.enabled) return false;
    if (workflow.lastStatus === "running") return false;

    if (workflow.sleepUntil) {
      if (new Date(workflow.sleepUntil).getTime() > now.getTime()) return false;
    }

    try {
      const cron = CronExpressionParser.parse(workflow.schedule, { currentDate: now });
      const prev = cron.prev().toDate();

      // The most recent due time for this cron expression
      const dueAt = prev.getTime();

      // Don't re-run if we already triggered for this due window
      const lastCheck = this.lastChecked.get(workflow.id) ?? 0;
      if (lastCheck >= dueAt) return false;

      // Don't trigger if the workflow ran after the due time already
      if (workflow.lastRunAt) {
        const lastRun = new Date(workflow.lastRunAt).getTime();
        if (lastRun >= dueAt) return false;
      }

      return true;
    } catch {
      // Invalid cron expression — skip silently
      return false;
    }
  }
}
