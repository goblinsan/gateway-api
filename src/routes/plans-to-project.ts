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
  limits: { fileSize: 1024 * 1024 },
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

interface PreflightResponse {
  status: string;
  errors?: string[];
  project?: { name?: string };
  repository?: {
    requested?: string;
    owner?: string;
    name?: string;
    exactMatch?: boolean;
    resolvedFullName?: string;
    similar?: Array<{ fullName: string; description?: string }>;
  };
}

const PREVIEW_TIMEOUT_MS = 120_000;

export const plansToProjectRouter = Router();

function parseTruthy(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

function safeTrim(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseJsonOutput<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

async function runGhp(args: string[]) {
  return execFileAsync(GHP_BINARY, args, {
    env: { ...process.env },
    timeout: PREVIEW_TIMEOUT_MS,
  });
}

async function runPreflight(planPath: string): Promise<PreflightResponse> {
  const { stdout } = await runGhp(["preflight", "-f", planPath]);
  return parseJsonOutput<PreflightResponse>(stdout);
}

function buildApplyArgs(req: Request): string[] {
  const args = ["apply", "-f", req.file!.path];
  if (req.query.dryRun === "true") {
    args.push("--dry-run");
  }

  const repositoryOverride = safeTrim(req.body?.repositoryOverride);
  if (repositoryOverride) {
    args.push("--repository-override", repositoryOverride);
  }

  if (parseTruthy(req.body?.createRepoIfMissing) || req.query.createRepoIfMissing === "true") {
    args.push("--create-repo-if-missing");
  }

  return args;
}

plansToProjectRouter.post(
  "/validate",
  upload.single("plan"),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "No plan file uploaded" });
      return;
    }

    try {
      const { stdout } = await runGhp(["validate", "-f", req.file.path]);
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
  "/preflight",
  upload.single("plan"),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "No plan file uploaded" });
      return;
    }

    try {
      const report = await runPreflight(req.file.path);
      res.json(report);
    } catch (err: unknown) {
      const execErr = err as { stderr?: string; stdout?: string; message?: string };
      const stdout = execErr.stdout?.trim();
      if (stdout) {
        try {
          res.status(200).json(parseJsonOutput<PreflightResponse>(stdout));
          return;
        } catch {
          // fall through to generic error handling
        }
      }
      res.status(500).json({
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

    const args = buildApplyArgs(req);

    try {
      const { stdout, stderr } = await runGhp(args);
      res.json({
        success: true,
        output: stdout.trim(),
        warnings: stderr.trim() || undefined,
      });
    } catch (err: unknown) {
      const execErr = err as { stderr?: string; message?: string };
      res.status(500).json({
        success: false,
        error: execErr.stderr?.trim() || execErr.message,
      });
    } finally {
      await fs.unlink(req.file.path).catch(() => {});
    }
  }
);

plansToProjectRouter.post(
  "/plan",
  upload.single("plan"),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "No plan file uploaded" });
      return;
    }

    try {
      const preflight = await runPreflight(req.file.path);
      if (preflight.status === "invalid") {
        res.status(422).json({
          success: false,
          stage: "preflight",
          preflight,
        });
        return;
      }

      const repositoryOverride = safeTrim(req.body?.repositoryOverride);
      const createRepoIfMissing = parseTruthy(req.body?.createRepoIfMissing) || req.query.createRepoIfMissing === "true";

      if (preflight.status === "repo_resolution_required" && !repositoryOverride) {
        res.status(409).json({
          success: false,
          stage: "repo_resolution_required",
          preflight,
        });
        return;
      }

      if (preflight.status === "create_repo_confirmation_required" && !createRepoIfMissing) {
        res.status(409).json({
          success: false,
          stage: "create_repo_confirmation_required",
          preflight,
        });
        return;
      }

      const { stdout, stderr } = await runGhp(buildApplyArgs(req));
      res.json({
        success: true,
        stage: "apply",
        preflight,
        output: stdout.trim(),
        warnings: stderr.trim() || undefined,
      });
    } catch (err: unknown) {
      const execErr = err as { stderr?: string; message?: string };
      res.status(500).json({
        success: false,
        error: execErr.stderr?.trim() || execErr.message,
      });
    } finally {
      await fs.unlink(req.file.path).catch(() => {});
    }
  }
);
