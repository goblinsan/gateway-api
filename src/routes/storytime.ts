import { Router, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { StorytimeClient, StorytimeConfigError, StorytimeUpstreamError } from "../clients/storytime-client.js";

type JsonObject = Record<string, unknown>;

interface ListQuery {
  type?: unknown;
  q?: unknown;
  limit?: unknown;
}

interface ProjectParams {
  projectId: string;
}

interface EntityParams {
  projectId: string;
  id: string;
}

interface DraftParams {
  draftId: string;
}

interface DerivativeParams {
  derivativeId: string;
}

const MAX_SEARCH_RESULTS = 50;
const DEFAULT_SEARCH_RESULTS = 12;

export function createStorytimeRouter(client = new StorytimeClient()): Router {
  const router = Router();

  router.get("/projects", async (req: Request<unknown, unknown, unknown, ListQuery>, res) => {
    try {
      const projects = await client.get<unknown[]>("/api/projects", {
        query: { type: stringValue(req.query.type) },
      });
      const q = stringValue(req.query.q)?.toLowerCase();
      const limit = parsePositiveInt(req.query.limit, 25, 100);
      const filtered = q
        ? projects.filter((project) => objectMatches(project, q))
        : projects;
      res.json(filtered.slice(0, limit).map(summarizeProject));
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.post("/projects", async (req: Request<unknown, unknown, JsonObject>, res) => {
    try {
      const created = await client.post<JsonObject>("/api/projects", withSource(req.body));
      res.status(201).json(summarizeProject(created));
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.get("/projects/:projectId", async (req: Request<ProjectParams>, res) => {
    try {
      const project = await client.get<JsonObject>(`/api/projects/${encodeURIComponent(req.params.projectId)}`);
      res.json(summarizeProject(project));
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.patch("/projects/:projectId", async (req: Request<ProjectParams, unknown, JsonObject>, res) => {
    try {
      const updated = await client.patch<JsonObject>(
        `/api/projects/${encodeURIComponent(req.params.projectId)}`,
        withSource(req.body),
      );
      res.json(summarizeProject(updated));
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.get("/projects/:projectId/encyclopedia", async (req: Request<ProjectParams>, res) => {
    try {
      const encyclopedia = await client.get<JsonObject>(`/api/projects/${encodeURIComponent(req.params.projectId)}/encyclopedia`);
      res.json(summarizeEncyclopedia(encyclopedia));
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.get("/projects/:projectId/canon/search", async (req: Request<ProjectParams, unknown, unknown, { q?: unknown; types?: unknown; limit?: unknown }>, res) => {
    try {
      const q = stringValue(req.query.q);
      if (!q) {
        res.status(400).json({ error: "q query parameter is required" });
        return;
      }

      const limit = parsePositiveInt(req.query.limit, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
      const requestedTypes = parseTypes(req.query.types);
      const encyclopedia = await client.get<JsonObject>(`/api/projects/${encodeURIComponent(req.params.projectId)}/encyclopedia`);
      res.json({
        project: getObject(encyclopedia.project),
        q,
        results: searchCatalog(encyclopedia, q, requestedTypes, limit),
      });
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.get("/projects/:projectId/characters", async (req: Request<ProjectParams, unknown, unknown, { importance?: unknown; characterType?: unknown; timeframeYear?: unknown }>, res) => {
    try {
      const characters = await client.get<unknown[]>("/api/characters", {
        query: {
          projectId: req.params.projectId,
          importance: stringValue(req.query.importance),
          characterType: stringValue(req.query.characterType),
          timeframeYear: stringValue(req.query.timeframeYear),
        },
      });
      res.json(characters.map(summarizeCharacter));
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.post("/projects/:projectId/characters/upsert", async (req: Request<ProjectParams, unknown, JsonObject>, res) => {
    try {
      const body: JsonObject = { ...req.body, projectId: req.params.projectId };
      const id = stringValue(body.characterId) ?? stringValue(body.id);
      if (id) {
        const updated = await client.patch<JsonObject>(`/api/characters/${encodeURIComponent(id)}`, withSource(stripIds(body)));
        res.json(summarizeCharacter(updated));
        return;
      }

      const existing = await findByName(client, "/api/characters", req.params.projectId, stringValue(body.name));
      if (existing?.id) {
        const updated = await client.patch<JsonObject>(
          `/api/characters/${encodeURIComponent(String(existing.id))}`,
          withSource(stripIds(body)),
        );
        res.json(summarizeCharacter(updated));
        return;
      }

      const created = await client.post<JsonObject>("/api/characters", withSource(body));
      res.status(201).json(summarizeCharacter(created));
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.get("/projects/:projectId/bestiary", async (req: Request<ProjectParams>, res) => {
    try {
      const entries = await client.get<unknown[]>("/api/bestiary", {
        query: { projectId: req.params.projectId },
      });
      res.json(entries.map(summarizeBestiaryEntry));
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.post("/projects/:projectId/bestiary/upsert", async (req: Request<ProjectParams, unknown, JsonObject>, res) => {
    try {
      const body: JsonObject = { ...req.body, projectId: req.params.projectId };
      const id = stringValue(body.bestiaryId) ?? stringValue(body.id);
      if (id) {
        const updated = await client.put<JsonObject>(`/api/bestiary/${encodeURIComponent(id)}`, withSource(stripIds(body)));
        res.json(summarizeBestiaryEntry(updated));
        return;
      }

      const existing = await findByName(client, "/api/bestiary", req.params.projectId, stringValue(body.name));
      if (existing?.id) {
        const updated = await client.put<JsonObject>(
          `/api/bestiary/${encodeURIComponent(String(existing.id))}`,
          withSource(stripIds(body)),
        );
        res.json(summarizeBestiaryEntry(updated));
        return;
      }

      const created = await client.post<JsonObject>("/api/bestiary", withSource(body));
      res.status(201).json(summarizeBestiaryEntry(created));
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.get("/projects/:projectId/derivatives", async (req: Request<ProjectParams, unknown, unknown, { type?: unknown }>, res) => {
    try {
      const derivatives = await client.get<unknown[]>("/api/derivatives", {
        query: { projectId: req.params.projectId, type: stringValue(req.query.type) },
      });
      res.json(derivatives.map(summarizeDerivative));
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.post("/projects/:projectId/derivatives", async (req: Request<ProjectParams, unknown, JsonObject>, res) => {
    try {
      const created = await client.post<JsonObject>("/api/derivatives", withSource({
        ...req.body,
        projectId: req.params.projectId,
      }));
      res.status(201).json(summarizeDerivative(created));
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.patch("/derivatives/:derivativeId", async (req: Request<DerivativeParams, unknown, JsonObject>, res) => {
    try {
      const updated = await client.put<JsonObject>(
        `/api/derivatives/${encodeURIComponent(req.params.derivativeId)}`,
        withSource(req.body),
      );
      res.json(summarizeDerivative(updated));
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.put("/derivatives/:derivativeId/content", async (req: Request<DerivativeParams, unknown, JsonObject>, res) => {
    try {
      const content = req.body.content;
      if (typeof content !== "string") {
        res.status(400).json({ error: "content is required and must be a string" });
        return;
      }

      const existing = await client.get<JsonObject>(`/api/derivatives/${encodeURIComponent(req.params.derivativeId)}`);
      const existingMetadata = getObject(existing.metadata);
      const requestedMetadata = getObject(req.body.metadata);
      const wordCount = countWords(content);
      const metadata = {
        ...existingMetadata,
        ...requestedMetadata,
        wordCount,
        exactContentReplacement: true,
        exactContentReplacementAt: new Date().toISOString(),
      };

      const updatePayload: JsonObject = {
        content,
        metadata,
      };

      const status = stringValue(req.body.status);
      if (status) {
        updatePayload.status = status;
      }

      if (Array.isArray(req.body.sourceCanonReferences)) {
        updatePayload.sourceCanonReferences = req.body.sourceCanonReferences;
      }

      const updated = await client.put<JsonObject>(
        `/api/derivatives/${encodeURIComponent(req.params.derivativeId)}`,
        withSource(updatePayload),
      );
      const savedContent = typeof updated.content === "string" ? updated.content : "";

      res.json({
        derivativeId: req.params.derivativeId,
        exactContentSaved: savedContent === content,
        contentLength: content.length,
        savedContentLength: savedContent.length,
        contentSha256: sha256(content),
        savedContentSha256: sha256(savedContent),
        wordCount,
        derivative: summarizeDerivative(updated),
      });
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.post("/derivatives/:derivativeId/compose", async (req: Request<DerivativeParams, unknown, JsonObject>, res) => {
    try {
      const result = await client.post<JsonObject>("/api/composer/chapter", withSource({
        ...req.body,
        derivativeId: req.params.derivativeId,
      }));
      res.json(result);
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.post("/projects/:projectId/compose", async (req: Request<ProjectParams, unknown, JsonObject>, res) => {
    try {
      const result = await client.post<JsonObject>("/api/composer/all", withSource({
        ...req.body,
        projectId: req.params.projectId,
      }));
      res.json(result);
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.get("/derivatives/:derivativeId/review-dossier", async (req: Request<DerivativeParams, unknown, unknown, { format?: unknown }>, res) => {
    try {
      const format = stringValue(req.query.format);
      if (format === "raw") {
        const dossier = await client.getText(
          `/api/derivatives/${encodeURIComponent(req.params.derivativeId)}/review-dossier`,
          { query: { format } },
        );
        res.set("content-type", dossier.contentType ?? "text/markdown; charset=utf-8").send(dossier.text);
        return;
      }

      const dossier = await client.get<JsonObject>(
        `/api/derivatives/${encodeURIComponent(req.params.derivativeId)}/review-dossier`,
      );
      res.json(dossier);
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.get("/projects/:projectId/drafts", async (req: Request<ProjectParams, unknown, unknown, { status?: unknown }>, res) => {
    try {
      const drafts = await client.get<unknown[]>("/api/generated-drafts", {
        query: { projectId: req.params.projectId, status: stringValue(req.query.status) },
      });
      res.json(drafts.map(summarizeDraft));
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.get("/drafts/:draftId", async (req: Request<DraftParams>, res) => {
    try {
      const draft = await client.get<JsonObject>(`/api/generated-drafts/${encodeURIComponent(req.params.draftId)}`);
      res.json(draft);
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.post("/drafts/:draftId/status", async (req: Request<DraftParams, unknown, { status?: unknown }>, res) => {
    try {
      const status = stringValue(req.body.status);
      if (!status) {
        res.status(400).json({ error: "status is required" });
        return;
      }
      const draft = await client.patch<JsonObject>(`/api/generated-drafts/${encodeURIComponent(req.params.draftId)}`, { status });
      res.json(summarizeDraft(draft));
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.post("/drafts/:draftId/promote", async (req: Request<DraftParams, unknown, JsonObject>, res) => {
    try {
      const result = await client.post<JsonObject>(
        `/api/generated-drafts/${encodeURIComponent(req.params.draftId)}/promote`,
        withSource(req.body),
      );
      res.json(result);
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.post("/projects/:projectId/exploration/preview", async (req: Request<ProjectParams, unknown, JsonObject>, res) => {
    try {
      const result = await client.post<JsonObject>("/api/composer/cycle/preview", withSource({
        ...req.body,
        projectId: req.params.projectId,
      }));
      res.json(result);
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  router.post("/projects/:projectId/exploration/run", async (req: Request<ProjectParams, unknown, JsonObject>, res) => {
    try {
      const result = await client.post<JsonObject>("/api/composer/cycle/run", withSource({
        ...req.body,
        projectId: req.params.projectId,
        execute: true,
      }));
      res.json(result);
    } catch (err) {
      sendStorytimeError(res, err);
    }
  });

  return router;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function getObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function countWords(value: string): number {
  const words = value.trim().match(/\S+/g);
  return words ? words.length : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function withSource<T>(body: T): T & { source: string } {
  return { ...(getObject(body)), source: "chatgpt-mobile-gpt" } as T & { source: string };
}

function stripIds(body: JsonObject): JsonObject {
  const { id: _id, characterId: _characterId, bestiaryId: _bestiaryId, ...rest } = body;
  return rest;
}

async function findByName(client: StorytimeClient, path: string, projectId: string, name: string | undefined): Promise<JsonObject | undefined> {
  if (!name) {
    return undefined;
  }
  const rows = await client.get<unknown[]>(path, { query: { projectId } });
  return rows
    .map(getObject)
    .find((row) => typeof row.name === "string" && row.name.trim().toLowerCase() === name.trim().toLowerCase());
}

function objectMatches(value: unknown, query: string): boolean {
  return JSON.stringify(value).toLowerCase().includes(query);
}

function parseTypes(value: unknown): Set<string> | undefined {
  const text = stringValue(value);
  if (!text) {
    return undefined;
  }
  return new Set(text.split(",").map((part) => part.trim()).filter(Boolean));
}

function searchCatalog(encyclopedia: JsonObject, q: string, requestedTypes: Set<string> | undefined, limit: number): JsonObject[] {
  const catalog = getObject(encyclopedia.catalog);
  const needle = q.toLowerCase();
  const results: JsonObject[] = [];

  for (const [type, entries] of Object.entries(catalog)) {
    if (requestedTypes && !requestedTypes.has(type)) {
      continue;
    }
    if (!Array.isArray(entries)) {
      continue;
    }

    for (const entry of entries) {
      if (!objectMatches(entry, needle)) {
        continue;
      }
      const item = getObject(entry);
      results.push({
        type,
        id: item.id,
        name: item.name ?? item.title ?? item.designation ?? item.id,
        summary: item.description ?? item.summary ?? item.role ?? item.category ?? "",
        updatedAt: item.updatedAt,
        item,
      });
      if (results.length >= limit) {
        return results;
      }
    }
  }

  return results;
}

function summarizeProject(value: unknown): JsonObject {
  const project = getObject(value);
  return {
    id: project.id,
    title: project.title,
    author: project.author,
    description: project.description,
    type: project.type,
    promotionPolicy: project.promotionPolicy,
    isProtected: project.isProtected,
    isPublished: project.isPublished,
    counts: project.counts,
    updatedAt: project.updatedAt,
    createdAt: project.createdAt,
    characters: Array.isArray(project.characters) ? project.characters.slice(0, 10).map(summarizeCharacter) : undefined,
  };
}

function summarizeEncyclopedia(value: unknown): JsonObject {
  const encyclopedia = getObject(value);
  return {
    project: encyclopedia.project,
    counts: encyclopedia.counts,
    recentUpdates: encyclopedia.recentUpdates,
  };
}

function summarizeCharacter(value: unknown): JsonObject {
  const character = getObject(value);
  return {
    id: character.id,
    projectId: character.projectId,
    name: character.name,
    description: character.description,
    background: character.background,
    traits: character.traits,
    relationships: character.relationships,
    characterType: character.characterType,
    role: character.role,
    motivation: character.motivation,
    importance: character.importance,
    activeTimeframeStart: character.activeTimeframeStart,
    activeTimeframeEnd: character.activeTimeframeEnd,
    isProtected: character.isProtected,
    updatedAt: character.updatedAt,
  };
}

function summarizeBestiaryEntry(value: unknown): JsonObject {
  const entry = getObject(value);
  return {
    id: entry.id,
    projectId: entry.projectId,
    name: entry.name,
    category: entry.category,
    hearts: entry.hearts,
    tactics: entry.tactics,
    status: entry.status,
    description: entry.description,
    notes: entry.notes,
    inUniverseBackstory: entry.inUniverseBackstory,
    motivation: entry.motivation,
    ecologicalNiche: entry.ecologicalNiche,
    demographicAdaptations: entry.demographicAdaptations,
    isProtected: entry.isProtected,
  };
}

function summarizeDerivative(value: unknown): JsonObject {
  const derivative = getObject(value);
  return {
    id: derivative.id,
    projectId: derivative.projectId,
    type: derivative.type,
    title: derivative.title,
    description: derivative.description,
    status: derivative.status,
    sourceCanonReferences: derivative.sourceCanonReferences,
    metadata: derivative.metadata,
    content: trimText(derivative.content, 6000),
    createdAt: derivative.createdAt,
    updatedAt: derivative.updatedAt,
  };
}

function summarizeDraft(value: unknown): JsonObject {
  const draft = getObject(value);
  return {
    id: draft.id,
    projectId: draft.projectId,
    artifactType: draft.artifactType,
    status: draft.status,
    dashboardProjectId: draft.dashboardProjectId,
    dashboardTaskId: draft.dashboardTaskId,
    modelProvider: draft.modelProvider,
    modelName: draft.modelName,
    gateResult: draft.gateResult,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

function trimText(value: unknown, maxChars: number): unknown {
  if (typeof value !== "string" || value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function sendStorytimeError(res: Response, err: unknown): void {
  if (err instanceof StorytimeConfigError) {
    res.status(503).json({ error: err.message });
    return;
  }
  if (err instanceof StorytimeUpstreamError) {
    const status = err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 502;
    res.status(status).json({
      error: err.message,
      upstreamStatus: err.statusCode,
      details: err.details,
    });
    return;
  }

  res.status(500).json({ error: err instanceof Error ? err.message : "StoryTime gateway request failed" });
}
