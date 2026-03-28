export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export const ALLOWED_EXTENSIONS = new Set([
  // images
  ".apng", ".avif", ".bmp", ".gif", ".ico", ".jpeg", ".jpg",
  ".png", ".svg", ".tiff", ".webp",
  // fonts
  ".eot", ".otf", ".ttf", ".woff", ".woff2",
  // documents / data
  ".csv", ".json", ".md", ".pdf", ".txt", ".xml", ".yaml", ".yml",
  // web
  ".css", ".htm", ".html", ".js", ".map", ".ts",
  // audio / video
  ".aac", ".flac", ".m4a", ".mp3", ".mp4", ".ogg", ".wav", ".webm",
  // archives / binaries
  ".gz", ".tar", ".wasm", ".zip",
]);

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9_.\-]+$/;
const BRANCH_RE = /^[A-Za-z0-9_.\-\/]+$/;

export function validateRepository(repo: unknown): { error?: string; value?: string } {
  if (typeof repo !== "string" || !repo.trim()) {
    return { error: "'repository' is required and must be a non-empty string" };
  }
  const trimmed = repo.trim();
  if (!REPO_RE.test(trimmed)) {
    return { error: "'repository' must be in 'owner/repo' format (alphanumeric, hyphens, underscores, dots)" };
  }
  return { value: trimmed };
}

export function validateDestinationPath(p: unknown): { error?: string; value?: string } {
  if (typeof p !== "string" || !p.trim()) {
    return { error: "'destinationPath' is required and must be a non-empty string" };
  }
  const trimmed = p.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("/")) {
    return { error: "'destinationPath' must be a relative path (no leading slash)" };
  }
  const segments = trimmed.split("/");
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      return { error: "'destinationPath' must not contain path traversal sequences" };
    }
    if (!SAFE_PATH_SEGMENT_RE.test(seg)) {
      return { error: `'destinationPath' contains invalid characters in segment '${seg}'` };
    }
  }
  return { value: trimmed };
}

export function validateBranch(branch: unknown): { error?: string; value?: string } {
  if (branch === undefined || branch === null || branch === "") {
    return { value: "main" };
  }
  if (typeof branch !== "string" || !branch.trim()) {
    return { error: "'branch' must be a non-empty string when provided" };
  }
  const trimmed = branch.trim();
  if (!BRANCH_RE.test(trimmed)) {
    return { error: "'branch' contains invalid characters" };
  }
  return { value: trimmed };
}

export function isAllowedExtension(filename: string): boolean {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex === -1) return false;
  const ext = filename.slice(dotIndex).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

export function buildAssetPath(destinationPath: string, filename: string): string {
  return `${destinationPath}/${filename}`;
}

export function validateAssetPath(destinationPath: string, filename: string): { error?: string; value?: string } {
  const fullPath = buildAssetPath(destinationPath, filename);
  const segments = fullPath.split("/");
  for (const seg of segments) {
    if (seg === "." || seg === "..") {
      return { error: `Resulting path '${fullPath}' contains path traversal sequences` };
    }
  }
  return { value: fullPath };
}
