import { Router, type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { StorytimeClient, StorytimeConfigError, StorytimeUpstreamError } from "../clients/storytime-client.js";
import { contesoraGuide } from "./contesora-guide.js";
import {
  ACCEPTABLE_HERE, AUDIENCES, CANON_KINDS, WORK_ASKS, WORK_FORM_KEYS, WORK_STATUSES, WRITTEN_WORDS,
  type CanonKind, type WorkAsk,
} from "./contesora-model.js";

/**
 * The Contesora actions a Custom GPT uses to review, edit and create work.
 *
 * The older /api/storytime surface was built when a universe was a project
 * with a flat list of derivatives. Contesora has since grown forms and
 * audiences, parts, adaptations with a brief, arcs with acts, pages and plates,
 * versions of every edit, and an agent of its own whose proposals are reviewed
 * before they are in force. This surface speaks that model, in the words the
 * app uses, and stays inside what a GPT Action can hold: under 30 operations,
 * 45 seconds a call, responses under 100,000 characters. /api/storytime stays
 * as it was, so a GPT that has not re-imported its schema keeps working.
 */

type JsonObject = Record<string, unknown>;

const SOURCE = "contesora-gpt";
const MAX_CONTENT_CHARS = 60_000;
const MAX_DOSSIER_CHARS = 90_000;

class RequestError extends Error {
  constructor(readonly status: number, message: string, readonly details?: JsonObject) {
    super(message);
  }
}

export function createContesoraRouter(client = new StorytimeClient()): Router {
  const router = Router();
  const route = (handler: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response) => {
      try {
        await handler(req, res);
      } catch (err) {
        sendError(res, err);
      }
    };

  // ---- the guide -----------------------------------------------------------

  router.get("/guide", (_req, res) => {
    res.type("text/markdown; charset=utf-8").send(contesoraGuide());
  });

  // ---- universes -----------------------------------------------------------

  router.get("/universes", route(async (req, res) => {
    const rows = asList(await client.get("/api/stories"));
    const q = text(req.query.q)?.toLowerCase();
    const limit = positiveInt(req.query.limit, 25, 100);
    const matched = q ? rows.filter((u) => JSON.stringify([u.title, u.description]).toLowerCase().includes(q)) : rows;
    res.json(matched.slice(0, limit).map((u) => ({
      id: u.id,
      title: u.title,
      description: clip(u.description, 400),
      counts: u.counts,
      updatedAt: u.updatedAt,
    })));
  }));

  router.post("/universes", route(async (req, res) => {
    const title = required(text(req.body?.title), "title");
    const created = obj(await client.post("/api/stories", withSource({
      title,
      description: text(req.body?.description) ?? "",
      type: "universe",
    })));
    const universeId = String(created.id);
    await saveDirection(client, universeId, req.body ?? {});
    res.status(201).json(await universeSummary(client, universeId));
  }));

  router.get("/universes/:universeId", route(async (req, res) => {
    res.json(await universeSummary(client, param(req, "universeId")));
  }));

  router.patch("/universes/:universeId", route(async (req, res) => {
    const universeId = param(req, "universeId");
    const body = req.body ?? {};
    const fields = pick(body, ["title", "description"]);
    if (Object.keys(fields).length) {
      await client.patch(`/api/stories/${enc(universeId)}`, withSource(fields));
    }
    await saveDirection(client, universeId, body);
    res.json(await universeSummary(client, universeId));
  }));

  // ---- canon ---------------------------------------------------------------

  router.get("/universes/:universeId/canon/search", route(async (req, res) => {
    const universeId = param(req, "universeId");
    const q = required(text(req.query.q), "q").toLowerCase();
    const kinds = new Set((text(req.query.kinds) ?? "").split(",").map((k) => k.trim()).filter(Boolean));
    const limit = positiveInt(req.query.limit, 12, 50);
    const encyclopedia = obj(await client.get(`/api/stories/${enc(universeId)}/encyclopedia`));
    const catalog = obj(encyclopedia.catalog);
    const results: JsonObject[] = [];
    for (const [kind, spec] of Object.entries(CANON_KINDS)) {
      if (kinds.size && !kinds.has(kind)) continue;
      for (const row of asList(catalog[spec.catalog])) {
        if (!JSON.stringify(row).toLowerCase().includes(q)) continue;
        results.push(canonSummary(kind as CanonKind, row));
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }
    res.json({ q, results });
  }));

  router.get("/universes/:universeId/canon/:kind", route(async (req, res) => {
    const universeId = param(req, "universeId");
    const kind = canonKind(req);
    const q = text(req.query.q)?.toLowerCase();
    const limit = positiveInt(req.query.limit, 50, 200);
    const rows = asList(await client.get(CANON_KINDS[kind].route, { query: { projectId: universeId } }));
    const matched = q ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q)) : rows;
    res.json({
      kind,
      total: matched.length,
      records: matched.slice(0, limit).map((r) => ({ ...canonSummary(kind, r), record: trimRecord(r) })),
    });
  }));

  router.post("/universes/:universeId/canon/:kind", route(async (req, res) => {
    const universeId = param(req, "universeId");
    const kind = canonKind(req);
    const spec = CANON_KINDS[kind];
    const body = obj(req.body);
    const { id: givenId, ...fields } = body;
    delete fields.projectId;
    const name = text(fields[spec.nameField]);

    let existing: JsonObject | undefined;
    if (text(givenId)) {
      existing = obj(await client.get(`${spec.route}/${enc(String(givenId))}`));
    } else if (name) {
      existing = asList(await client.get(spec.route, { query: { projectId: universeId } }))
        .find((r) => String(r[spec.nameField] ?? "").trim().toLowerCase() === name.toLowerCase());
    }

    if (existing?.id) {
      if (existing.projectId && existing.projectId !== universeId) {
        throw new RequestError(400, "That record belongs to another universe.");
      }
      // Found by its name, it keeps its name: the match ignores case, and
      // writing back the caller's casing renamed "Taruc" to "taruc". Only an
      // update by id renames.
      if (!text(givenId)) delete fields[spec.nameField];
      const saved = obj(await client.put(`${spec.route}/${enc(String(existing.id))}`, withSource(fields)));
      res.json({ action: "updated", kind, ...canonSummary(kind, saved), record: trimRecord(saved) });
      return;
    }
    required(name, spec.nameField);
    const created = obj(await client.post(spec.route, withSource({ ...fields, projectId: universeId })));
    res.status(201).json({ action: "created", kind, ...canonSummary(kind, created), record: trimRecord(created) });
  }));

  // ---- arcs ----------------------------------------------------------------

  router.get("/universes/:universeId/arcs", route(async (req, res) => {
    const arcs = asList(await client.get("/api/arcs", { query: { projectId: param(req, "universeId") } }));
    res.json(arcs.map(arcSummary));
  }));

  router.post("/universes/:universeId/arcs", route(async (req, res) => {
    const universeId = param(req, "universeId");
    const body = obj(req.body);
    const title = text(body.title);
    let arc: JsonObject | undefined;
    if (text(body.id)) {
      arc = obj(await client.get(`/api/arcs/${enc(String(body.id))}`));
    } else if (title) {
      arc = asList(await client.get("/api/arcs", { query: { projectId: universeId } }))
        .find((a) => String(a.title ?? "").trim().toLowerCase() === title.toLowerCase());
    }
    const created = !arc?.id;
    if (!arc?.id) {
      arc = obj(await client.post("/api/arcs", withSource({ projectId: universeId, title: required(title, "title") })));
    }
    const arcId = String(arc.id);
    const fields = pick(body, ["title", "description", "throughline", "outOfScope"]);
    if (Object.keys(fields).length) await client.patch(`/api/arcs/${enc(arcId)}`, fields);

    const acts = Array.isArray(body.acts) ? body.acts.map(obj) : [];
    if (acts.length) {
      const existing = asList(obj(await client.get(`/api/arcs/${enc(arcId)}`)).acts);
      for (const act of acts) {
        const number = Number(act.actNumber);
        let target = Number.isInteger(number) ? existing.find((e) => e.actNumber === number) : undefined;
        if (!target) {
          target = obj(await client.post(`/api/arcs/${enc(arcId)}/acts`, { title: text(act.title) ?? "" }));
        }
        const actFields = pick(act, ["title", "summary", "beats", "span"]);
        if (Object.keys(actFields).length) await client.patch(`/api/arcs/acts/${enc(String(target.id))}`, actFields);
      }
    }
    res.status(created ? 201 : 200).json(arcSummary(obj(await client.get(`/api/arcs/${enc(arcId)}`))));
  }));

  // ---- works ---------------------------------------------------------------

  router.get("/universes/:universeId/works", route(async (req, res) => {
    const universeId = param(req, "universeId");
    const type = text(req.query.type);
    const works = asList(obj(await client.get("/api/derivatives/surface/index", { query: { projectId: universeId } })).works);
    const partsOf = new Map<string, JsonObject[]>();
    for (const w of works) {
      if (!w.parentId) continue;
      const list = partsOf.get(String(w.parentId)) ?? [];
      list.push(w);
      partsOf.set(String(w.parentId), list);
    }
    const tops = works.filter((w) => !w.parentId && (!type || w.type === type));
    res.json(tops.map((w) => ({
      ...workLine(w),
      parts: (partsOf.get(String(w.id)) ?? [])
        .sort((a, b) => Number(a.partNumber ?? 0) - Number(b.partNumber ?? 0))
        .map(workLine),
    })));
  }));

  router.get("/works/:workId", route(async (req, res) => {
    const includeContent = req.query.includeContent !== "false";
    res.json(await workDetail(client, param(req, "workId"), includeContent));
  }));

  router.post("/universes/:universeId/works", route(async (req, res) => {
    const universeId = param(req, "universeId");
    const body = obj(req.body);
    const type = oneOf(text(body.type) ?? "story", WORK_FORM_KEYS, "type");
    const audience = oneOf(typeof body.audience === "string" ? body.audience : "", AUDIENCES, "audience");
    const brief = text(body.adaptationBrief);
    const made = obj(await client.post("/api/derivatives", withSource({
      projectId: universeId,
      type,
      title: required(text(body.title), "title"),
      description: text(body.description) ?? "",
      audience,
      adaptedFromId: text(body.adaptedFromId) ?? null,
      metadata: brief ? { adaptation: brief } : {},
    })));
    const workId = String(made.id);
    if (text(body.arcId)) await client.patch(`/api/derivatives/surface/${enc(workId)}`, { arcId: body.arcId });
    res.status(201).json({ partsMade: made.partsMade ?? 0, ...(await workDetail(client, workId, false)) });
  }));

  router.patch("/works/:workId", route(async (req, res) => {
    const workId = param(req, "workId");
    const body = obj(req.body);
    if ("content" in body) {
      throw new RequestError(400, "updateWork never changes content. Save text with replaceWorkContent.");
    }
    const patch: JsonObject = pick(body, ["title", "description", "imageStyle", "imageStyleNegative", "arcId", "actId"]);
    if (body.status !== undefined) patch.status = oneOf(String(body.status), WORK_STATUSES, "status");
    if (body.audience !== undefined) patch.audience = oneOf(String(body.audience), AUDIENCES, "audience");
    if (typeof body.adaptationBrief === "string") patch.adaptation = body.adaptationBrief;
    if (!Object.keys(patch).length) throw new RequestError(400, "Nothing to change.");
    await client.patch(`/api/derivatives/surface/${enc(workId)}`, patch);
    res.json(await workDetail(client, workId, false));
  }));

  router.put("/works/:workId/content", route(async (req, res) => {
    const workId = param(req, "workId");
    const content = req.body?.content;
    if (typeof content !== "string") throw new RequestError(400, "content is required and must be a string.");
    const patch: JsonObject = {
      content,
      draftReason: text(req.body?.reason)?.slice(0, 120) ?? "Before an edit from the Contesora GPT",
    };
    if (req.body?.status !== undefined) patch.status = oneOf(String(req.body.status), WORK_STATUSES, "status");
    await client.patch(`/api/derivatives/surface/${enc(workId)}`, patch);
    const saved = String(obj(obj(await client.get(`/api/derivatives/surface/${enc(workId)}`)).work).content ?? "");
    res.json({
      workId,
      exactContentSaved: saved === content,
      words: countWords(content),
      contentSha256: sha256(content),
      savedContentSha256: sha256(saved),
      previousVersionKept: true,
    });
  }));

  router.post("/works/:workId/parts", route(async (req, res) => {
    const workId = param(req, "workId");
    const body = obj(req.body);
    const made = obj(await client.post(`/api/derivatives/surface/${enc(workId)}/parts`, {
      title: required(text(body.title), "title"),
      description: text(body.description) ?? "",
      actId: text(body.actId) ?? null,
    }));
    if (typeof body.content === "string" && body.content.trim()) {
      await client.patch(`/api/derivatives/surface/${enc(String(made.id))}`, { content: body.content });
    }
    res.status(201).json(await workDetail(client, String(made.id), false));
  }));

  router.delete("/works/:workId", route(async (req, res) => {
    const workId = param(req, "workId");
    const said = obj(await client.get(`/api/records/work/${enc(workId)}/consequences`));
    if (said.protected) throw new RequestError(403, "That work is protected and cannot be deleted.");
    const gone = obj(await client.delete(`/api/records/work/${enc(workId)}`));
    res.json({ deleted: gone.name ?? said.name, workId, alsoRemoved: said.effects ?? [] });
  }));

  router.get("/works/versions/:versionId", route(async (req, res) => {
    const version = obj(await client.get(`/api/derivatives/drafts/${enc(param(req, "versionId"))}`));
    const content = String(version.content ?? "");
    res.json({
      id: version.id,
      workId: version.workId,
      reason: version.reason,
      words: version.words,
      createdAt: version.createdAt,
      content: content.slice(0, MAX_CONTENT_CHARS),
      contentTruncated: content.length > MAX_CONTENT_CHARS,
    });
  }));

  router.post("/works/versions/:versionId/restore", route(async (req, res) => {
    const restored = obj(await client.post(`/api/derivatives/drafts/${enc(param(req, "versionId"))}/restore`, {}));
    res.json({ restored: true, workId: restored.workId, replacedTextKeptAsVersion: true });
  }));

  router.put("/works/:workId/cast", route(async (req, res) => {
    const workId = param(req, "workId");
    const entries: JsonObject[] = Array.isArray(req.body?.cast) ? (req.body.cast as unknown[]).map(obj) : [];
    if (!entries.length) throw new RequestError(400, "cast must list at least one character.");
    const work = obj(obj(await client.get(`/api/derivatives/surface/${enc(workId)}`)).work);
    const needNames = entries.some((e) => !text(e.characterId));
    const characters = needNames
      ? asList(await client.get("/api/characters", { query: { projectId: String(work.projectId) } }))
      : [];
    const cast = entries.map((e: JsonObject, i: number) => {
      const byName = text(e.name)?.toLowerCase();
      const id = text(e.characterId)
        ?? characters.find((c) => String(c.name ?? "").trim().toLowerCase() === byName)?.id;
      if (!id) throw new RequestError(400, `No character called "${e.name}" in this universe.`);
      return { characterId: id, billing: Number.isInteger(Number(e.billing)) ? Number(e.billing) : i + 1 };
    });
    await client.put(`/api/derivatives/${enc(workId)}/cast`, { cast });
    const detail = await workDetail(client, workId, false);
    res.json({ workId, cast: detail.cast });
  }));

  router.get("/works/:workId/review-dossier", route(async (req, res) => {
    const dossier = obj(await client.get(`/api/derivatives/${enc(param(req, "workId"))}/review-dossier`));
    const markdown = String(dossier.dossierMarkdown ?? "");
    res.json({
      workId: dossier.derivativeId,
      title: dossier.title,
      dossierMarkdown: markdown.slice(0, MAX_DOSSIER_CHARS),
      truncated: markdown.length > MAX_DOSSIER_CHARS,
      howToSubmit: "Save approved text with replaceWorkContent; the previous text is kept as a version.",
    });
  }));

  // ---- pages, panels and plates -------------------------------------------

  router.get("/works/:workId/pages", route(async (req, res) => {
    const pages = asList(obj(await client.get(`/api/derivatives/surface/${enc(param(req, "workId"))}/pages`)).pages);
    res.json({ pages: pages.map(pageSummary) });
  }));

  router.post("/works/:workId/pages", route(async (req, res) => {
    const workId = param(req, "workId");
    const body = obj(req.body);
    const pageBody: JsonObject = { note: text(body.note) ?? "" };
    if (body.afterParagraph !== undefined) pageBody.afterParagraph = body.afterParagraph;
    const page = obj(await client.post(`/api/derivatives/surface/${enc(workId)}/pages`, pageBody));
    const panels = Array.isArray(body.panels) ? body.panels.map(obj) : [];
    for (const panel of panels) {
      await client.post(`/api/derivatives/pages/${enc(String(page.id))}/panels`,
        pick(panel, ["framing", "description", "caption", "dialogue", "sfx"]));
    }
    const pages = asList(obj(await client.get(`/api/derivatives/surface/${enc(workId)}/pages`)).pages);
    res.status(201).json(pageSummary(pages.find((p) => p.id === page.id) ?? page));
  }));

  router.patch("/panels/:panelId", route(async (req, res) => {
    const fields = pick(obj(req.body), ["framing", "description", "caption", "dialogue", "sfx", "panelNumber"]);
    if (!Object.keys(fields).length) throw new RequestError(400, "Nothing to change.");
    await client.patch(`/api/derivatives/panels/${enc(param(req, "panelId"))}`, fields);
    res.json({ panelId: req.params.panelId, updated: Object.keys(fields) });
  }));

  // ---- Contesora's agent: proposals ---------------------------------------

  router.post("/works/:workId/requests", route(async (req, res) => {
    const workId = param(req, "workId");
    const ask = oneOf(text(req.body?.ask) ?? "", WORK_ASKS, "ask") as WorkAsk;
    const brief = text(req.body?.brief);
    const work = obj(obj(await client.get(`/api/derivatives/surface/${enc(workId)}`)).work);
    const projectId = String(work.projectId);
    const at = Date.now();
    const filed = ask === "description" || ask === "content"
      ? { artifactType: "work_canon_request", payload: {
        workId, fields: [ask], brief,
        ...(ask === "content" && Number(work.words ?? 0) > WRITTEN_WORDS ? { revise: true } : {}), at,
      } }
      : { artifactType: ask === "parts" ? "work_parts_request" : "work_plates_request", payload: { workId, brief, at } };
    const draft = obj(await client.post("/api/generated-drafts", { projectId, ...filed }));
    res.status(202).json({
      proposalId: draft.id,
      kind: filed.artifactType,
      answered: false,
      next: "Contesora's agent answers in one to three minutes. Poll getProposal until answered is true, then resolveProposal.",
    });
  }));

  router.get("/universes/:universeId/proposals", route(async (req, res) => {
    const universeId = param(req, "universeId");
    const status = text(req.query.status) ?? "generated";
    const workId = text(req.query.workId);
    const limit = positiveInt(req.query.limit, 25, 100);
    const rows = asList(await client.get("/api/generated-drafts", {
      query: { projectId: universeId, status: status === "all" ? undefined : status },
    }));
    const matched = workId ? rows.filter((r) => obj(r.payload).workId === workId) : rows;
    res.json({ total: matched.length, proposals: matched.slice(0, limit).map((r) => proposalSummary(r)) });
  }));

  router.get("/proposals/:proposalId", route(async (req, res) => {
    const row = obj(await client.get(`/api/generated-drafts/${enc(param(req, "proposalId"))}`));
    res.json(proposalSummary(row, true));
  }));

  router.post("/proposals/:proposalId/resolve", route(async (req, res) => {
    const proposalId = param(req, "proposalId");
    const action = oneOf(text(req.body?.action) ?? "", ["accept", "refuse", "revise"] as const, "action");
    const row = obj(await client.get(`/api/generated-drafts/${enc(proposalId)}`));
    const payload = obj(row.payload);
    const kind = String(row.artifactType ?? "");

    if (row.status !== "generated") {
      throw new RequestError(409, `That proposal is already ${row.status}.`);
    }

    if (action === "refuse") {
      await client.patch(`/api/generated-drafts/${enc(proposalId)}`, { status: "rejected" });
      res.json({ proposalId, resolved: "refused" });
      return;
    }

    if (action === "revise") {
      if (!kind.endsWith("_request")) {
        throw new RequestError(422, "Only proposals from Contesora's agent can be sent back; a harness draft is accepted or refused.", { kind });
      }
      const note = required(text(req.body?.note), "note");
      if (!payload.proposed) throw new RequestError(409, "That proposal has not been answered yet.");
      const { proposed, ...rest } = payload;
      await client.patch(`/api/generated-drafts/${enc(proposalId)}`, {
        payload: { ...rest, previous: proposed, note, at: Date.now() },
      });
      res.status(202).json({ proposalId, resolved: "sent back for revision", next: "Poll getProposal until answered is true." });
      return;
    }

    // accept
    const isRequest = kind.endsWith("_request");
    if (!isRequest) {
      const promoted = await client.post(`/api/generated-drafts/${enc(proposalId)}/promote`, { source: SOURCE });
      res.json({ proposalId, resolved: "accepted into canon", result: promoted });
      return;
    }
    if (!payload.proposed) throw new RequestError(409, "That proposal has not been answered yet.");
    if (!(ACCEPTABLE_HERE as readonly string[]).includes(kind)) {
      throw new RequestError(422, "Accept this kind of proposal in Contesora; only work, part, plate, panel and arc proposals are put in force here.", { kind });
    }
    const applied = await applyProposal(client, kind, payload);
    await client.patch(`/api/generated-drafts/${enc(proposalId)}`, { status: "accepted" });
    res.json({ proposalId, resolved: "accepted", applied });
  }));

  return router;
}

// ---- applying a proposal ----------------------------------------------------

async function applyProposal(client: StorytimeClient, kind: string, payload: JsonObject): Promise<JsonObject> {
  const proposed = obj(payload.proposed);

  if (kind === "work_canon_request") {
    const workId = String(payload.workId);
    const patch: JsonObject = { ...proposed };
    if ("content" in patch) patch.draftReason = "Before a composed version was put in force";
    await client.patch(`/api/derivatives/surface/${enc(workId)}`, patch);
    return { workId, fields: Object.keys(proposed) };
  }

  if (kind === "work_parts_request") {
    const workId = String(payload.workId);
    const acts = asList(obj(await client.get(`/api/derivatives/surface/${enc(workId)}`)).acts);
    const made: unknown[] = [];
    for (const part of asList(proposed.parts)) {
      const act = acts.find((a) => a.actNumber === Number(part.act));
      const created = obj(await client.post(`/api/derivatives/surface/${enc(workId)}/parts`, {
        title: part.title, description: part.description ?? "", actId: act?.id ?? null,
      }));
      made.push(created.id);
    }
    return { workId, partsCreated: made.length, partIds: made };
  }

  if (kind === "work_plates_request") {
    const workId = String(payload.workId);
    let plates = 0;
    for (const plate of asList(proposed.plates)) {
      const page = obj(await client.post(`/api/derivatives/surface/${enc(workId)}/pages`, {
        note: plate.note ?? "", afterParagraph: plate.afterParagraph,
      }));
      for (const panel of asList(plate.panels)) {
        await client.post(`/api/derivatives/pages/${enc(String(page.id))}/panels`, panel);
      }
      plates += 1;
    }
    return { workId, platesCreated: plates };
  }

  if (kind === "work_panels_request") {
    const panels = asList(proposed.panels);
    if (text(payload.panelId)) {
      await client.patch(`/api/derivatives/panels/${enc(String(payload.panelId))}`, panels[0] ?? {});
      return { panelId: payload.panelId, updated: true };
    }
    for (const panel of panels) {
      await client.post(`/api/derivatives/pages/${enc(String(payload.pageId))}/panels`, panel);
    }
    return { pageId: payload.pageId, panelsCreated: panels.length };
  }

  // arc_canon_request
  const arcId = String(payload.arcId);
  if (text(payload.actId)) {
    await client.patch(`/api/arcs/acts/${enc(String(payload.actId))}`, proposed);
    return { arcId, actId: payload.actId, fields: Object.keys(proposed) };
  }
  const { acts, ...fields } = proposed;
  if (Object.keys(fields).length) await client.patch(`/api/arcs/${enc(arcId)}`, fields);
  let actsCreated = 0;
  for (const act of asList(acts)) {
    const created = obj(await client.post(`/api/arcs/${enc(arcId)}/acts`, { title: act.title ?? "" }));
    const actFields = pick(act, ["summary", "beats"]);
    if (Object.keys(actFields).length) await client.patch(`/api/arcs/acts/${enc(String(created.id))}`, actFields);
    actsCreated += 1;
  }
  return { arcId, fields: Object.keys(fields), actsCreated };
}

// ---- reading and shaping ---------------------------------------------------

async function universeSummary(client: StorytimeClient, universeId: string): Promise<JsonObject> {
  const [story, direction] = await Promise.all([
    client.get(`/api/stories/${enc(universeId)}`).then(obj),
    client.get(`/api/editorial/universes/${enc(universeId)}/direction`).then(obj).catch(() => ({} as JsonObject)),
  ]);
  return {
    id: story.id,
    title: story.title,
    description: story.description,
    counts: story.counts,
    direction: {
      standingDirection: direction.persistentGoal ?? "",
      currentFocus: direction.temporaryFocus ?? "",
      guardrails: Array.isArray(direction.guardrails) ? direction.guardrails : [],
    },
    updatedAt: story.updatedAt,
  };
}

async function saveDirection(client: StorytimeClient, universeId: string, body: JsonObject): Promise<void> {
  const patch: JsonObject = {};
  if (typeof body.standingDirection === "string") patch.persistentGoal = body.standingDirection;
  if (typeof body.currentFocus === "string") patch.temporaryFocus = body.currentFocus;
  if (Array.isArray(body.guardrails)) patch.guardrails = body.guardrails.map(String).map((g) => g.trim()).filter(Boolean);
  if (Object.keys(patch).length) {
    await client.patch(`/api/editorial/universes/${enc(universeId)}/direction`, patch);
  }
}

async function workDetail(client: StorytimeClient, workId: string, includeContent: boolean): Promise<JsonObject> {
  const depth = obj(await client.get(`/api/derivatives/surface/${enc(workId)}`));
  const work = obj(depth.work);
  const content = String(work.content ?? "");
  return {
    work: {
      id: work.id,
      universeId: work.projectId,
      title: work.title,
      type: work.type,
      audience: work.audience ?? "",
      status: work.status,
      description: work.description,
      adaptationBrief: obj(work.metadata).adaptation ?? "",
      imageStyle: work.imageStyle ?? "",
      imageStyleNegative: work.imageStyleNegative ?? "",
      parentId: work.parentId ?? null,
      partNumber: work.partNumber ?? null,
      arcId: work.arcId ?? null,
      actId: work.actId ?? null,
      words: work.words ?? countWords(content),
      updatedAt: work.updatedAt,
      ...(includeContent ? {
        content: content.slice(0, MAX_CONTENT_CHARS),
        contentTruncated: content.length > MAX_CONTENT_CHARS,
      } : {}),
    },
    parent: depth.parent ?? null,
    parts: asList(depth.parts).map(workLine),
    adaptedFrom: depth.adaptedFrom ?? null,
    adaptations: depth.adaptations ?? [],
    cast: asList(depth.cast).map((c) => ({ characterId: c.id, name: c.name, billing: c.billing })),
    arc: depth.arc ?? null,
    act: depth.act ?? null,
    acts: asList(depth.acts).map((a) => ({ id: a.id, actNumber: a.actNumber, title: a.title })),
    versions: asList(depth.drafts).map((d) => ({ id: d.id, words: d.words, reason: d.reason, createdAt: d.createdAt })),
  };
}

function workLine(w: JsonObject): JsonObject {
  return {
    id: w.id,
    title: w.title,
    type: w.type,
    audience: w.audience ?? "",
    status: w.status,
    partNumber: w.partNumber ?? null,
    words: w.words ?? 0,
    ...(w.partCount !== undefined ? { partCount: w.partCount } : {}),
    ...(w.adaptedFromId ? { adaptedFromId: w.adaptedFromId } : {}),
    ...(w.actId ? { actId: w.actId } : {}),
    description: clip(w.description, 300),
  };
}

function arcSummary(a: JsonObject): JsonObject {
  return {
    id: a.id,
    arcNumber: a.arcNumber,
    title: a.title,
    description: a.description,
    throughline: a.throughline,
    outOfScope: a.outOfScope ?? [],
    acts: asList(a.acts).map((act) => ({
      id: act.id, actNumber: act.actNumber, title: act.title, summary: act.summary, beats: act.beats ?? [],
    })),
    works: a.works ?? [],
  };
}

function pageSummary(p: JsonObject): JsonObject {
  return {
    id: p.id,
    pageNumber: p.pageNumber,
    note: p.note ?? "",
    afterParagraph: p.afterParagraph ?? null,
    panels: asList(p.panels).map((panel) => ({
      id: panel.id,
      panelNumber: panel.panelNumber,
      framing: panel.framing,
      description: panel.description,
      caption: panel.caption,
      dialogue: panel.dialogue ?? [],
      sfx: panel.sfx ?? [],
    })),
  };
}

function canonSummary(kind: CanonKind, r: JsonObject): JsonObject {
  return {
    kind,
    id: r.id,
    name: r[CANON_KINDS[kind].nameField] ?? r.name ?? r.title,
    summary: clip(r.description ?? r.role ?? r.principles ?? r.category ?? "", 280),
  };
}

function trimRecord(r: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(r)) {
    if (["sourceDraftId", "sourceTaskId"].includes(key)) continue;
    out[key] = typeof value === "string" ? clip(value, 2000) : value;
  }
  return out;
}

function proposalSummary(r: JsonObject, full = false): JsonObject {
  const payload = obj(r.payload);
  const about = pick(payload, ["workId", "arcId", "actId", "characterId", "locationId", "pageId", "panelId", "fields"]);
  const proposed = payload.proposed;
  const failed = obj(payload.failed);
  return {
    id: r.id,
    kind: r.artifactType,
    status: r.status,
    answered: Boolean(proposed),
    failed: failed.reason ? String(failed.reason) : null,
    about,
    brief: payload.brief ?? null,
    note: payload.note ?? null,
    acceptableHere: !String(r.artifactType).endsWith("_request")
      || (ACCEPTABLE_HERE as readonly string[]).includes(String(r.artifactType)),
    createdAt: r.createdAt,
    ...(full ? { proposed: clipDeep(proposed, MAX_CONTENT_CHARS) } : {}),
  };
}

// ---- small helpers ---------------------------------------------------------

function sendError(res: Response, err: unknown): void {
  if (err instanceof RequestError) {
    res.status(err.status).json({ error: err.message, ...(err.details ?? {}) });
    return;
  }
  if (err instanceof StorytimeConfigError) {
    res.status(503).json({ error: "Contesora is not configured on the gateway." });
    return;
  }
  if (err instanceof StorytimeUpstreamError) {
    const status = err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 502;
    res.status(status).json({ error: err.message, upstreamStatus: err.statusCode });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : "Contesora gateway request failed" });
}

function canonKind(req: Request): CanonKind {
  return oneOf(String(req.params.kind), Object.keys(CANON_KINDS) as CanonKind[], "kind");
}

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new RequestError(400, `${field} must be one of: ${allowed.map((a) => a || '""').join(", ")}.`);
  }
  return value as T;
}

function required(value: string | undefined, field: string): string {
  if (!value) throw new RequestError(400, `${field} is required.`);
  return value;
}

function param(req: Request, name: string): string {
  return String(req.params[name] ?? "");
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function obj(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function asList(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(obj) : [];
}

function pick(source: JsonObject, keys: string[]): JsonObject {
  const out: JsonObject = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function clip(value: unknown, max: number): string {
  const s = typeof value === "string" ? value : "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function clipDeep(value: unknown, max: number): unknown {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}\n\n[truncated]` : value;
  if (Array.isArray(value)) return value.map((v) => clipDeep(v, max));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as JsonObject).map(([k, v]) => [k, clipDeep(v, max)]));
  }
  return value;
}

function withSource<T extends JsonObject>(body: T): T & { source: string } {
  return { ...body, source: SOURCE };
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function countWords(value: string): number {
  return value.trim().match(/\S+/g)?.length ?? 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
