import { PAGE_CONTENT_LIMITS } from "../../page-content-limits.ts";
import { defineBlock } from "../definition.ts";
import { wordsOnly } from "../text-runs.ts";

/**
 * The association's own calendar, on a page.
 *
 * The block carries no dates in it - only how many of them to show. What it
 * becomes is resolved by the renderer against the reader's own session, so a
 * page carrying this block shows a visitor with no account the events published
 * to the street and a member the members' ones as well. Storing the dates in
 * the block instead would freeze one reader's answer into a page every reader
 * gets, and would put a member-only cleaning day into a public page's stored
 * body.
 *
 * How many places are gone is the most this block can ever say about who is
 * coming. Who has taken them is personal data about the association's own
 * residents, it is behind events:manage, and there is no field here that could
 * carry a name.
 */
export interface EventCalendarBlock {
  type: "eventCalendar";
  /** How many of the next dates to show, soonest first. */
  count: number;
}

export const eventCalendarBlock = defineBlock<EventCalendarBlock>()({
  type: "eventCalendar",
  schema: (zod) =>
    zod.strictObject({
      type: zod.literal("eventCalendar"),
      count: zod.int().min(1).max(PAGE_CONTENT_LIMITS.calendarCount),
    }),
  read: (stored) => {
    const count = stored["count"];
    // Dropped rather than clamped, for the reason the news teaser gives: a
    // count outside what this version knows is a block it cannot vouch for,
    // and showing some other number of dates would be a guess.
    return typeof count === "number" &&
      Number.isInteger(count) &&
      count >= 1 &&
      count <= PAGE_CONTENT_LIMITS.calendarCount
      ? { type: "eventCalendar", count }
      : null;
  },
  // An event's title is scanned where it is written.
  text: () => wordsOnly(""),
  editor: {
    label: "siteAdmin.editor.blocks.eventCalendar",
    // Offered here because no other screen would place it. Putting the next
    // dates on the front page is arranging the page, and how many dates to
    // show is the only thing to decide.
    insert: "siteAdmin.editor.add.eventCalendar",
    icon: "calendar",
    category: "association",
    nestable: false,
    /*
     * Three dates to begin with, which is what fits under a paragraph on a
     * front page without becoming the page. There is no zero to start from,
     * because a calendar block showing no dates is a block that renders as
     * nothing.
     */
    create: () => ({ type: "eventCalendar", count: 3 }),
  },
});
