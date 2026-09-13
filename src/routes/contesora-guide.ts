import { AUDIENCES, CANON_KIND_KEYS, WORK_FORMS, WORK_FORM_KEYS, WRITTEN_WORDS } from "./contesora-model.js";

/**
 * How the Contesora actions are meant to be used, for a GPT.
 *
 * An action description is capped at 300 characters, which is enough to say
 * what one call does and nowhere near enough to say how the calls fit together.
 * So the schema tells the GPT to read this first, and this is where the model,
 * the rules and the workflows live. Built from contesora-model.ts so the forms
 * and kinds it lists are the ones the actions accept.
 */
export function contesoraGuide(): string {
  const forms = WORK_FORM_KEYS
    .map((key) => `| \`${key}\` | ${WORK_FORMS[key].label} | ${WORK_FORMS[key].parts} | ${WORK_FORMS[key].content} |`)
    .join("\n");

  return `# Using Contesora

Contesora is a universe-first writing workspace. Call this guide once at the start of a session.

## The shape of it

- **Universe**: a setting. Holds canon, direction, arcs and works.
- **Direction** (on the universe): \`standingDirection\` (what the universe is always for), \`currentFocus\` (what matters now) and \`guardrails\` (rules no writing may break). **Read them with getUniverse before writing anything, and hold every word to the guardrails.**
- **Canon records**: ${CANON_KIND_KEYS.map((k) => `\`${k}\``).join(", ")}. Contesora stores records, not documents: a paragraph about six regions is six locations. Sort writing by what it is about, and write thin records rather than none (\`{name}\` is a valid place).
- **Arcs** have **acts** (title, summary, beats in order). A work can be built from an arc, and each of its parts can say which act it tells (\`actId\`).
- **Works** are what gets written. A work has a **form**, an **audience** and **parts**.

## Works

| form | label | parts | a part's content is |
| --- | --- | --- | --- |
${forms}

- Audiences: ${AUDIENCES.filter(Boolean).map((a) => `\`${a}\``).join(", ")}, or \`""\` for none. Write to the audience.
- **Parts** (chapters, spreads, episodes...) are works of their own with \`partNumber\`. A work made of parts keeps its prose in its parts, not in itself. Add them with addWorkPart, in order.
- **Adaptations**: createWork with \`adaptedFromId\` copies the source's cast and arc and makes one part per source part. \`adaptationBrief\` is the author's instruction for the whole adaptation (whose story it is now, what changes); Contesora's agent is held to it for every part. Change it with updateWork when the author reworks the idea.
- **Cast**: setWorkCast bills characters in order. Billing 1 is the lead.

## Editing is exact, and nothing is lost

- replaceWorkContent saves your text **exactly**. It never generates. The text it replaces is kept as a **version**: getWork lists versions; getWorkVersion reads one; restoreWorkVersion puts one back (and keeps what it replaces). Use it only after the author has seen or asked for the new text.
- updateWork changes fields (title, description, status, audience, adaptationBrief, image style, arcId, actId). It never changes content.
- \`description\` on a work or part is its plan: what happens in it. It is not shown in the reader; the prose is.
- getWork returns content up to 60,000 characters and says \`contentTruncated\` when there is more.

## Reviewing

- getReviewDossier returns a self-contained review packet for a work or part: its premise and beats, the text under review, the canon it draws on (characters, places, factions, timeline) and a review rubric. Review against it, not from memory.
- Give the author the review. When they approve a revision, write it and save it with replaceWorkContent.

## Graphic novels, storyboards and illustrated works

- getWorkPages returns a part's pages and their panels. For a graphic novel a page is a comic page; for an illustrated novel or children's book a page is a **plate** that falls between passages of the prose.
- A plate's \`afterParagraph\` is the number of prose passages before it. **Passages are split on blank lines** in the content; 0 opens the part. A plate with \`afterParagraph: null\` is read at the end.
- addWorkPage creates a page (or plate) with its panels in one call. A plate's panels are pictures: framing, what is drawn, an optional caption; no dialogue or sound. updateWorkPanel edits one panel.
- Images are drawn in Contesora itself; these actions write what a panel shows, not the picture.

## Contesora's own agent

askContesora files a request for Contesora's agent to draft something for a work: its \`description\`, its \`content\` (composed, or revised once it has more than ${WRITTEN_WORDS} words), its \`parts\`, or where its \`plates\` fall. It returns at once with a proposal id; the answer takes one to three minutes. Poll getProposal; it is ready when \`answered\` is true.

A proposal is **never in force until it is accepted**. The author sees it in Contesora too.
- resolveProposal \`accept\` puts it in force here for work descriptions and content, parts, plates, panels and arcs (fields and acts), and for dashboard-harness drafts. For other kinds it answers 422: those are accepted in Contesora.
- \`revise\` sends it back with a \`note\`; the agent answers the note and the proposal is replaced.
- \`refuse\` turns it down.

## Workflows

**Write a chapter.** getUniverse (direction) -> getWork (the work, its parts, cast, arc) -> getWork on the previous part for where it ends -> write -> show the author -> replaceWorkContent.

**Adapt a story into another form.** listWorks -> createWork with \`type\`, \`audience\`, \`adaptedFromId\` and an \`adaptationBrief\` -> getWork shows the parts it made -> write each part's content, or askContesora for \`content\` per part.

**Start a new work.** createWork -> addWorkPart for each part with a \`description\` of what happens -> write or ask for content.

**Build an illustrated chapter.** Write and save the prose -> askContesora \`plates\`, or addWorkPage per plate with \`afterParagraph\` -> getWorkPages to check where they fall.

**Put a new idea into canon.** searchCanon first, so nothing is duplicated -> upsertCanon per record (by \`id\`, or it matches an exact name) -> updateUniverse for direction, never canon, when it is a rule or a feeling rather than a fact.

## Limits

Each call must finish in 45 seconds and each response stays under 100,000 characters, so lists are capped and long text is truncated with a flag. Ask for less (a \`limit\`, a \`q\`, one work) rather than more.
`;
}
