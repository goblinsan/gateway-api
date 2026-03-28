export interface FileExistsResult {
  exists: boolean;
  sha?: string;
}

export interface WriteFileParams {
  owner: string;
  repo: string;
  path: string;
  content: Buffer;
  message: string;
  branch: string;
  sha?: string;
}

export interface WriteFileResult {
  sha: string;
  created: boolean;
}

export interface AssetWriter {
  fileExists(owner: string, repo: string, path: string, branch: string): Promise<FileExistsResult>;
  writeFile(params: WriteFileParams): Promise<WriteFileResult>;
}

function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

export class GitHubAssetWriter implements AssetWriter {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  async fileExists(owner: string, repo: string, filePath: string, branch: string): Promise<FileExistsResult> {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(branch)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `token ${this.token}`,
        Accept: "application/vnd.github.v3+json",
      },
    });

    if (res.status === 404) {
      return { exists: false };
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({ message: `HTTP ${res.status}` })) as { message?: string };
      const err = new Error(body.message ?? `GitHub API error: ${res.status}`) as Error & { statusCode: number };
      err.statusCode = res.status;
      throw err;
    }

    const data = await res.json() as { sha?: string };
    return { exists: true, sha: data.sha };
  }

  async writeFile(params: WriteFileParams): Promise<WriteFileResult> {
    const url = `https://api.github.com/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/contents/${encodePath(params.path)}`;
    const body: Record<string, unknown> = {
      message: params.message,
      content: params.content.toString("base64"),
      branch: params.branch,
    };
    if (params.sha) {
      body.sha = params.sha;
    }

    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `token ${this.token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ message: `HTTP ${res.status}` })) as { message?: string };
      const err = new Error(errBody.message ?? `GitHub API error: ${res.status}`) as Error & { statusCode: number };
      err.statusCode = res.status;
      throw err;
    }

    const data = await res.json() as { content?: { sha?: string } };
    return {
      sha: data.content?.sha ?? "",
      created: !params.sha,
    };
  }
}
