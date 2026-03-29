import { Router, type Request, type Response } from "express";
import { listJobModules } from "../runtime/job-catalog.js";

export function createJobsRouter(): Router {
  const router = Router();

  router.get("/", async (_req: Request, res: Response): Promise<void> => {
    const jobs = await listJobModules();
    res.json({ jobs });
  });

  return router;
}
