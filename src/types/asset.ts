export type AssetUploadStatus = "created" | "updated" | "skipped" | "rejected" | "failed";

export type AssetErrorCode =
  | "unsupported_file_type"
  | "file_too_large"
  | "invalid_path"
  | "already_exists"
  | "repository_write_failed"
  | "repository_not_found"
  | "authorization_failed";

export interface AssetResult {
  filename: string;
  path: string;
  size?: number;
  status: AssetUploadStatus;
  sha?: string;
  error?: AssetErrorCode;
  message?: string;
}

export interface AssetUploadResponse {
  repository: string;
  branch: string;
  destinationPath: string;
  results: AssetResult[];
}
