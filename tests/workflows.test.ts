import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createApp } from "../src/app.js";
import { WorkflowStore } from "../src/store/workflow-store.js";

const VALID_WORKFLOW = {
  name: "deploy-staging",
  schedule: "0 */6 * * *",
  target: { type: "shell", ref: "/usr/local/bin/deploy.sh" },
};

let tmpDir: string;
let store: WorkflowStore;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-test-"));
  store = new WorkflowStore(path.join(tmpDir, "workflows.json"));
  app = createApp(store);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── helpers ──

async function createWorkflow(body = VALID_WORKFLOW) {
  const res = await request(app).post("/api/workflows").send(body);
  return res;
}

// ── CRUD ──

describe("POST /api/workflows", () => {
  it("creates a workflow and returns 201", async () => {
    const res = await createWorkflow();
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe("deploy-staging");
    expect(res.body.enabled).toBe(true);
    expect(res.body.lastStatus).toBe("idle");
    expect(res.body.createdAt).toBeDefined();
  });

  it("rejects missing name", async () => {
    const res = await request(app)
      .post("/api/workflows")
      .send({ schedule: "* * * * *", target: { type: "shell", ref: "x" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it("rejects missing target", async () => {
    const res = await request(app)
      .post("/api/workflows")
      .send({ name: "x", schedule: "* * * * *" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/target/i);
  });

  it("rejects invalid retryPolicy", async () => {
    const res = await request(app)
      .post("/api/workflows")
      .send({ ...VALID_WORKFLOW, retryPolicy: { maxAttempts: -1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/retryPolicy/i);
  });
});

describe("GET /api/workflows", () => {
  it("returns empty array when no workflows exist", async () => {
    const res = await request(app).get("/api/workflows");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns all workflows", async () => {
    await createWorkflow();
    await createWorkflow({ ...VALID_WORKFLOW, name: "second" });
    const res = await request(app).get("/api/workflows");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

describe("GET /api/workflows/:id", () => {
  it("returns a workflow by id", async () => {
    const created = await createWorkflow();
    const res = await request(app).get(`/api/workflows/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
  });

  it("returns 404 for missing id", async () => {
    const res = await request(app).get("/api/workflows/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/workflows/:id", () => {
  it("updates workflow fields", async () => {
    const created = await createWorkflow();
    const res = await request(app)
      .put(`/api/workflows/${created.body.id}`)
      .send({ name: "renamed", schedule: "0 0 * * *" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("renamed");
    expect(res.body.schedule).toBe("0 0 * * *");
    expect(res.body.target).toEqual(VALID_WORKFLOW.target);
  });

  it("returns 404 for missing id", async () => {
    const res = await request(app)
      .put("/api/workflows/nonexistent")
      .send({ name: "x" });
    expect(res.status).toBe(404);
  });

  it("rejects invalid fields", async () => {
    const created = await createWorkflow();
    const res = await request(app)
      .put(`/api/workflows/${created.body.id}`)
      .send({ timeoutSeconds: -5 });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/workflows/:id", () => {
  it("deletes a workflow and returns 204", async () => {
    const created = await createWorkflow();
    const res = await request(app).delete(`/api/workflows/${created.body.id}`);
    expect(res.status).toBe(204);

    const get = await request(app).get(`/api/workflows/${created.body.id}`);
    expect(get.status).toBe(404);
  });

  it("returns 404 for missing id", async () => {
    const res = await request(app).delete("/api/workflows/nonexistent");
    expect(res.status).toBe(404);
  });
});

// ── State transitions ──

describe("POST /api/workflows/:id/enable", () => {
  it("enables a disabled workflow", async () => {
    const created = await createWorkflow({ ...VALID_WORKFLOW, enabled: false });
    expect(created.body.enabled).toBe(false);

    const res = await request(app).post(
      `/api/workflows/${created.body.id}/enable`
    );
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });
});

describe("POST /api/workflows/:id/disable", () => {
  it("disables an enabled workflow", async () => {
    const created = await createWorkflow();
    const res = await request(app).post(
      `/api/workflows/${created.body.id}/disable`
    );
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });
});

describe("POST /api/workflows/:id/sleep", () => {
  it("sets sleepUntil and status to sleeping", async () => {
    const created = await createWorkflow();
    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    const res = await request(app)
      .post(`/api/workflows/${created.body.id}/sleep`)
      .send({ until: futureDate });
    expect(res.status).toBe(200);
    expect(res.body.sleepUntil).toBeDefined();
    expect(res.body.lastStatus).toBe("sleeping");
  });

  it("rejects a past timestamp", async () => {
    const created = await createWorkflow();
    const res = await request(app)
      .post(`/api/workflows/${created.body.id}/sleep`)
      .send({ until: "2020-01-01T00:00:00Z" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/future/i);
  });

  it("rejects missing until", async () => {
    const created = await createWorkflow();
    const res = await request(app)
      .post(`/api/workflows/${created.body.id}/sleep`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /api/workflows/:id/resume", () => {
  it("clears sleepUntil and resets status from sleeping to idle", async () => {
    const created = await createWorkflow();
    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    await request(app)
      .post(`/api/workflows/${created.body.id}/sleep`)
      .send({ until: futureDate });

    const res = await request(app).post(
      `/api/workflows/${created.body.id}/resume`
    );
    expect(res.status).toBe(200);
    expect(res.body.sleepUntil).toBeNull();
    expect(res.body.lastStatus).toBe("idle");
  });

  it("preserves non-sleeping status on resume", async () => {
    const created = await createWorkflow();
    // run it first so status is 'success'
    await request(app).post(`/api/workflows/${created.body.id}/run`);

    const res = await request(app).post(
      `/api/workflows/${created.body.id}/resume`
    );
    expect(res.status).toBe(200);
    expect(res.body.lastStatus).toBe("success");
  });
});

// ── Run / Execute ──

describe("POST /api/workflows/:id/run", () => {
  it("executes workflow and updates metadata", async () => {
    const created = await createWorkflow();
    const res = await request(app).post(
      `/api/workflows/${created.body.id}/run`
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.startedAt).toBeDefined();
    expect(res.body.completedAt).toBeDefined();

    // Verify persisted state
    const get = await request(app).get(`/api/workflows/${created.body.id}`);
    expect(get.body.lastStatus).toBe("success");
    expect(get.body.lastRunAt).toBeDefined();
  });

  it("rejects run on disabled workflow", async () => {
    const created = await createWorkflow({ ...VALID_WORKFLOW, enabled: false });
    const res = await request(app).post(
      `/api/workflows/${created.body.id}/run`
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/disabled/i);
  });

  it("returns 404 for missing id", async () => {
    const res = await request(app).post("/api/workflows/nonexistent/run");
    expect(res.status).toBe(404);
  });
});

describe("POST /internal/workflows/:id/execute", () => {
  it("executes workflow and returns result", async () => {
    const created = await createWorkflow();
    const res = await request(app).post(
      `/internal/workflows/${created.body.id}/execute`
    );
    expect(res.status).toBe(200);
    expect(res.body.workflowId).toBe(created.body.id);
    expect(res.body.status).toBe("success");
    expect(res.body.startedAt).toBeDefined();
    expect(res.body.completedAt).toBeDefined();
  });

  it("rejects execution when already running", async () => {
    const created = await createWorkflow();
    // First run sets status to success, so manually set to running
    await store.update(created.body.id, { lastStatus: "running" });

    const res = await request(app).post(
      `/internal/workflows/${created.body.id}/execute`
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already running/i);
  });

  it("returns 404 for missing id", async () => {
    const res = await request(app).post(
      "/internal/workflows/nonexistent/execute"
    );
    expect(res.status).toBe(404);
  });
});

// ── Persistence ──

describe("persistence", () => {
  it("survives store reload", async () => {
    await createWorkflow();

    // Create a new store pointing to the same file
    const store2 = new WorkflowStore(path.join(tmpDir, "workflows.json"));
    const app2 = createApp(store2);
    const res = await request(app2).get("/api/workflows");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("deploy-staging");
  });
});
