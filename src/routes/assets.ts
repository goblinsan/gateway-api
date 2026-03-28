import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import fs from "node:fs/promises";
import os from "node:os";
import {
  validateRepository,
  validateDestinationPath,
  validateBranch,
  isAllowedExtension,
  validateAssetPath,
  MAX_FILE_SIZE,
} from "../validation/asset.js";
import type { AssetResult, AssetUploadResponse } from "../types/asset.js";
import type { AssetWriter } from "../github/asset-writer.js";

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_FILE_SIZE },
});

interface UploadRequestBody {
  repository?: unknown;
  destinationPath?: unknown;
  overwrite?: unknown;
  branch?: unknown;
  commitMessage?: unknown;
}

function parseBooleanField(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  return false;
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function overallStatus(results: AssetResult[]): number {
  const allRejected = results.every((r) => r.status === "rejected");
  if (allRejected) return 422;
  const hasRejectedOrFailed = results.some((r) => r.status === "rejected" || r.status === "failed" || r.status === "skipped");
  if (hasRejectedOrFailed) return 207;
  return 200;
}

export function createAssetsRouter(writer: AssetWriter): Router {
  const router = Router();

  router.post(
    "/",
    upload.array("assets"),
    async (req: Request<unknown, unknown, UploadRequestBody>, res: Response): Promise<void> => {
      const files = req.files as Express.Multer.File[] | undefined;
      const body = req.body as UploadRequestBody;

      const repoValidation = validateRepository(body.repository);
      if (repoValidation.error) {
        console.log(`assets: request rejected — ${repoValidation.error}`);
        res.status(400).json({ error: repoValidation.error });
        await cleanupFiles(files);
        return;
      }

      const pathValidation = validateDestinationPath(body.destinationPath);
      if (pathValidation.error) {
        console.log(`assets: request rejected — ${pathValidation.error}`);
        res.status(400).json({ error: pathValidation.error });
        await cleanupFiles(files);
        return;
      }

      const branchValidation = validateBranch(body.branch);
      if (branchValidation.error) {
        console.log(`assets: request rejected — ${branchValidation.error}`);
        res.status(400).json({ error: branchValidation.error });
        await cleanupFiles(files);
        return;
      }

      if (!files || files.length === 0) {
        console.log("assets: request rejected — no files provided");
        res.status(400).json({ error: "At least one asset file must be uploaded via the 'assets' field" });
        return;
      }

      const repository = repoValidation.value!;
      const destinationPath = pathValidation.value!;
      const branch = branchValidation.value!;
      const overwrite = parseBooleanField(body.overwrite);
      const commitMessage = safeString(body.commitMessage) ?? `Upload assets`;

      const [owner, repo] = repository.split("/");

      const results: AssetResult[] = [];

      for (const file of files) {
        const filename = file.originalname;

        if (!isAllowedExtension(filename)) {
          const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")).toLowerCase() : "(none)";
          console.log(`assets: rejected ${filename} — unsupported_file_type (${ext}) in ${repository}`);
          results.push({
            filename,
            path: `${destinationPath}/${filename}`,
            size: file.size,
            status: "rejected",
            error: "unsupported_file_type",
            message: `File type ${ext} is not permitted`,
          });
          await fs.unlink(file.path).catch(() => {});
          continue;
        }

        const assetPathValidation = validateAssetPath(destinationPath, filename);
        if (assetPathValidation.error) {
          console.log(`assets: rejected ${filename} — invalid_path: ${assetPathValidation.error}`);
          results.push({
            filename,
            path: `${destinationPath}/${filename}`,
            size: file.size,
            status: "rejected",
            error: "invalid_path",
            message: assetPathValidation.error,
          });
          await fs.unlink(file.path).catch(() => {});
          continue;
        }

        const assetPath = assetPathValidation.value!;

        try {
          const existsResult = await writer.fileExists(owner, repo, assetPath, branch);

          if (existsResult.exists && !overwrite) {
            console.log(`assets: skipped ${filename} — already exists at ${repository}:${assetPath} on branch '${branch}'`);
            results.push({
              filename,
              path: assetPath,
              size: file.size,
              status: "skipped",
              error: "already_exists",
              message: `'${assetPath}' already exists in ${repository} on branch '${branch}'. Set overwrite=true to replace it.`,
              sha: existsResult.sha,
            });
            await fs.unlink(file.path).catch(() => {});
            continue;
          }

          const content = await fs.readFile(file.path);
          const writeResult = await writer.writeFile({
            owner,
            repo,
            path: assetPath,
            content,
            message: commitMessage,
            branch,
            sha: existsResult.exists ? existsResult.sha : undefined,
          });

          const uploadStatus = writeResult.created ? "created" : "updated";
          console.log(`assets: ${uploadStatus} ${filename} → ${repository}:${assetPath} on branch '${branch}' (sha: ${writeResult.sha})`);
          results.push({
            filename,
            path: assetPath,
            size: file.size,
            status: uploadStatus,
            sha: writeResult.sha,
          });
        } catch (err: unknown) {
          const apiErr = err as { statusCode?: number; message?: string };
          const statusCode = apiErr.statusCode;

          let error: AssetResult["error"];
          let message: string;

          if (statusCode === 404) {
            error = "repository_not_found";
            message = `Repository '${repository}' was not found or is not accessible`;
          } else if (statusCode === 401 || statusCode === 403) {
            error = "authorization_failed";
            message = `Not authorized to write to repository '${repository}'`;
          } else {
            error = "repository_write_failed";
            message = apiErr.message ?? "An unexpected error occurred while writing to the repository";
          }

          console.error(`assets: write failed for ${filename} in ${repository}:${assetPath} — ${error}: ${message}`);
          results.push({
            filename,
            path: assetPath,
            size: file.size,
            status: "failed",
            error,
            message,
          });
        } finally {
          await fs.unlink(file.path).catch(() => {});
        }
      }

      const response: AssetUploadResponse = {
        repository,
        branch,
        destinationPath,
        results,
      };

      res.status(overallStatus(results)).json(response);
    },
  );

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    const multerErr = err as { code?: string };
    if (multerErr?.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({
        error: "file_too_large",
        message: `One or more files exceed the maximum allowed size of ${MAX_FILE_SIZE / (1024 * 1024)} MB`,
      });
      return;
    }
    const genericErr = err as { message?: string };
    console.error("assets: unexpected upload error:", genericErr?.message ?? err);
    res.status(500).json({ error: "An unexpected error occurred while processing the upload" });
  });

  return router;
}

async function cleanupFiles(files: Express.Multer.File[] | undefined): Promise<void> {
  if (!files) return;
  await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {})));
}
