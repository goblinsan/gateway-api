import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type express from "express";
import { createApp } from "../src/app.js";
import { WorkflowStore } from "../src/store/workflow-store.js";
import { WorkflowScheduler } from "../src/runtime/scheduler.js";

let tmpDir: string;
let store: WorkflowStore;
let app: express.Express;
let channelsPath: string;

const AGENT_TURN_WORKFLOW = {
  name: "daily-briefing",
  schedule: "0 8 * * *",
  target: { type: "gateway-chat-platform.agent-turn", ref: "briefing-agent" },
  input: { prompt: "Give me the morning briefing" },
};

const JOB_WORKFLOW = {
  name: "ops-digest",
  schedule: "0 8 * * *",
  target: { type: "gateway-jobs.run", ref: "reason_script_summarize_deliver" },
  input: {
    reasoning: {
      prompt: "Reason about the current operational state.",
      model: "gpt-test",
    },
    script: {
      command: "printf 'script ok'",
    },
    summary: {
      agentId: "briefing-agent",
      instructions: "Summarize this for delivery in one short paragraph.",
    },
    delivery: {
      channel: "jim-webhook",
    },
  },
};

const LEGACY_WORKFLOW = {
  name: "imap-triage",
  schedule: "*/15 * * * *",
  target: { type: "legacy.openclaw.imap-triage", ref: "inbox" },
};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-runtime-test-"));
  channelsPath = path.join(tmpDir, "job-channels.json");
  await fs.writeFile(
    channelsPath,
    JSON.stringify(
      {
        channels: [
          {
            id: "jim-webhook",
            type: "webhook",
            enabled: true,
            webhookUrl: "https://hooks.example.test/jim",
          },
        ],
      },
      null,
      2
    )
  );
  process.env.GATEWAY_JOB_CHANNELS_PATH = channelsPath;
  process.env.OPENAI_API_KEY = "openai-test-key";
  process.env.OPENAI_DEFAULT_MODEL = "gpt-test";
  store = new WorkflowStore(path.join(tmpDir, "workflows.json"));
  ({ app } = createApp(store));
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.GATEWAY_JOB_CHANNELS_PATH;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_DEFAULT_MODEL;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function createWorkflow(body = AGENT_TURN_WORKFLOW) {
  const res = await request(app).post("/api/workflows").send(body);
  return res;
}

// ── Dispatcher ──

describe("dispatcher", () => {
  it("succeeds for gateway-chat-platform.agent-turn with mocked HTTP", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: { content: "hello" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const created = await createWorkflow();
    const res = await request(app).post(
      `/api/workflows/${created.body.id}/run`
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.startedAt).toBeDefined();
    expect(res.body.completedAt).toBeDefined();
    expect(res.body.error).toBeUndefined();

    // Verify fetch was called with correct payload
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toContain("/api/chat");
    const body = JSON.parse(opts!.body as string);
    expect(body.agentId).toBe("briefing-agent");
    expect(body.messages[0].content).toBe("Give me the morning briefing");

    // Verify persisted state
    const get = await request(app).get(`/api/workflows/${created.body.id}`);
    expect(get.body.lastStatus).toBe("success");
    expect(get.body.lastRunAt).toBeDefined();
    expect(get.body.lastError).toBeNull();
  });

  it("fails for unsupported target types with structured error", async () => {
    const created = await createWorkflow(LEGACY_WORKFLOW);
    const res = await request(app).post(
      `/api/workflows/${created.body.id}/run`
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.error).toBe(
      "Unsupported workflow target: legacy.openclaw.imap-triage"
    );

    // Verify persisted failure state
    const get = await request(app).get(`/api/workflows/${created.body.id}`);
    expect(get.body.lastStatus).toBe("failed");
    expect(get.body.lastError).toMatch(/unsupported/i);
  });

  it("fails clearly for legacy.openclaw.tts-mode", async () => {
    const created = await createWorkflow({
      name: "tts-mode",
      schedule: "0 * * * *",
      target: { type: "legacy.openclaw.tts-mode", ref: "tts" },
    });
    const res = await request(app).post(
      `/api/workflows/${created.body.id}/run`
    );

    expect(res.body.status).toBe("failed");
    expect(res.body.error).toBe(
      "Unsupported workflow target: legacy.openclaw.tts-mode"
    );
  });

  it("handles downstream HTTP failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Internal Server Error", { status: 500 })
    );

    const created = await createWorkflow();
    const res = await request(app).post(
      `/api/workflows/${created.body.id}/run`
    );

    expect(res.body.status).toBe("failed");
    expect(res.body.error).toMatch(/500/);

    const get = await request(app).get(`/api/workflows/${created.body.id}`);
    expect(get.body.lastStatus).toBe("failed");
    expect(get.body.lastError).toMatch(/500/);
  });

  it("handles network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("fetch failed")
    );

    const created = await createWorkflow();
    const res = await request(app).post(
      `/api/workflows/${created.body.id}/run`
    );

    expect(res.body.status).toBe("failed");
    expect(res.body.error).toMatch(/fetch failed/);
  });

  it("requires prompt in input for agent-turn", async () => {
    const created = await createWorkflow({
      ...AGENT_TURN_WORKFLOW,
      input: {},
    });
    const res = await request(app).post(
      `/api/workflows/${created.body.id}/run`
    );

    expect(res.body.status).toBe("failed");
    expect(res.body.error).toMatch(/prompt/i);
  });

  it("lists available catalog jobs", async () => {
    const res = await request(app).get("/api/jobs");

    expect(res.status).toBe(200);
    expect(res.body.jobs.some((job: { id: string }) => job.id === "reason_script_summarize_deliver")).toBe(true);
  });

  it("runs gateway-jobs.run through the catalog runtime", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const target = String(url);
      if (target.includes("/v1/chat/completions")) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "reasoned output" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (target.includes("/api/agents/briefing-agent/run")) {
        return new Response(
          JSON.stringify({
            agentId: "briefing-agent",
            usedProvider: "lm-studio-a",
            model: "qwen-local",
            content: "final summary",
            latencyMs: 10,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (target === "https://hooks.example.test/jim") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch URL: ${target}`);
    });

    const created = await createWorkflow(JOB_WORKFLOW);
    const res = await request(app).post(`/api/workflows/${created.body.id}/run`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.output.reasoning.content).toBe("reasoned output");
    expect(res.body.output.script.stdout).toContain("script ok");
    expect(res.body.output.summary.content).toBe("final summary");
    expect(res.body.output.delivery.channelId).toBe("jim-webhook");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

// ── Internal execute ──

describe("POST /internal/workflows/:id/execute (dispatcher)", () => {
  it("dispatches through internal route", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const created = await createWorkflow();
    const res = await request(app).post(
      `/internal/workflows/${created.body.id}/execute`
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.workflowId).toBe(created.body.id);
  });
});

// ── Scheduler ──

describe("WorkflowScheduler", () => {
  it("triggers a due workflow", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    // Create a workflow with a schedule that fires every minute
    const created = await createWorkflow({
      ...AGENT_TURN_WORKFLOW,
      schedule: "* * * * *",
    });
    expect(created.body.lastStatus).toBe("idle");

    const scheduler = new WorkflowScheduler(store, 60_000);
    await scheduler.tick();

    // Should have been triggered
    expect(fetchSpy).toHaveBeenCalledOnce();

    const wf = await store.get(created.body.id);
    expect(wf!.lastStatus).toBe("success");
    expect(wf!.lastRunAt).toBeDefined();
  });

  it("does not run disabled workflows", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    await createWorkflow({
      ...AGENT_TURN_WORKFLOW,
      schedule: "* * * * *",
      enabled: false,
    });

    const scheduler = new WorkflowScheduler(store, 60_000);
    await scheduler.tick();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not run sleeping workflows", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const created = await createWorkflow({
      ...AGENT_TURN_WORKFLOW,
      schedule: "* * * * *",
    });

    // Put to sleep far in the future
    const futureDate = new Date(Date.now() + 86400_000).toISOString();
    await request(app)
      .post(`/api/workflows/${created.body.id}/sleep`)
      .send({ until: futureDate });

    const scheduler = new WorkflowScheduler(store, 60_000);
    await scheduler.tick();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not double-run a workflow within the same due window", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    await createWorkflow({
      ...AGENT_TURN_WORKFLOW,
      schedule: "* * * * *",
    });

    const scheduler = new WorkflowScheduler(store, 60_000);
    await scheduler.tick();
    await scheduler.tick();

    // Only triggered once despite two ticks
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("skips workflows that are already running", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const created = await createWorkflow({
      ...AGENT_TURN_WORKFLOW,
      schedule: "* * * * *",
    });
    await store.update(created.body.id, { lastStatus: "running" });

    const scheduler = new WorkflowScheduler(store, 60_000);
    await scheduler.tick();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
