import type { CheckedItem } from "./register-check.service";

/**
 * Which strings of each kind of item the register check reads (ADR 0032, "What
 * is checked"): every string the item carries to a plugin.
 *
 * One list for the content services and the board's editors alike, so that
 * the mark an editor shows is the check a device's read makes, and a string
 * added to what a plugin is handed is added here or not at all.
 */

/** A news item's title, its paragraphs and its pictures' alternative texts. */
export function newsItemTexts(item: {
  title: string;
  paragraphs: readonly string[];
  pictures?: readonly { alt: string }[];
}): CheckedItem {
  return [
    item.title,
    ...item.paragraphs,
    ...(item.pictures ?? []).map((picture) => picture.alt),
  ];
}

/** An event's title, description, category and location. */
export function eventTexts(event: {
  title: string;
  description: string | null;
  category: string | null;
  location: string | null;
}): CheckedItem {
  return [event.title, event.description, event.category, event.location];
}

/** A meeting notice's place, digital participation and agenda titles. */
export function meetingNoticeTexts(notice: {
  place: string | null;
  digitalParticipation: string | null;
  agenda: readonly { title: string }[];
}): CheckedItem {
  return [
    notice.place,
    notice.digitalParticipation,
    ...notice.agenda.map((item) => item.title),
  ];
}

/** A bookable resource's name. */
export function bookableResourceTexts(resource: { name: string }): CheckedItem {
  return [resource.name];
}
