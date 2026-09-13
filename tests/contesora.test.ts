import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type express from "express";
import { createApp } from "../src/app.js";
import { contesoraGuide } from "../src/routes/contesora-guide.js";

let app: express.Express;
let calls: Array<{ method: string; path: string; body: unknown }>;
let routes: Record<string, unknown | ((body: unknown) => unknown)>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fake Contesora: answers by "METHOD /path" (query string ignored), records every call. */
function fakeContesora() {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    const key = `${method} ${url.pathname}`;
    if (!(key in routes)) return jsonResponse({ error: `unmocked ${key}` }, 404);
    const answer = routes[key];
    return jsonResponse(typeof answer === "function" ? (answer as (b: unknown) => unknown)(body) : answer);
  });
}

beforeEach(() => {
  process.env.STORYTIME_BASE_URL = "http://contesora.local";
  delete process.env.GATEWAY_API_KEY;
  calls = [];
  routes = {};
  vi.stubGlobal("fetch", fakeContesora());
  ({ app } = createApp());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.STORYTIME_BASE_URL;
  delete process.env.GATEWAY_API_KEY;
  delete process.env.PUBLIC_BASE_URL;
});

type Operation = {
  operationId: string;
  summary: string;
  description?: string;
  parameters?: Array<{ name: string; description?: string }>;
  requestBody?: { content: { "application/json": { schema: Record<string, unknown> } } };
  "x-openai-isConsequential"?: boolean;
};

async function schema() {
  const res = await request(app).get("/openapi/contesora.json");
  expect(res.status).toBe(200);
  const operations: Array<{ method: string; path: string; op: Operation }> = [];
  for (const [path, methods] of Object.entries(res.body.paths as Record<string, Record<string, Operation>>)) {
    for (const [method, op] of Object.entries(methods)) operations.push({ method, path, op });
  }
  return { doc: res.body, operations };
}

/** Every description string anywhere in a JSON schema. */
function descriptions(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => descriptions(n, out));
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "description" && typeof value === "string") out.push(value);
      else descriptions(value, out);
    }
  }
  return out;
}

describe("the Contesora schema a Custom GPT imports", () => {
  it("is served without the action key, at the public server url", async () => {
    process.env.GATEWAY_API_KEY = "secret";
    process.env.PUBLIC_BASE_URL = "https://api.example.com/";
    ({ app } = createApp());
    const { doc } = await schema();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0].url).toBe("https://api.example.com");
    expect(doc.security).toEqual([{ GatewayApiKey: [] }]);
  });

  it("stays inside what a GPT Action can hold", async () => {
    const { operations } = await schema();
    expect(operations.length).toBeGreaterThan(20);
    expect(operations.length, "a GPT Action holds at most 30 operations").toBeLessThanOrEqual(30);
    const ids = operations.map((o) => o.op.operationId);
    expect(new Set(ids).size, "operationIds are unique").toBe(ids.length);
    for (const { op } of operations) {
      expect(op.summary.length, `${op.operationId} summary`).toBeLessThanOrEqual(300);
      if (op.description) expect(op.description.length, `${op.operationId} description`).toBeLessThanOrEqual(300);
      for (const p of op.parameters ?? []) {
        expect((p.description ?? "").length, `${op.operationId}.${p.name}`).toBeLessThanOrEqual(700);
      }
      for (const d of descriptions(op.requestBody)) {
        expect(d.length, `${op.operationId} body description`).toBeLessThanOrEqual(700);
      }
    }
  });

  it("confirms only what cannot be taken back", async () => {
    const { operations } = await schema();
    const flag = (id: string) => operations.find((o) => o.op.operationId === id)?.op["x-openai-isConsequential"];
    expect(flag("deleteWork")).toBe(true);
    expect(flag("resolveProposal")).toBe(true);
    for (const id of ["replaceWorkContent", "updateWork", "createWork", "addWorkPart", "upsertCanon", "askContesora", "restoreWorkVersion"]) {
      expect(flag(id), id).toBe(false);
    }
    // Reads ask nothing of the author.
    for (const { method, op } of operations.filter((o) => o.method === "get")) {
      expect(op["x-openai-isConsequential"], op.operationId).toBeUndefined();
    }
  });

  it("documents only routes that exist", async () => {
    const { operations } = await schema();
    for (const { method, path, op } of operations) {
      const concrete = path.replace("{kind}", "characters").replace(/\{[^}]+\}/g, "x1");
      const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method](concrete).send({});
      // Anything but Express's own "no such route" is a route: the fake
      // Contesora may well refuse the empty body.
      expect(res.status === 404 && res.text.includes("Cannot "), `${op.operationId} ${method.toUpperCase()} ${path}`).toBe(false);
    }
  });

  it("has a guide that names only actions the schema has", async () => {
    const { operations } = await schema();
    const ids = new Set(operations.map((o) => o.op.operationId));
    const named = new Set(contesoraGuide().match(/\b(?:get|list|create|update|upsert|search|save|add|delete|replace|restore|set|ask|resolve)[A-Z][A-Za-z]+\b/g) ?? []);
    expect(named.size).toBeGreaterThan(10);
    for (const name of named) expect(ids.has(name), `the guide names ${name}`).toBe(true);
  });
});

describe("the Contesora actions", () => {
  it("require the gateway key, the guide included", async () => {
    process.env.GATEWAY_API_KEY = "secret";
    ({ app } = createApp());
    expect((await request(app).get("/api/contesora/guide")).status).toBe(401);
    const ok = await request(app).get("/api/contesora/guide").set("Authorization", "Bearer secret");
    expect(ok.status).toBe(200);
    expect(ok.text).toContain("# Using Contesora");
  });

  const depth = (work: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    work: { id: "w1", projectId: "u1", title: "Chapter 1", type: "illustrated_novel", words: 900, content: "Old text.", metadata: {}, ...work },
    parts: [], cast: [], drafts: [], acts: [], arc: null, act: null, parent: null, adaptedFrom: null, adaptations: [],
    ...extra,
  });

  it("saves text exactly, through the edit that keeps the old text as a version", async () => {
    let saved = "Old text.";
    routes["PATCH /api/derivatives/surface/w1"] = (body) => { saved = (body as { content: string }).content; return { ok: true }; };
    routes["GET /api/derivatives/surface/w1"] = () => depth({ content: saved });
    const res = await request(app).put("/api/contesora/works/w1/content").send({ content: "New text.\n\nSecond passage." });
    expect(res.status).toBe(200);
    expect(res.body.exactContentSaved).toBe(true);
    expect(res.body.words).toBe(4);
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body).toMatchObject({ content: "New text.\n\nSecond passage.", draftReason: expect.any(String) });
  });

  it("never changes text through updateWork, and maps the adaptation brief", async () => {
    expect((await request(app).patch("/api/contesora/works/w1").send({ content: "x" })).status).toBe(400);
    routes["PATCH /api/derivatives/surface/w1"] = { ok: true };
    routes["GET /api/derivatives/surface/w1"] = depth();
    const res = await request(app).patch("/api/contesora/works/w1").send({ adaptationBrief: "Tell it from Taruc.", audience: "pg13" });
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ adaptation: "Tell it from Taruc.", audience: "pg13" });
    expect(res.body.work).not.toHaveProperty("content");
    expect((await request(app).patch("/api/contesora/works/w1").send({ audience: "nc17" })).status).toBe(400);
  });

  it("creates an adaptation in a form Contesora knows, with its brief", async () => {
    expect((await request(app).post("/api/contesora/universes/u1/works").send({ title: "X", type: "opera" })).status).toBe(400);
    routes["POST /api/derivatives"] = { id: "w2", partsMade: 5 };
    routes["GET /api/derivatives/surface/w2"] = depth({ id: "w2", type: "graphic_novel" });
    const res = await request(app).post("/api/contesora/universes/u1/works").send({
      title: "The Veil: Graphic novel", type: "graphic_novel", audience: "pg13", adaptedFromId: "w0", adaptationBrief: "Keep it PG-13.",
    });
    expect(res.status).toBe(201);
    expect(res.body.partsMade).toBe(5);
    expect(calls[0].body).toMatchObject({ projectId: "u1", type: "graphic_novel", adaptedFromId: "w0", metadata: { adaptation: "Keep it PG-13." } });
  });

  it("updates a canon record found by exact name, creates one that is missing, and knows its kinds", async () => {
    routes["GET /api/characters"] = [{ id: "c1", projectId: "u1", name: "Taruc" }];
    routes["PUT /api/characters/c1"] = { id: "c1", projectId: "u1", name: "Taruc", role: "Mechanic" };
    const updated = await request(app).post("/api/contesora/universes/u1/canon/characters").send({ name: "taruc", role: "Mechanic" });
    expect(updated.body.action).toBe("updated");
    // Matched by name, it keeps the name it had: the match ignores case, the record does not.
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ role: "Mechanic", source: "contesora-gpt" });
    routes["GET /api/timeline-events"] = [];
    routes["POST /api/timeline-events"] = { id: "e1", projectId: "u1", title: "The Retreat" };
    const created = await request(app).post("/api/contesora/universes/u1/canon/timeline-events").send({ title: "The Retreat" });
    expect(created.status).toBe(201);
    expect(calls.at(-1)!.body).toMatchObject({ projectId: "u1", title: "The Retreat" });
    expect((await request(app).post("/api/contesora/universes/u1/canon/spells").send({ name: "x" })).status).toBe(400);
  });

  it("asks Contesora to revise the text of a part that is already written", async () => {
    routes["GET /api/derivatives/surface/w1"] = depth({ words: 900 });
    routes["POST /api/generated-drafts"] = { id: "d1", status: "generated" };
    const res = await request(app).post("/api/contesora/works/w1/requests").send({ ask: "content", brief: "Tighten it." });
    expect(res.status).toBe(202);
    expect(res.body.proposalId).toBe("d1");
    expect(calls.at(-1)!.body).toMatchObject({
      projectId: "u1", artifactType: "work_canon_request", payload: { workId: "w1", fields: ["content"], brief: "Tighten it.", revise: true },
    });
  });

  it("puts accepted parts in force in order, in the acts they name, then marks the proposal accepted", async () => {
    routes["GET /api/generated-drafts/d2"] = {
      id: "d2", artifactType: "work_parts_request", status: "generated",
      payload: { workId: "w1", proposed: { parts: [{ title: "One", description: "a", act: 2 }, { title: "Two", description: "b" }] } },
    };
    routes["GET /api/derivatives/surface/w1"] = depth({}, { acts: [{ id: "act-1", actNumber: 1 }, { id: "act-2", actNumber: 2 }] });
    let n = 0;
    routes["POST /api/derivatives/surface/w1/parts"] = () => ({ id: `p${++n}` });
    routes["PATCH /api/generated-drafts/d2"] = { ok: true };
    const res = await request(app).post("/api/contesora/proposals/d2/resolve").send({ action: "accept" });
    expect(res.status).toBe(200);
    const parts = calls.filter((c) => c.path.endsWith("/parts")).map((c) => c.body);
    expect(parts).toEqual([
      { title: "One", description: "a", actId: "act-2" },
      { title: "Two", description: "b", actId: null },
    ]);
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", path: "/api/generated-drafts/d2", body: { status: "accepted" } });
  });

  it("sends a kind it cannot apply back to Contesora, and will not resolve a proposal twice", async () => {
    routes["GET /api/generated-drafts/d3"] = { id: "d3", artifactType: "character_canon_request", status: "generated", payload: { proposed: { role: "x" } } };
    const unsupported = await request(app).post("/api/contesora/proposals/d3/resolve").send({ action: "accept" });
    expect(unsupported.status).toBe(422);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
    routes["GET /api/generated-drafts/d4"] = { id: "d4", artifactType: "work_canon_request", status: "accepted", payload: {} };
    expect((await request(app).post("/api/contesora/proposals/d4/resolve").send({ action: "refuse" })).status).toBe(409);
  });

  it("sends a proposal back with the note, carrying what it proposed", async () => {
    routes["GET /api/generated-drafts/d5"] = {
      id: "d5", artifactType: "arc_canon_request", status: "generated", payload: { arcId: "a1", fields: ["acts"], proposed: { acts: [{ title: "Salvage Line" }] } },
    };
    routes["PATCH /api/generated-drafts/d5"] = { ok: true };
    expect((await request(app).post("/api/contesora/proposals/d5/resolve").send({ action: "revise" })).status).toBe(400);
    const res = await request(app).post("/api/contesora/proposals/d5/resolve").send({ action: "revise", note: "Make Lyra capable." });
    expect(res.status).toBe(202);
    expect(calls.at(-1)!.body).toMatchObject({ payload: { arcId: "a1", previous: { acts: [{ title: "Salvage Line" }] }, note: "Make Lyra capable." } });
    expect((calls.at(-1)!.body as { payload: Record<string, unknown> }).payload).not.toHaveProperty("proposed");
  });

  it("bills a cast by name", async () => {
    routes["GET /api/derivatives/surface/w1"] = depth();
    routes["GET /api/characters"] = [{ id: "c1", name: "Taruc" }, { id: "c2", name: "Lyra of the Outer Rim" }];
    routes["PUT /api/derivatives/w1/cast"] = { ok: true };
    const res = await request(app).put("/api/contesora/works/w1/cast").send({ cast: [{ name: "Taruc" }, { name: "lyra of the outer rim" }] });
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ cast: [{ characterId: "c1", billing: 1 }, { characterId: "c2", billing: 2 }] });
    expect((await request(app).put("/api/contesora/works/w1/cast").send({ cast: [{ name: "Nobody" }] })).status).toBe(400);
  });
});
