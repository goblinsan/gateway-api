import { describe, expect, it } from "vitest";
import { buildScheduledTagSpecs, selectLikeTarget } from "../jobs/kulrs_activity.js";

const SPRING_CALENDAR = {
  season: "spring",
  holidayThemes: ["Spring holidays"],
  holidayNotes: ["garden", "blossom", "fresh air"],
  weekend: false,
  summary: "Saturday, April 19, 2026 | spring in America/New_York | holiday windows: Spring holidays | weekend mood",
};

function makePalette(id: string, createdAt: string, likesCount: number) {
  return { id, createdAt, likesCount };
}

describe("buildScheduledTagSpecs", () => {
  it("does not auto-tag every palette as spring just because the calendar window is active", () => {
    const tags = buildScheduledTagSpecs({
      seed: "circuit",
      topic: "laser",
      calendar: SPRING_CALENDAR,
      signals: ["Voltage Mirage", "electric chrome after dark"],
    });

    expect(tags.map(tag => tag.slug)).not.toContain("spring");
    expect(tags.map(tag => tag.slug)).toContain("circuit");
    expect(tags.map(tag => tag.slug)).toContain("laser");
  });

  it("keeps spring tagging when the palette content is actually spring-coded", () => {
    const tags = buildScheduledTagSpecs({
      seed: "blossom",
      topic: "petals",
      calendar: SPRING_CALENDAR,
      signals: ["Blossom Arcade", "pastel petals and garden light"],
    });

    expect(tags.map(tag => tag.slug)).toContain("spring");
  });
});

describe("selectLikeTarget", () => {
  it("prefers recent low-like palettes and only excludes likes already made by the same bot", () => {
    const target = selectLikeTarget({
      bot: "mireille",
      nowMs: Date.parse("2026-04-19T16:30:00.000Z"),
      random: () => 0,
      activityLog: [
        {
          bot: "mireille",
          action: "LIKE",
          result: "ok",
          target: "recent-liked-by-mireille",
        },
        {
          bot: "nyx",
          action: "LIKE",
          result: "ok",
          target: "recent-liked-by-nyx",
        },
      ],
      feeds: {
        recent: [
          makePalette("recent-liked-by-nyx", "2026-04-19T15:40:00.000Z", 0),
          makePalette("recent-liked-by-mireille", "2026-04-19T15:35:00.000Z", 0),
          makePalette("recent-higher-like-count", "2026-04-19T15:30:00.000Z", 4),
        ],
        trending: [makePalette("trending-fallback", "2026-04-19T15:10:00.000Z", 6)],
        popular: [makePalette("popular-fallback", "2026-04-19T14:50:00.000Z", 10)],
      },
    });

    expect(target?.id).toBe("recent-liked-by-nyx");
    expect(target?._source).toBe("recent");
  });

  it("falls back to popular when newer feeds do not have an eligible palette", () => {
    const target = selectLikeTarget({
      bot: "mireille",
      nowMs: Date.parse("2026-04-19T16:30:00.000Z"),
      random: () => 0,
      activityLog: [],
      feeds: {
        recent: [makePalette("too-new", "2026-04-19T16:20:00.000Z", 0)],
        trending: [],
        popular: [makePalette("popular-fallback", "2026-04-19T14:50:00.000Z", 10)],
      },
    });

    expect(target?.id).toBe("popular-fallback");
    expect(target?._source).toBe("popular");
  });
});
