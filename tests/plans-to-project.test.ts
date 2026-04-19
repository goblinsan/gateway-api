import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type express from "express";

let tmpDir: string;
let app: express.Express;
let binaryPath: string;
let logPath: string;

async function loadApp() {
  vi.resetModules();
  const mod = await import("../src/app.js");
  ({ app } = mod.createApp());
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-plans-test-"));
  binaryPath = path.join(tmpDir, "ghp-test.sh");
  logPath = path.join(tmpDir, "ghp.log");

  const script = [
    "#!/bin/sh",
    "set -eu",
    ': "${GHP_TEST_LOG:=}"',
    'if [ -n "$GHP_TEST_LOG" ]; then',
    '  printf \'%s\\n\' "$*" >> "$GHP_TEST_LOG"',
    'fi',
    'cmd="$1"',
    'shift',
    'case "$cmd" in',
    '  preflight)',
    '    if [ -n "${GHP_TEST_PREFLIGHT_JSON:-}" ]; then',
    '      printf \'%s\\n\' "$GHP_TEST_PREFLIGHT_JSON"',
    '    else',
    '      printf \'%s\\n\' \'{"status":"ready","repository":{"requested":"owner/repo","exactMatch":true}}\'',
    '    fi',
    '    ;;',
    '  apply)',
    '    if [ -n "${GHP_TEST_APPLY_STDOUT:-}" ]; then',
    '      printf \'%s\\n\' "$GHP_TEST_APPLY_STDOUT"',
    '    else',
    '      printf \'%s\\n\' \'{"milestones_created":1,"milestones_updated":0,"epics_created":1,"epics_updated":0,"epics_skipped":0,"issues_created":2,"issues_updated":0,"issues_skipped":0,"epic_urls":["https://github.com/test/repo/issues/1"]}\'',
    '    fi',
    '    ;;',
    '  *)',
    '    echo "unexpected command: $cmd" >&2',
    '    exit 1',
    '    ;;',
    'esac',
    '',
  ].join("\n");

  await fs.writeFile(binaryPath, script, { mode: 0o755 });
  process.env.GHP_BINARY = binaryPath;
  process.env.GHP_TEST_LOG = logPath;
  delete process.env.GHP_TEST_PREFLIGHT_JSON;
  delete process.env.GHP_TEST_APPLY_STDOUT;
  delete process.env.GATEWAY_API_KEY;
  await loadApp();
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.GHP_BINARY;
  delete process.env.GHP_TEST_LOG;
  delete process.env.GHP_TEST_PREFLIGHT_JSON;
  delete process.env.GHP_TEST_APPLY_STDOUT;
  delete process.env.GATEWAY_API_KEY;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("plans-to-project", () => {
  it("rejects requests without an API key when configured", async () => {
    process.env.GATEWAY_API_KEY = "super-secret";
    await loadApp();

    const res = await request(app)
      .post("/plans-to-project/preflight")
      .attach("plan", Buffer.from("project: My Project\nrepository: owner/repo\n"), "plan.yaml");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Missing API key");
  });

  it("rejects workflow requests without an API key when configured", async () => {
    process.env.GATEWAY_API_KEY = "super-secret";
    await loadApp();

    const res = await request(app).get("/api/workflows");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Missing API key");
  });

  it("accepts x-api-key for protected plan endpoints", async () => {
    process.env.GATEWAY_API_KEY = "super-secret";
    await loadApp();

    const res = await request(app)
      .post("/plans-to-project/preflight")
      .set("X-API-Key", "super-secret")
      .attach("plan", Buffer.from("project: My Project\nrepository: owner/repo\n"), "plan.yaml");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");
  });

  it("accepts preflight-from-text payloads", async () => {
    process.env.GHP_TEST_PREFLIGHT_JSON = JSON.stringify({
      status: "ready",
      repository: { requested: "owner/repo", exactMatch: true },
    });

    const res = await request(app)
      .post("/plans-to-project/preflight-from-text")
      .send({ planYaml: "project: My Project\nrepository: owner/repo\n" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ready");

    const log = await fs.readFile(logPath, "utf8");
    expect(log).toContain("preflight -f");
  });

  it("passes boolean createRepoIfMissing through for plan-from-text", async () => {
    process.env.GHP_TEST_PREFLIGHT_JSON = JSON.stringify({
      status: "create_repo_confirmation_required",
      repository: {
        requested: "owner/new-repo",
        exactMatch: false,
        similar: [],
      },
    });
    process.env.GHP_TEST_APPLY_STDOUT = JSON.stringify({
      milestones_created: 1,
      milestones_updated: 0,
      epics_created: 1,
      epics_updated: 0,
      epics_skipped: 0,
      issues_created: 0,
      issues_updated: 0,
      issues_skipped: 0,
      epic_urls: ["https://github.com/test/repo/issues/1"],
    });

    const res = await request(app)
      .post("/plans-to-project/plan-from-text")
      .send({
        planYaml: "project: My Project\nrepository: owner/new-repo\n",
        createRepoIfMissing: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const log = await fs.readFile(logPath, "utf8");
    expect(log).toContain("--create-repo-if-missing");
  });

  it("applies plan-from-text with repository override", async () => {
    process.env.GHP_TEST_PREFLIGHT_JSON = JSON.stringify({
      status: "repo_resolution_required",
      repository: {
        requested: "owner/mispelled-repo",
        exactMatch: false,
        similar: [{ fullName: "owner/similar-repo", description: "similar" }],
      },
    });
    process.env.GHP_TEST_APPLY_STDOUT = JSON.stringify({
      milestones_created: 1,
      milestones_updated: 0,
      epics_created: 1,
      epics_updated: 1,
      epics_skipped: 0,
      issues_created: 2,
      issues_updated: 3,
      issues_skipped: 0,
      epic_urls: ["https://github.com/test/repo/issues/1"],
    });

    const res = await request(app)
      .post("/plans-to-project/plan-from-text")
      .send({
        planYaml: "project: My Project\nrepository: owner/mispelled-repo\n",
        repositoryOverride: "owner/similar-repo",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.report.epics_updated).toBe(1);
    expect(res.body.output).toContain("epics synced");

    const log = await fs.readFile(logPath, "utf8");
    expect(log).toContain("--json");
    expect(log).toContain("--repository-override owner/similar-repo");
  });

  it("returns structured preflight output", async () => {
    process.env.GHP_TEST_PREFLIGHT_JSON = JSON.stringify({
      status: "repo_resolution_required",
      project: { name: "My Project" },
      repository: {
        requested: "owner/mispelled-repo",
        exactMatch: false,
        similar: [{ fullName: "owner/similar-repo", description: "similar" }],
      },
    });

    const res = await request(app)
      .post("/plans-to-project/preflight")
      .attach("plan", Buffer.from("project: My Project\nrepository: owner/mispelled-repo\n"), "plan.yaml");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("repo_resolution_required");
    expect(res.body.repository.similar).toHaveLength(1);
  });

  it("returns 409 from /plan when repo resolution is required", async () => {
    process.env.GHP_TEST_PREFLIGHT_JSON = JSON.stringify({
      status: "repo_resolution_required",
      repository: {
        requested: "owner/mispelled-repo",
        exactMatch: false,
        similar: [{ fullName: "owner/similar-repo", description: "similar" }],
      },
    });

    const res = await request(app)
      .post("/plans-to-project/plan")
      .attach("plan", Buffer.from("project: My Project\nrepository: owner/mispelled-repo\n"), "plan.yaml");

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.stage).toBe("repo_resolution_required");
  });

  it("passes repositoryOverride through to apply after preflight", async () => {
    process.env.GHP_TEST_PREFLIGHT_JSON = JSON.stringify({
      status: "repo_resolution_required",
      repository: {
        requested: "owner/mispelled-repo",
        exactMatch: false,
        similar: [{ fullName: "owner/similar-repo", description: "similar" }],
      },
    });
    process.env.GHP_TEST_APPLY_STDOUT = JSON.stringify({
      milestones_created: 1,
      milestones_updated: 1,
      epics_created: 1,
      epics_updated: 1,
      epics_skipped: 0,
      issues_created: 2,
      issues_updated: 1,
      issues_skipped: 0,
      epic_urls: ["https://github.com/test/repo/issues/1"],
    });

    const res = await request(app)
      .post("/plans-to-project/plan")
      .field("repositoryOverride", "owner/similar-repo")
      .attach("plan", Buffer.from("project: My Project\nrepository: owner/mispelled-repo\n"), "plan.yaml");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.report.milestones_updated).toBe(1);
    expect(res.body.output).toContain("milestones synced");

    const log = await fs.readFile(logPath, "utf8");
    expect(log).toContain("preflight -f");
    expect(log).toContain("apply -f");
    expect(log).toContain("--json");
    expect(log).toContain("--repository-override owner/similar-repo");
  });

  it("returns structured apply report payloads", async () => {
    process.env.GHP_TEST_APPLY_STDOUT = JSON.stringify({
      milestones_created: 0,
      milestones_updated: 1,
      epics_created: 0,
      epics_updated: 1,
      epics_skipped: 0,
      issues_created: 0,
      issues_updated: 2,
      issues_skipped: 0,
      epic_urls: ["https://github.com/test/repo/issues/42"],
    });

    const res = await request(app)
      .post("/plans-to-project/apply")
      .attach("plan", Buffer.from("project: My Project\nrepository: owner/repo\n"), "plan.yaml");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.report.milestones_updated).toBe(1);
    expect(res.body.report.issues_updated).toBe(2);
    expect(res.body.report.epic_urls).toEqual(["https://github.com/test/repo/issues/42"]);
    expect(res.body.output).toContain("0 created, 1 updated");
  });
});
