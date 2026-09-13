import {
  AUDIENCES, CANON_KIND_KEYS, WORK_ASKS, WORK_FORM_KEYS, WORK_STATUSES,
} from "./contesora-model.js";

/**
 * The schema a Custom GPT imports for the Contesora actions.
 *
 * Written to OpenAI's GPT Action limits, which a test enforces: an operation
 * summary or description is at most 300 characters, a parameter description at
 * most 700, and the whole surface stays under 30 operations. Those 300
 * characters say what one call does; how the calls fit together is the guide
 * (getContesoraGuide), which every other description points back to.
 *
 * x-openai-isConsequential is set on purpose rather than left to its default,
 * which would make every write ask for confirmation with no "always allow".
 * Writes Contesora keeps a version of, or that only add, are not consequential;
 * deleting a work and putting a proposal in force are.
 */

type Schema = Record<string, unknown>;

interface OperationSpec {
  id: string;
  summary: string;
  description?: string;
  consequential?: boolean;
  params?: Array<{ name: string; in: "path" | "query"; description: string; required?: boolean; schema?: Schema }>;
  body?: Schema;
  success?: number;
  markdown?: boolean;
}

const UNIVERSE_ID = { name: "universeId", in: "path" as const, required: true, description: "The universe's id, from listUniverses." };
const WORK_ID = { name: "workId", in: "path" as const, required: true, description: "A work's or a part's id, from listWorks or getWork." };

export function buildContesoraOpenApiDocument() {
  const serverUrl = (process.env.PUBLIC_BASE_URL?.trim() || "https://api.jimmothy.site").replace(/\/+$/, "");
  const paths: Record<string, Record<string, unknown>> = {};
  const add = (method: string, path: string, spec: OperationSpec) => {
    paths[path] = { ...(paths[path] ?? {}), [method]: operation(spec) };
  };

  add("get", "/api/contesora/guide", {
    id: "getContesoraGuide",
    summary: "Read how Contesora works: universes, canon, works and their forms, editing, pages and plates, and proposals. Call once at the start of a session, before any other action.",
    markdown: true,
  });

  // universes
  add("get", "/api/contesora/universes", {
    id: "listUniverses",
    summary: "List universes, with counts of what each holds.",
    params: [
      { name: "q", in: "query", description: "Only universes whose title or description contains this." },
      { name: "limit", in: "query", description: "At most this many (default 25, max 100).", schema: { type: "integer" } },
    ],
  });
  add("post", "/api/contesora/universes", {
    id: "createUniverse",
    summary: "Create a universe, optionally with its direction and guardrails.",
    consequential: false,
    body: universeBody(["title"]),
    success: 201,
  });
  add("get", "/api/contesora/universes/{universeId}", {
    id: "getUniverse",
    summary: "Get a universe: its description, counts, and its direction (standing direction, current focus, guardrails). Read the guardrails before writing anything in it.",
    params: [UNIVERSE_ID],
  });
  add("patch", "/api/contesora/universes/{universeId}", {
    id: "updateUniverse",
    summary: "Change a universe's title, description or direction. Guardrails replace the whole list, so send every rule that should remain.",
    consequential: false,
    params: [UNIVERSE_ID],
    body: universeBody([]),
  });

  // canon
  add("get", "/api/contesora/universes/{universeId}/canon/search", {
    id: "searchCanon",
    summary: "Search a universe's canon records by text across every kind. Search before creating a record so nothing is duplicated.",
    params: [
      UNIVERSE_ID,
      { name: "q", in: "query", required: true, description: "Text to find." },
      { name: "kinds", in: "query", description: `Comma-separated kinds to search: ${CANON_KIND_KEYS.join(", ")}. All when omitted.` },
      { name: "limit", in: "query", description: "At most this many (default 12, max 50).", schema: { type: "integer" } },
    ],
  });
  add("get", "/api/contesora/universes/{universeId}/canon/{kind}", {
    id: "listCanon",
    summary: "List one kind of canon record in a universe, with each record's fields.",
    params: [
      UNIVERSE_ID,
      kindParam(),
      { name: "q", in: "query", description: "Only records containing this text." },
      { name: "limit", in: "query", description: "At most this many (default 50, max 200).", schema: { type: "integer" } },
    ],
  });
  add("post", "/api/contesora/universes/{universeId}/canon/{kind}", {
    id: "upsertCanon",
    summary: "Create or update a canon record. Updates by id, or by an exact name (title for timeline-events); otherwise creates. Only fields sent change.",
    consequential: false,
    params: [UNIVERSE_ID, kindParam()],
    body: {
      type: "object",
      description: "The record's fields. Characters: name, role, description, motivation, background, appearance, importance (principal, supporting, background). Locations: name, description, parentId, level, regionType. Factions: name, description. Timeline events: title, date, description. Bestiary: name, category, description. Technologies: name, classification, principles, limitations.",
      properties: {
        id: { type: "string", description: "Update this record rather than matching by name." },
        name: { type: "string" },
        title: { type: "string", description: "For timeline-events, instead of name." },
        description: { type: "string" },
      },
      additionalProperties: true,
    },
  });

  // arcs
  add("get", "/api/contesora/universes/{universeId}/arcs", {
    id: "listArcs",
    summary: "List a universe's arcs with their acts (title, summary, beats) and the works built from each.",
    params: [UNIVERSE_ID],
  });
  add("post", "/api/contesora/universes/{universeId}/arcs", {
    id: "saveArc",
    summary: "Create or update an arc and its acts. Matches by id or exact title. An act with an existing actNumber is updated; one without is added after the last.",
    consequential: false,
    params: [UNIVERSE_ID],
    body: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        description: { type: "string", description: "In brief: what is set in motion, who it happens to, what it costs." },
        throughline: { type: "string", description: "What drives it underneath the events." },
        outOfScope: { type: "array", items: { type: "string" }, description: "Rules the writing of this arc is held to." },
        acts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              actNumber: { type: "integer" },
              title: { type: "string" },
              summary: { type: "string" },
              beats: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  });

  // works
  add("get", "/api/contesora/universes/{universeId}/works", {
    id: "listWorks",
    summary: "List a universe's works, each with its parts in order (form, audience, status, words). No text; use getWork for that.",
    params: [UNIVERSE_ID, { name: "type", in: "query", description: "Only works of this form.", schema: { type: "string", enum: WORK_FORM_KEYS } }],
  });
  add("post", "/api/contesora/universes/{universeId}/works", {
    id: "createWork",
    summary: "Create a work. With adaptedFromId it adapts that work: copies its cast and arc and makes one part per source part. adaptationBrief is the author's instruction for the whole adaptation.",
    consequential: false,
    params: [UNIVERSE_ID],
    body: {
      type: "object",
      required: ["title", "type"],
      properties: {
        title: { type: "string" },
        type: { type: "string", enum: WORK_FORM_KEYS, description: "The form. See the guide for what each form's parts contain." },
        audience: { type: "string", enum: [...AUDIENCES] },
        description: { type: "string", description: "What it is: whose story, what is at stake, what shape it takes." },
        adaptedFromId: { type: "string", description: "The work to adapt." },
        adaptationBrief: { type: "string", description: "What the adaptation holds to, for every part it writes." },
        arcId: { type: "string", description: "The arc it is built from." },
      },
    },
    success: 201,
  });
  add("get", "/api/contesora/works/{workId}", {
    id: "getWork",
    summary: "Get a work or part: fields, adaptation brief, content, parts, cast, arc and acts, and saved versions of earlier text.",
    params: [WORK_ID, { name: "includeContent", in: "query", description: "false to leave the text out.", schema: { type: "boolean" } }],
  });
  add("patch", "/api/contesora/works/{workId}", {
    id: "updateWork",
    summary: "Change a work's or part's fields: title, description, status, audience, adaptationBrief, image style, arcId, actId. Never its text; use replaceWorkContent.",
    consequential: false,
    params: [WORK_ID],
    body: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: [...WORK_STATUSES] },
        audience: { type: "string", enum: [...AUDIENCES] },
        adaptationBrief: { type: "string" },
        imageStyle: { type: "string" },
        imageStyleNegative: { type: "string" },
        arcId: { type: ["string", "null"] },
        actId: { type: ["string", "null"], description: "For a part: the act of the work's arc it tells." },
      },
    },
  });
  add("delete", "/api/contesora/works/{workId}", {
    id: "deleteWork",
    summary: "Delete a work or a part, with its pages and panels. Confirm with the author first; this cannot be undone.",
    consequential: true,
    params: [WORK_ID],
  });
  add("put", "/api/contesora/works/{workId}/content", {
    id: "replaceWorkContent",
    summary: "Save text exactly as given as a work's or part's content. Never generates. The text it replaces is kept as a version. Use once the author has approved the text.",
    consequential: false,
    params: [WORK_ID],
    body: {
      type: "object",
      required: ["content"],
      properties: {
        content: { type: "string", description: "The complete text, saved literally. Separate passages with blank lines." },
        reason: { type: "string", description: "Why it changed, kept with the previous version (max 120 characters)." },
        status: { type: "string", enum: [...WORK_STATUSES] },
      },
    },
  });
  add("post", "/api/contesora/works/{workId}/parts", {
    id: "addWorkPart",
    summary: "Add a part (chapter, spread, episode...) to a work, numbered after the last, optionally with its text.",
    consequential: false,
    params: [WORK_ID],
    body: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        description: { type: "string", description: "What happens in it." },
        actId: { type: "string" },
        content: { type: "string" },
      },
    },
    success: 201,
  });
  add("put", "/api/contesora/works/{workId}/cast", {
    id: "setWorkCast",
    summary: "Set who a work bills, in order. Replaces the whole cast. Name characters by characterId or exact name; billing 1 is the lead.",
    consequential: false,
    params: [WORK_ID],
    body: {
      type: "object",
      required: ["cast"],
      properties: {
        cast: {
          type: "array",
          items: {
            type: "object",
            properties: { characterId: { type: "string" }, name: { type: "string" }, billing: { type: "integer" } },
          },
        },
      },
    },
  });
  add("get", "/api/contesora/works/{workId}/review-dossier", {
    id: "getReviewDossier",
    summary: "Get a self-contained review packet for a work or part: premise and beats, the text, the canon it draws on and a rubric. Review against this.",
    params: [WORK_ID],
  });
  add("get", "/api/contesora/works/versions/{versionId}", {
    id: "getWorkVersion",
    summary: "Read an earlier saved version of a work's text, from the versions getWork lists.",
    params: [{ name: "versionId", in: "path", required: true, description: "A version id from getWork." }],
  });
  add("post", "/api/contesora/works/versions/{versionId}/restore", {
    id: "restoreWorkVersion",
    summary: "Make an earlier version the work's text again. The text it replaces is kept as a version.",
    consequential: false,
    params: [{ name: "versionId", in: "path", required: true, description: "A version id from getWork." }],
  });

  // pages and plates
  add("get", "/api/contesora/works/{workId}/pages", {
    id: "getWorkPages",
    summary: "Get a part's pages and panels. For a graphic novel or storyboard, comic pages; for an illustrated novel or children's book, plates placed after a passage (afterParagraph).",
    params: [WORK_ID],
  });
  add("post", "/api/contesora/works/{workId}/pages", {
    id: "addWorkPage",
    summary: "Add a page or plate with its panels. For a plate, afterParagraph is how many prose passages (split on blank lines) come before it; 0 opens the part.",
    consequential: false,
    params: [WORK_ID],
    body: {
      type: "object",
      properties: {
        note: { type: "string", description: "What the page or plate is for." },
        afterParagraph: { type: ["integer", "null"], description: "Plates only. Omit for a comic page." },
        panels: { type: "array", items: panelSchema() },
      },
    },
    success: 201,
  });
  add("patch", "/api/contesora/panels/{panelId}", {
    id: "updateWorkPanel",
    summary: "Change one panel: framing, what is drawn, caption, dialogue or sound. Only fields sent change.",
    consequential: false,
    params: [{ name: "panelId", in: "path", required: true, description: "A panel id from getWorkPages." }],
    body: panelSchema(),
  });

  // proposals
  add("post", "/api/contesora/works/{workId}/requests", {
    id: "askContesora",
    summary: "Ask Contesora's own agent to draft a work's description, content, parts, or where its plates fall. Returns a proposal id at once; the answer takes 1-3 minutes. Nothing changes until it is accepted.",
    consequential: false,
    params: [WORK_ID],
    body: {
      type: "object",
      required: ["ask"],
      properties: {
        ask: { type: "string", enum: [...WORK_ASKS] },
        brief: { type: "string", description: "What the author wants from it." },
      },
    },
    success: 202,
  });
  add("get", "/api/contesora/universes/{universeId}/proposals", {
    id: "listProposals",
    summary: "List proposals waiting in a universe: Contesora's agent's and the dashboard harness's. Each says whether it is answered and can be accepted here.",
    params: [
      UNIVERSE_ID,
      { name: "status", in: "query", description: "generated (waiting, the default), accepted, rejected, or all.", schema: { type: "string", enum: ["generated", "accepted", "rejected", "all"] } },
      { name: "workId", in: "query", description: "Only proposals about this work." },
      { name: "limit", in: "query", description: "At most this many (default 25, max 100).", schema: { type: "integer" } },
    ],
  });
  add("get", "/api/contesora/proposals/{proposalId}", {
    id: "getProposal",
    summary: "Get one proposal, with what it proposes once answered. Poll this after askContesora until answered is true.",
    params: [{ name: "proposalId", in: "path", required: true, description: "The id from askContesora or listProposals." }],
  });
  add("post", "/api/contesora/proposals/{proposalId}/resolve", {
    id: "resolveProposal",
    summary: "Accept, refuse, or send back a proposal with a note. Accept puts it in force: work text and fields, parts, plates, panels, arcs and harness drafts. Show the author first.",
    consequential: true,
    params: [{ name: "proposalId", in: "path", required: true, description: "The proposal to resolve." }],
    body: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["accept", "refuse", "revise"] },
        note: { type: "string", description: "Required to revise: what to change." },
      },
    },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "Contesora",
      version: "2.0.0",
      description: "Review, edit and create work in Contesora: universes, canon, arcs, works and their parts, pages and plates, and proposals from Contesora's own agent. Call getContesoraGuide first.",
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        GatewayApiKey: { type: "http", scheme: "bearer", description: "The gateway API key." },
      },
      schemas: {},
    },
    security: [{ GatewayApiKey: [] }],
    paths,
  };
}

function operation(spec: OperationSpec) {
  return {
    operationId: spec.id,
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.consequential === undefined ? {} : { "x-openai-isConsequential": spec.consequential }),
    ...(spec.params?.length ? {
      parameters: spec.params.map((p) => ({
        name: p.name,
        in: p.in,
        required: p.in === "path" ? true : Boolean(p.required),
        description: p.description,
        schema: p.schema ?? { type: "string" },
      })),
    } : {}),
    ...(spec.body ? { requestBody: { required: true, content: { "application/json": { schema: spec.body } } } } : {}),
    responses: {
      [spec.success ?? 200]: spec.markdown
        ? { description: "The guide, as Markdown.", content: { "text/markdown": { schema: { type: "string" } } } }
        : { description: "Success", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
      400: { description: "Invalid request; the error says what to fix." },
      401: { description: "Missing API key" },
      403: { description: "Invalid API key, or the record is protected" },
      404: { description: "Not found" },
      409: { description: "The proposal is already resolved, or not answered yet" },
      422: { description: "This kind of proposal is accepted in Contesora, not here" },
      502: { description: "Contesora did not answer" },
      503: { description: "Contesora is not configured on the gateway" },
    },
  };
}

function universeBody(required: string[]): Schema {
  return {
    type: "object",
    ...(required.length ? { required } : {}),
    properties: {
      title: { type: "string" },
      description: { type: "string", description: "What this universe is, in a paragraph." },
      standingDirection: { type: "string", description: "What the universe is always working toward." },
      currentFocus: { type: "string", description: "What matters right now." },
      guardrails: { type: "array", items: { type: "string" }, description: "Rules no writing may break, one per item. Replaces the list." },
    },
  };
}

function kindParam() {
  return {
    name: "kind",
    in: "path" as const,
    required: true,
    description: "The kind of canon record.",
    schema: { type: "string", enum: CANON_KIND_KEYS },
  };
}

function panelSchema(): Schema {
  return {
    type: "object",
    properties: {
      framing: { type: "string", description: "Establishing, Wide, Medium, Close, Extreme close, Overhead or Insert." },
      description: { type: "string", description: "What is drawn: drawable, no thoughts or back story." },
      caption: { type: "string" },
      dialogue: {
        type: "array",
        items: { type: "object", properties: { speaker: { type: "string" }, line: { type: "string" } } },
        description: "Comic pages only; plates have none.",
      },
      sfx: { type: "array", items: { type: "string" }, description: "Comic pages only." },
    },
  };
}
