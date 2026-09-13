/**
 * Contesora's model, as the GPT is told it.
 *
 * One place for the lists the router validates against, the schema enumerates
 * and the guide explains, so the three cannot describe different products. The
 * lists themselves belong to Contesora (server/workForms.js and its canon
 * routes); a test in this repo holds them to the forms Contesora offers.
 */

/** What a work can be, and what its parts are made of. */
export const WORK_FORMS = {
  story: { label: "Story", parts: "chapters", content: "prose" },
  novel: { label: "Novel", parts: "chapters", content: "prose" },
  illustrated_novel: { label: "Illustrated novel", parts: "chapters", content: "prose, with full-page plates placed between passages" },
  childrens_book: { label: "Children's book", parts: "spreads", content: "20-60 read-aloud words per spread, with a plate each" },
  graphic_novel: { label: "Graphic novel", parts: "chapters", content: "a comic script; its pages and panels are records" },
  screenplay: { label: "Screenplay", parts: "sequences", content: "screenplay format" },
  play: { label: "Stage play", parts: "scenes", content: "a stage script" },
  storyboard: { label: "Storyboard", parts: "sequences", content: "numbered shots; its pages and panels are records" },
  podcast: { label: "Podcast", parts: "episodes", content: "an audio drama script" },
  promo_video: { label: "Promo video", parts: "segments", content: "shots with voiceover; its pages and panels are records" },
  campaign: { label: "Tabletop campaign", parts: "sessions", content: "prose" },
  game_concept: { label: "Game concept", parts: "sections", content: "prose" },
} as const;

export type WorkForm = keyof typeof WORK_FORMS;
export const WORK_FORM_KEYS = Object.keys(WORK_FORMS) as WorkForm[];

/** '' is no rating given. */
export const AUDIENCES = ["", "all_ages", "pg", "pg13", "r"] as const;

export const WORK_STATUSES = ["draft", "in_progress", "in_review", "completed", "accepted", "archived"] as const;

/**
 * The kinds of canon record, by the path segment the GPT uses, mapped to the
 * Contesora route that stores them and the field that names one.
 */
export const CANON_KINDS = {
  characters: { route: "/api/characters", nameField: "name", catalog: "characters" },
  locations: { route: "/api/locations", nameField: "name", catalog: "locations" },
  factions: { route: "/api/factions", nameField: "name", catalog: "factions" },
  "timeline-events": { route: "/api/timeline-events", nameField: "title", catalog: "timelineEvents" },
  bestiary: { route: "/api/bestiary", nameField: "name", catalog: "bestiary" },
  technologies: { route: "/api/technologies", nameField: "name", catalog: "technologies" },
} as const;

export type CanonKind = keyof typeof CANON_KINDS;
export const CANON_KIND_KEYS = Object.keys(CANON_KINDS) as CanonKind[];

/**
 * What Contesora's own agent can be asked to draft for a work. Each becomes a
 * proposal the author (or the GPT, through resolveProposal) accepts.
 */
export const WORK_ASKS = ["description", "content", "parts", "plates"] as const;
export type WorkAsk = (typeof WORK_ASKS)[number];

/** Proposal kinds resolveProposal can put in force on the server. */
export const ACCEPTABLE_HERE = [
  "work_canon_request",
  "work_parts_request",
  "work_plates_request",
  "work_panels_request",
  "arc_canon_request",
] as const;

/** Past this many words a part is written, and asking for its content revises it. */
export const WRITTEN_WORDS = 300;
