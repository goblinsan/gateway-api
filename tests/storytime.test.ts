import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type express from "express";
import { createApp } from "../src/app.js";

let app: express.Express;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  process.env.STORYTIME_BASE_URL = "http://storytime.local";
  delete process.env.GATEWAY_API_KEY;
  fetchMock = vi.fn(async () => jsonResponse({}));
  vi.stubGlobal("fetch", fetchMock);
  ({ app } = createApp());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.STORYTIME_BASE_URL;
  delete process.env.STORYTIME_TIMEOUT_MS;
  delete process.env.GATEWAY_API_KEY;
  delete process.env.PUBLIC_BASE_URL;
});

describe("StoryTime gateway actions", () => {
  it("requires the same gateway API key pattern as the project helper endpoints", async () => {
    process.env.GATEWAY_API_KEY = "secret";
    ({ app } = createApp());

    const missing = await request(app).get("/api/storytime/projects");
    expect(missing.status).toBe(401);
    expect(missing.body.error).toBe("Missing API key");
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const authorized = await request(app)
      .get("/api/storytime/projects")
      .set("Authorization", "Bearer secret");

    expect(authorized.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves an OpenAPI schema for GPT Actions without requiring the action API key", async () => {
    process.env.GATEWAY_API_KEY = "secret";
    process.env.PUBLIC_BASE_URL = "https://api.example.com/";
    ({ app } = createApp());

    const res = await request(app).get("/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body.servers[0].url).toBe("https://api.example.com");
    expect(res.body.paths["/api/storytime/projects"].get.operationId).toBe("listStorytimeProjects");
    expect(res.body.components.securitySchemes.GatewayApiKey.scheme).toBe("bearer");
  });

  it("lists projects through STORYTIME_BASE_URL and applies GPT-friendly filtering", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([
      {
        id: "project-1",
        title: "Moon Rubies",
        description: "A moon-heist universe",
        type: "universe",
        counts: { characters: 3 },
      },
      {
        id: "project-2",
        title: "Harbor Village",
        description: "Coastal alchemy",
        type: "universe",
        counts: { characters: 8 },
      },
    ]));

    const res = await request(app).get("/api/storytime/projects?type=universe&q=moon&limit=5");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: "project-1",
      title: "Moon Rubies",
      counts: { characters: 3 },
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("http://storytime.local/api/projects?type=universe");
    expect(init.method).toBe("GET");
  });

  it("searches canon from the StoryTime encyclopedia", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      project: { id: "project-1", title: "Moon Rubies" },
      catalog: {
        characters: [
          { id: "char-1", name: "Cressa Vale", description: "Harbor warden" },
        ],
        bestiary: [
          { id: "beast-1", name: "Moon Slime", description: "Ruby-hunting lunar ooze" },
        ],
      },
    }));

    const res = await request(app).get("/api/storytime/projects/project-1/canon/search?q=ruby&limit=3");

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({
      type: "bestiary",
      id: "beast-1",
      name: "Moon Slime",
    });
  });

  it("upserts characters by name when an id is not supplied", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([
        { id: "char-1", projectId: "project-1", name: "Cressa Vale" },
      ]))
      .mockResolvedValueOnce(jsonResponse({
        id: "char-1",
        projectId: "project-1",
        name: "Cressa Vale",
        motivation: "Protect the harbor",
      }));

    const res = await request(app)
      .post("/api/storytime/projects/project-1/characters/upsert")
      .send({ name: "Cressa Vale", motivation: "Protect the harbor" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "char-1",
      name: "Cressa Vale",
      motivation: "Protect the harbor",
    });

    const [patchUrl, patchInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(patchUrl.toString()).toBe("http://storytime.local/api/characters/char-1");
    expect(patchInit.method).toBe("PATCH");
    expect(JSON.parse(String(patchInit.body))).toMatchObject({
      projectId: "project-1",
      name: "Cressa Vale",
      motivation: "Protect the harbor",
      source: "chatgpt-mobile-gpt",
    });
  });

  it("composes a project with an optional parent story scope", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true,
      totalComposed: 2,
      allQualityPassed: true,
    }));

    const res = await request(app)
      .post("/api/storytime/projects/project-1/compose")
      .send({ parentStoryId: "story-1" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      totalComposed: 2,
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("http://storytime.local/api/composer/all");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      projectId: "project-1",
      parentStoryId: "story-1",
      source: "chatgpt-mobile-gpt",
    });
  });

  it("replaces derivative content exactly while preserving existing metadata", async () => {
    const replacement = "New chapter text.\n\nNo Slipway 9 material remains.";
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        id: "derivative-1",
        projectId: "project-1",
        type: "story",
        title: "Chapter One",
        content: "Old chapter text with Slipway 9.",
        metadata: {
          parentStoryId: "story-1",
          structure: { sections: [{ title: "Opening" }] },
          wordCount: 6,
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: "derivative-1",
        projectId: "project-1",
        type: "story",
        title: "Chapter One",
        status: "in_review",
        content: replacement,
        metadata: {
          parentStoryId: "story-1",
          structure: { sections: [{ title: "Opening" }] },
          wordCount: 8,
          exactContentReplacement: true,
        },
      }));

    const res = await request(app)
      .put("/api/storytime/derivatives/derivative-1/content")
      .send({
        content: replacement,
        status: "in_review",
        metadata: { reviewedBy: "mobile-gpt" },
      });

    expect(res.status).toBe(200);
    expect(res.body.exactContentSaved).toBe(true);
    expect(res.body.contentLength).toBe(replacement.length);
    expect(res.body.savedContentLength).toBe(replacement.length);
    expect(res.body.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.savedContentSha256).toBe(res.body.contentSha256);

    const [getUrl, getInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(getUrl.toString()).toBe("http://storytime.local/api/derivatives/derivative-1");
    expect(getInit.method).toBe("GET");

    const [putUrl, putInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(putUrl.toString()).toBe("http://storytime.local/api/derivatives/derivative-1");
    expect(putInit.method).toBe("PUT");
    const body = JSON.parse(String(putInit.body));
    expect(body.content).toBe(replacement);
    expect(body.status).toBe("in_review");
    expect(body.metadata).toMatchObject({
      parentStoryId: "story-1",
      structure: { sections: [{ title: "Opening" }] },
      reviewedBy: "mobile-gpt",
      exactContentReplacement: true,
    });
    expect(body.source).toBe("chatgpt-mobile-gpt");
  });

  it("rejects exact derivative content replacement without string content", async () => {
    const res = await request(app)
      .put("/api/storytime/derivatives/derivative-1/content")
      .send({ content: null });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("content is required and must be a string");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards derivative review dossiers as JSON by default", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      markdown: "# Review Dossier\n\nCurrent draft prose.",
    }));

    const res = await request(app).get("/api/storytime/derivatives/derivative-1/review-dossier");

    expect(res.status).toBe(200);
    expect(res.body.markdown).toContain("Review Dossier");

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("http://storytime.local/api/derivatives/derivative-1/review-dossier");
    expect(init.method).toBe("GET");
  });

  it("preserves raw Markdown review dossiers when requested", async () => {
    fetchMock.mockResolvedValueOnce(new Response("# Review Dossier\n\nRaw markdown.", {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    }));

    const res = await request(app).get("/api/storytime/derivatives/derivative-1/review-dossier?format=raw");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.text).toContain("Raw markdown");

    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("http://storytime.local/api/derivatives/derivative-1/review-dossier?format=raw");
  });

  it("includes compose-all and review-dossier actions in the OpenAPI schema", async () => {
    const res = await request(app).get("/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body.paths["/api/storytime/projects/{projectId}/compose"].post.operationId).toBe("composeStorytimeProject");
    expect(res.body.paths["/api/storytime/derivatives/{derivativeId}/review-dossier"].get.operationId).toBe("getStorytimeReviewDossier");
    expect(res.body.paths["/api/storytime/derivatives/{derivativeId}/content"].put.operationId).toBe("replaceStorytimeDerivativeContent");
    expect(res.body.paths["/api/storytime/derivatives/{derivativeId}/compose"].post.summary).toContain("Do not use for exact");
  });

  it("returns a clear configuration error when StoryTime has not been wired", async () => {
    delete process.env.STORYTIME_BASE_URL;
    ({ app } = createApp());

    const res = await request(app).get("/api/storytime/projects");

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("STORYTIME_BASE_URL is not configured");
  });
});
