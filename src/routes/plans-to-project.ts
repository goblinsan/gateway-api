import { Router, type Request, type Response } from "express";
import multer from "multer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const execFileAsync = promisify(execFile);

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 1024 * 1024 }, // 1MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === ".yaml" || ext === ".yml") {
      cb(null, true);
    } else {
      cb(new Error("Only .yaml/.yml files are accepted"));
    }
  },
});

const GHP_BINARY = process.env.GHP_BINARY ?? "ghp";

export const plansToProjectRouter = Router();

plansToProjectRouter.post(
  "/validate",
  upload.single("plan"),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "No plan file uploaded" });
      return;
    }

    try {
      const { stdout } = await execFileAsync(GHP_BINARY, [
        "validate",
        "-f",
        req.file.path,
      ]);
      res.json({ valid: true, output: stdout.trim() });
    } catch (err: unknown) {
      const execErr = err as { stderr?: string; message?: string };
      res.status(422).json({
        valid: false,
        error: execErr.stderr?.trim() || execErr.message,
      });
    } finally {
      await fs.unlink(req.file.path).catch(() => {});
    }
  }
);

plansToProjectRouter.post(
  "/apply",
  upload.single("plan"),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "No plan file uploaded" });
      return;
    }

    const dryRun = req.query.dryRun === "true";
    const args = ["apply", "-f", req.file.path];
    if (dryRun) {
      args.push("--dry-run");
    }

    try {
      const { stdout, stderr } = await execFileAsync(GHP_BINARY, args, {
        env: { ...process.env },
        timeout: 120_000,
      });
      res.json({
        success: true,
        output: stdout.trim(),
        warnings: stderr.trim() || undefined,
      });
    } catch (err: unknown) {
      const execErr = err as { stderr?: string; message?: string; code?: number };
      res.status(500).json({
        success: false,
        error: execErr.stderr?.trim() || execErr.message,
      });
    } finally {
      await fs.unlink(req.file.path).catch(() => {});
    }
  }
);
