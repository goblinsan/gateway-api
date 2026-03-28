import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type express from "express";
import { createApp } from "../src/app.js";
import type { AssetWriter } from "../src/github/asset-writer.js";
import type { FileExistsResult, WriteFileResult, WriteFileParams } from "../src/github/asset-writer.js";

// ── Helpers ──

function makeWriter(overrides: Partial<AssetWriter> = {}): AssetWriter {
  return {
    fileExists: vi.fn<[string, string, string, string], Promise<FileExistsResult>>(
      async () => ({ exists: false }),
    ),
    writeFile: vi.fn<[WriteFileParams], Promise<WriteFileResult>>(
      async () => ({ sha: "abc123", created: true }),
    ),
    ...overrides,
  };
}

const VALID_FIELDS = {
  repository: "owner/repo",
  destinationPath: "assets/images",
};

const PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

let app: express.Express;
let writer: AssetWriter;

beforeEach(() => {
  writer = makeWriter();
  ({ app } = createApp(undefined, writer));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.GATEWAY_API_KEY;
});

// ── Authentication ──

describe("POST /api/assets — authentication", () => {
  it("returns 401 when API key is configured but not provided", async () => {
    process.env.GATEWAY_API_KEY = "secret";
    ({ app } = createApp(undefined, writer));

    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets")
      .attach("assets", PNG_BUFFER, "logo.png");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Missing API key");
  });

  it("returns 403 when wrong API key is provided", async () => {
    process.env.GATEWAY_API_KEY = "secret";
    ({ app } = createApp(undefined, writer));

    const res = await request(app)
      .post("/api/assets")
      .set("x-api-key", "wrong")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets")
      .attach("assets", PNG_BUFFER, "logo.png");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Invalid API key");
  });

  it("accepts a valid x-api-key header", async () => {
    process.env.GATEWAY_API_KEY = "secret";
    ({ app } = createApp(undefined, writer));

    const res = await request(app)
      .post("/api/assets")
      .set("x-api-key", "secret")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets")
      .attach("assets", PNG_BUFFER, "logo.png");

    expect(res.status).toBe(200);
  });

  it("accepts a Bearer token", async () => {
    process.env.GATEWAY_API_KEY = "secret";
    ({ app } = createApp(undefined, writer));

    const res = await request(app)
      .post("/api/assets")
      .set("Authorization", "Bearer secret")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets")
      .attach("assets", PNG_BUFFER, "logo.png");

    expect(res.status).toBe(200);
  });
});

// ── Request validation ──

describe("POST /api/assets — request validation", () => {
  it("returns 400 when repository is missing", async () => {
    const res = await request(app)
      .post("/api/assets")
      .field("destinationPath", "assets")
      .attach("assets", PNG_BUFFER, "logo.png");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/repository/i);
  });

  it("returns 400 when repository format is invalid", async () => {
    const res = await request(app)
      .post("/api/assets")
      .field("repository", "just-a-repo-name")
      .field("destinationPath", "assets")
      .attach("assets", PNG_BUFFER, "logo.png");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/owner\/repo/i);
  });

  it("returns 400 when destinationPath is missing", async () => {
    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .attach("assets", PNG_BUFFER, "logo.png");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/destinationPath/i);
  });

  it("returns 400 when destinationPath is absolute", async () => {
    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "/absolute/path")
      .attach("assets", PNG_BUFFER, "logo.png");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/relative/i);
  });

  it("returns 400 when destinationPath contains traversal sequences", async () => {
    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets/../etc")
      .attach("assets", PNG_BUFFER, "logo.png");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/traversal/i);
  });

  it("returns 400 when no files are provided", async () => {
    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/asset/i);
  });

  it("returns 400 when branch format is invalid", async () => {
    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets")
      .field("branch", "branch with spaces!")
      .attach("assets", PNG_BUFFER, "logo.png");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/branch/i);
  });
});

// ── Successful upload ──

describe("POST /api/assets — successful upload", () => {
  it("returns 200 with a result entry for each uploaded file", async () => {
    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets/images")
      .attach("assets", PNG_BUFFER, "logo.png");

    expect(res.status).toBe(200);
    expect(res.body.repository).toBe("owner/repo");
    expect(res.body.branch).toBe("main");
    expect(res.body.destinationPath).toBe("assets/images");
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].filename).toBe("logo.png");
    expect(res.body.results[0].path).toBe("assets/images/logo.png");
    expect(res.body.results[0].status).toBe("created");
    expect(res.body.results[0].sha).toBe("abc123");
    expect(res.body.results[0].size).toBeDefined();
  });

  it("uses the specified branch", async () => {
    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets")
      .field("branch", "develop")
      .attach("assets", PNG_BUFFER, "icon.png");

    expect(res.status).toBe(200);
    expect(res.body.branch).toBe("develop");
    expect(writer.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "develop" }),
    );
  });

  it("passes a custom commitMessage to the writer", async () => {
    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets")
      .field("commitMessage", "chore: add design assets")
      .attach("assets", PNG_BUFFER, "icon.png");

    expect(res.status).toBe(200);
    expect(writer.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ message: "chore: add design assets" }),
    );
  });

  it("uploads multiple files and returns a result for each", async () => {
    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets")
      .attach("assets", PNG_BUFFER, "a.png")
      .attach("assets", PNG_BUFFER, "b.png");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results.map((r: { filename: string }) => r.filename).sort()).toEqual(["a.png", "b.png"]);
  });

  it("returns 'updated' status when file exists and overwrite is true", async () => {
    writer = makeWriter({
      fileExists: vi.fn(async () => ({ exists: true, sha: "existing-sha" })),
      writeFile: vi.fn(async () => ({ sha: "new-sha", created: false })),
    });
    ({ app } = createApp(undefined, writer));

    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets")
      .field("overwrite", "true")
      .attach("assets", PNG_BUFFER, "logo.png");

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe("updated");
    expect(res.body.results[0].sha).toBe("new-sha");
    expect(writer.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ sha: "existing-sha" }),
    );
  });
});

// ── Idempotency (overwrite behaviour) ──

describe("POST /api/assets — idempotency", () => {
  it("returns 207 with skipped status when file exists and overwrite is false (default)", async () => {
    writer = makeWriter({
      fileExists: vi.fn(async () => ({ exists: true, sha: "existing-sha" })),
    });
    ({ app } = createApp(undefined, writer));

    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets")
      .attach("assets", PNG_BUFFER, "logo.png");

    expect(res.status).toBe(207);
    expect(res.body.results[0].status).toBe("skipped");
    expect(res.body.results[0].error).toBe("already_exists");
    expect(res.body.results[0].sha).toBe("existing-sha");
    expect(writer.writeFile).not.toHaveBeenCalled();
  });

  it("does not skip when overwrite=true even if file exists", async () => {
    writer = makeWriter({
      fileExists: vi.fn(async () => ({ exists: true, sha: "existing-sha" })),
      writeFile: vi.fn(async () => ({ sha: "new-sha", created: false })),
    });
    ({ app } = createApp(undefined, writer));

    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets")
      .field("overwrite", "true")
      .attach("assets", PNG_BUFFER, "logo.png");

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe("updated");
    expect(writer.writeFile).toHaveBeenCalledOnce();
  });
});

// ── Per-file validation ──

describe("POST /api/assets — per-file validation", () => {
  it("rejects files with unsupported extensions and returns 422 when all files are rejected", async () => {
    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets")
      .attach("assets", Buffer.from("x"), "script.exe");

    expect(res.status).toBe(422);
    expect(res.body.results[0].status).toBe("rejected");
    expect(res.body.results[0].error).toBe("unsupported_file_type");
    expect(res.body.results[0].message).toMatch(/\.exe/);
  });

  it("returns 207 when some files are rejected and some succeed", async () => {
    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets")
      .attach("assets", PNG_BUFFER, "logo.png")
      .attach("assets", Buffer.from("x"), "virus.exe");

    expect(res.status).toBe(207);
    const statuses = res.body.results.map((r: { status: string }) => r.status).sort();
    expect(statuses).toEqual(["created", "rejected"]);
  });

  it("does not call the writer for rejected files", async () => {
    await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets")
      .attach("assets", Buffer.from("x"), "malware.dll");

    expect(writer.writeFile).not.toHaveBeenCalled();
  });
});

// ── GitHub API error semantics ──

describe("POST /api/assets — GitHub API error semantics", () => {
  it("maps a 404 from the writer to repository_not_found", async () => {
    const err = Object.assign(new Error("Not Found"), { statusCode: 404 });
    writer = makeWriter({ fileExists: vi.fn(async () => { throw err; }) });
    ({ app } = createApp(undefined, writer));

    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets")
      .attach("assets", PNG_BUFFER, "logo.png");

    expect(res.status).toBe(207);
    expect(res.body.results[0].status).toBe("failed");
    expect(res.body.results[0].error).toBe("repository_not_found");
  });

  it("maps a 401 from the writer to authorization_failed", async () => {
    const err = Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    writer = makeWriter({ fileExists: vi.fn(async () => { throw err; }) });
    ({ app } = createApp(undefined, writer));

    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets")
      .attach("assets", PNG_BUFFER, "logo.png");

    expect(res.status).toBe(207);
    expect(res.body.results[0].status).toBe("failed");
    expect(res.body.results[0].error).toBe("authorization_failed");
  });

  it("maps a 403 from the writer to authorization_failed", async () => {
    const err = Object.assign(new Error("Forbidden"), { statusCode: 403 });
    writer = makeWriter({ fileExists: vi.fn(async () => { throw err; }) });
    ({ app } = createApp(undefined, writer));

    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets")
      .attach("assets", PNG_BUFFER, "logo.png");

    expect(res.status).toBe(207);
    expect(res.body.results[0].status).toBe("failed");
    expect(res.body.results[0].error).toBe("authorization_failed");
  });

  it("maps other writer errors to repository_write_failed", async () => {
    const err = Object.assign(new Error("Server Error"), { statusCode: 500 });
    writer = makeWriter({ fileExists: vi.fn(async () => { throw err; }) });
    ({ app } = createApp(undefined, writer));

    const res = await request(app)
      .post("/api/assets")
      .field("repository", "owner/repo")
      .field("destinationPath", "assets")
      .attach("assets", PNG_BUFFER, "logo.png");

    expect(res.status).toBe(207);
    expect(res.body.results[0].status).toBe("failed");
    expect(res.body.results[0].error).toBe("repository_write_failed");
  });
});
