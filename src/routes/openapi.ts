import { Router } from "express";

export function createOpenApiRouter(): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(buildOpenApiDocument());
  });

  return router;
}

function buildOpenApiDocument() {
  const serverUrl = process.env.PUBLIC_BASE_URL?.trim() || "https://api.jimmothy.site";

  return {
    openapi: "3.1.0",
    info: {
      title: "Jimmothy Gateway Actions API",
      version: "1.1.0",
      description: "Authenticated gateway actions for GitHub project planning and StoryTime universe work.",
    },
    servers: [{ url: serverUrl.replace(/\/+$/, "") }],
    components: {
      securitySchemes: {
        GatewayApiKey: {
          type: "http",
          scheme: "bearer",
          description: "Use the same gateway API key configured for the project helper GPT.",
        },
      },
      schemas: {
        StorytimeProjectInput: {
          type: "object",
          properties: {
            title: { type: "string" },
            author: { type: "string" },
            description: { type: "string" },
            content: { type: "string" },
            type: { type: "string", default: "universe" },
            promotionPolicy: { type: "string", enum: ["auto_promote", "auto_accept", "manual"] },
            isProtected: { type: "boolean" },
          },
          required: ["title"],
        },
        StorytimeCharacterInput: {
          type: "object",
          properties: {
            id: { type: "string" },
            characterId: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            background: { type: "string" },
            traits: { type: "array", items: {} },
            relationships: { type: "array", items: {} },
            characterType: { type: "string" },
            role: { type: "string" },
            motivation: { type: "string" },
            importance: { type: "string", enum: ["principal", "supporting", "background"] },
            activeTimeframeStart: { type: ["integer", "null"] },
            activeTimeframeEnd: { type: ["integer", "null"] },
            isProtected: { type: "boolean" },
          },
          required: ["name"],
        },
        StorytimeBestiaryInput: {
          type: "object",
          properties: {
            id: { type: "string" },
            bestiaryId: { type: "string" },
            name: { type: "string" },
            category: { type: "string" },
            hearts: { type: ["integer", "null"] },
            tactics: { type: "array", items: {} },
            status: { type: "string" },
            description: { type: "string" },
            notes: { type: "string" },
            inUniverseBackstory: { type: "string" },
            motivation: { type: "string" },
            ecologicalNiche: { type: "string" },
            demographicAdaptations: { type: "object" },
          },
          required: ["name"],
        },
        StorytimeDerivativeInput: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["campaign", "story", "screenplay", "game_concept", "storyboard"] },
            title: { type: "string" },
            description: { type: "string" },
            status: { type: "string" },
            content: { type: "string" },
            sourceCanonReferences: { type: "array", items: {} },
            metadata: { type: "object" },
          },
          required: ["type", "title"],
        },
        StorytimeDerivativeContentReplacementInput: {
          type: "object",
          description: "Exact-content editor payload. Use this only after the replacement prose is already written; this endpoint saves the provided content literally and does not invoke the composer.",
          properties: {
            content: {
              type: "string",
              description: "The full replacement text to save exactly as the derivative/chapter content. Do not summarize, append old text, or ask StoryTime to regenerate it.",
            },
            status: {
              type: "string",
              enum: ["draft", "in_progress", "completed", "accepted", "in_review", "archived"],
              description: "Optional derivative status to set after saving the exact content.",
            },
            metadata: {
              type: "object",
              description: "Optional metadata patch. Existing derivative metadata is preserved and this object is merged over it.",
            },
            sourceCanonReferences: {
              type: "array",
              items: {},
              description: "Optional replacement canon-reference list.",
            },
          },
          required: ["content"],
        },
      },
    },
    security: [{ GatewayApiKey: [] }],
    paths: {
      "/plans-to-project/plan-from-text": {
        post: {
          operationId: "planFromText",
          summary: "Validate and apply a GitHub project plan from YAML text.",
          requestBody: jsonBody({
            type: "object",
            properties: {
              planYaml: { type: "string" },
              repositoryOverride: { type: "string" },
              createRepoIfMissing: { type: "boolean" },
            },
            required: ["planYaml"],
          }),
          responses: basicResponses(),
        },
      },
      "/plans-to-project/preflight-from-text": {
        post: {
          operationId: "preflightPlanFromText",
          summary: "Validate a GitHub project plan from YAML text without applying it.",
          requestBody: jsonBody({
            type: "object",
            properties: {
              planYaml: { type: "string" },
            },
            required: ["planYaml"],
          }),
          responses: basicResponses(),
        },
      },
      "/api/storytime/projects": {
        get: {
          operationId: "listStorytimeProjects",
          summary: "List StoryTime universe projects.",
          parameters: [
            queryParam("q", "string", "Optional text search."),
            queryParam("type", "string", "Optional project type filter."),
            queryParam("limit", "integer", "Maximum projects to return."),
          ],
          responses: basicResponses(),
        },
        post: {
          operationId: "createStorytimeProject",
          summary: "Create a StoryTime universe project.",
          requestBody: refBody("#/components/schemas/StorytimeProjectInput"),
          responses: basicResponses(201),
        },
      },
      "/api/storytime/projects/{projectId}": {
        get: {
          operationId: "getStorytimeProject",
          summary: "Get a compact StoryTime project summary.",
          parameters: [pathParam("projectId")],
          responses: basicResponses(),
        },
        patch: {
          operationId: "updateStorytimeProject",
          summary: "Update StoryTime project metadata.",
          parameters: [pathParam("projectId")],
          requestBody: refBody("#/components/schemas/StorytimeProjectInput"),
          responses: basicResponses(),
        },
      },
      "/api/storytime/projects/{projectId}/encyclopedia": {
        get: {
          operationId: "getStorytimeEncyclopediaSummary",
          summary: "Get counts and recent encyclopedia updates for a universe.",
          parameters: [pathParam("projectId")],
          responses: basicResponses(),
        },
      },
      "/api/storytime/projects/{projectId}/canon/search": {
        get: {
          operationId: "searchStorytimeCanon",
          summary: "Search universe canon across encyclopedia dimensions.",
          parameters: [
            pathParam("projectId"),
            queryParam("q", "string", "Search text.", true),
            queryParam("types", "string", "Comma-separated catalog keys such as characters,locations,factions,bestiary,timelineEvents."),
            queryParam("limit", "integer", "Maximum matches to return."),
          ],
          responses: basicResponses(),
        },
      },
      "/api/storytime/projects/{projectId}/characters": {
        get: {
          operationId: "listStorytimeCharacters",
          summary: "List characters in a universe.",
          parameters: [
            pathParam("projectId"),
            queryParam("importance", "string", "Optional importance filter."),
            queryParam("characterType", "string", "Optional character type filter."),
            queryParam("timeframeYear", "integer", "Optional active-year filter."),
          ],
          responses: basicResponses(),
        },
      },
      "/api/storytime/projects/{projectId}/characters/upsert": {
        post: {
          operationId: "upsertStorytimeCharacter",
          summary: "Create or update a StoryTime character by id or name.",
          parameters: [pathParam("projectId")],
          requestBody: refBody("#/components/schemas/StorytimeCharacterInput"),
          responses: basicResponses(201),
        },
      },
      "/api/storytime/projects/{projectId}/bestiary": {
        get: {
          operationId: "listStorytimeBestiary",
          summary: "List bestiary entries in a universe.",
          parameters: [pathParam("projectId")],
          responses: basicResponses(),
        },
      },
      "/api/storytime/projects/{projectId}/bestiary/upsert": {
        post: {
          operationId: "upsertStorytimeBestiaryEntry",
          summary: "Create or update a bestiary entry by id or name.",
          parameters: [pathParam("projectId")],
          requestBody: refBody("#/components/schemas/StorytimeBestiaryInput"),
          responses: basicResponses(201),
        },
      },
      "/api/storytime/projects/{projectId}/derivatives": {
        get: {
          operationId: "listStorytimeDerivatives",
          summary: "List derivative works for a universe.",
          parameters: [
            pathParam("projectId"),
            queryParam("type", "string", "Optional derivative type."),
          ],
          responses: basicResponses(),
        },
        post: {
          operationId: "createStorytimeDerivative",
          summary: "Create a derivative work such as a story, screenplay, campaign, storyboard, or game concept.",
          parameters: [pathParam("projectId")],
          requestBody: refBody("#/components/schemas/StorytimeDerivativeInput"),
          responses: basicResponses(201),
        },
      },
      "/api/storytime/derivatives/{derivativeId}": {
        patch: {
          operationId: "updateStorytimeDerivative",
          summary: "Update derivative metadata, title, description, status, or other fields. For exact chapter prose replacement, prefer replaceStorytimeDerivativeContent.",
          parameters: [pathParam("derivativeId")],
          requestBody: jsonBody({ type: "object", additionalProperties: true }),
          responses: basicResponses(),
        },
      },
      "/api/storytime/derivatives/{derivativeId}/content": {
        put: {
          operationId: "replaceStorytimeDerivativeContent",
          summary: "Save exact replacement text for a chapter or derivative without invoking StoryTime composition.",
          description: "Use this when the user provides or approves replacement prose. This is a literal editor endpoint, not a generative composer. The response includes exactContentSaved plus SHA-256 hashes and lengths so the caller can verify StoryTime stored the same content that was submitted.",
          parameters: [pathParam("derivativeId")],
          requestBody: refBody("#/components/schemas/StorytimeDerivativeContentReplacementInput"),
          responses: basicResponses(),
        },
      },
      "/api/storytime/derivatives/{derivativeId}/compose": {
        post: {
          operationId: "composeStorytimeDerivative",
          summary: "Generate or regenerate prose for a derivative work using StoryTime's composer. Do not use for exact user-authored replacements.",
          parameters: [pathParam("derivativeId")],
          requestBody: jsonBody({
            type: "object",
            properties: {
              customPrompt: { type: "string" },
            },
          }),
          responses: basicResponses(),
        },
      },
      "/api/storytime/projects/{projectId}/compose": {
        post: {
          operationId: "composeStorytimeProject",
          summary: "Compose and critique all story chapters for a universe, or only chapters under one parent story.",
          parameters: [pathParam("projectId")],
          requestBody: jsonBody({
            type: "object",
            properties: {
              parentStoryId: {
                type: "string",
                description: "Optional story derivative id. When provided, StoryTime composes only that story's chapters.",
              },
            },
          }),
          responses: basicResponses(),
        },
      },
      "/api/storytime/derivatives/{derivativeId}/review-dossier": {
        get: {
          operationId: "getStorytimeReviewDossier",
          summary: "Get a self-contained review dossier for a story or chapter derivative.",
          parameters: [
            pathParam("derivativeId"),
            queryParam("format", "string", "Use raw for text/markdown output; omit for JSON."),
          ],
          responses: {
            200: {
              description: "Review dossier returned as JSON or text/markdown when format=raw.",
              content: {
                "application/json": { schema: {} },
                "text/markdown": { schema: { type: "string" } },
              },
            },
            400: { description: "Invalid request" },
            401: { description: "Missing API key" },
            403: { description: "Invalid API key" },
            502: { description: "Backend request failed" },
            503: { description: "Backend is not configured" },
          },
        },
      },
      "/api/storytime/projects/{projectId}/drafts": {
        get: {
          operationId: "listStorytimeDrafts",
          summary: "List generated drafts for a universe.",
          parameters: [
            pathParam("projectId"),
            queryParam("status", "string", "Optional status: generated, accepted, or rejected."),
          ],
          responses: basicResponses(),
        },
      },
      "/api/storytime/drafts/{draftId}": {
        get: {
          operationId: "getStorytimeDraft",
          summary: "Get a generated draft for review.",
          parameters: [pathParam("draftId")],
          responses: basicResponses(),
        },
      },
      "/api/storytime/drafts/{draftId}/status": {
        post: {
          operationId: "setStorytimeDraftStatus",
          summary: "Set a generated draft status.",
          parameters: [pathParam("draftId")],
          requestBody: jsonBody({
            type: "object",
            properties: {
              status: { type: "string", enum: ["generated", "accepted", "rejected"] },
            },
            required: ["status"],
          }),
          responses: basicResponses(),
        },
      },
      "/api/storytime/drafts/{draftId}/promote": {
        post: {
          operationId: "promoteStorytimeDraft",
          summary: "Promote an accepted generated draft into universe canon.",
          parameters: [pathParam("draftId")],
          requestBody: jsonBody({
            type: "object",
            properties: {
              force: { type: "boolean" },
            },
          }),
          responses: basicResponses(),
        },
      },
      "/api/storytime/projects/{projectId}/exploration/preview": {
        post: {
          operationId: "previewStorytimeExplorationCycle",
          summary: "Preview autonomous universe expansion tasks before writing to the dashboard.",
          parameters: [pathParam("projectId")],
          requestBody: jsonBody(explorationCycleSchema(false)),
          responses: basicResponses(),
        },
      },
      "/api/storytime/projects/{projectId}/exploration/run": {
        post: {
          operationId: "runStorytimeExplorationCycle",
          summary: "Run an autonomous universe expansion cycle and write tasks to the dashboard.",
          parameters: [pathParam("projectId")],
          requestBody: jsonBody(explorationCycleSchema(true)),
          responses: basicResponses(),
        },
      },
    },
  };
}

function pathParam(name: string) {
  return {
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
  };
}

function queryParam(name: string, type: string, description: string, required = false) {
  return {
    name,
    in: "query",
    required,
    description,
    schema: { type },
  };
}

function jsonBody(schema: object) {
  return {
    required: true,
    content: {
      "application/json": { schema },
    },
  };
}

function refBody(ref: string) {
  return jsonBody({ $ref: ref });
}

function basicResponses(successStatus = 200) {
  return {
    [successStatus]: {
      description: "Success",
      content: {
        "application/json": {
          schema: {},
        },
      },
    },
    400: { description: "Invalid request" },
    401: { description: "Missing API key" },
    403: { description: "Invalid API key" },
    502: { description: "Backend request failed" },
    503: { description: "Backend is not configured" },
  };
}

function explorationCycleSchema(run: boolean) {
  return {
    type: "object",
    properties: {
      maxDepth: { type: "integer" },
      taskBudget: { type: "integer" },
      autonomyProfile: {
        type: "string",
        description: "Optional StoryTime-side autonomy profile, if supported by the backend.",
      },
      run: {
        type: "boolean",
        description: run ? "Call this endpoint only when the user intends to spawn tasks." : "Ignored by preview.",
      },
    },
  };
}
