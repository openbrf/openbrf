import { scannableRuns } from "../../scannable-text.ts";
import { defineBlock } from "../definition.ts";
import {
  keptRuns,
  readRunList,
  runsSchema,
  type TextRun,
} from "../text-runs.ts";

/**
 * The two forms the website offers people with no account.
 *
 * A form block takes a type and, at most, the sentence the board wants above
 * it. Nothing else: what the form asks for is fixed by this platform, not
 * configured per page. A field naming anything else is refused rather than
 * dropped: a body that tried to configure the form is told so, instead of
 * being stored without the part it sent.
 *
 * A form with nothing above it is still a form, unlike a paragraph with no
 * words in it: the block is the form, and the intro is decoration.
 *
 * Neither is offered by the page editor. Each is placed by the screen its
 * feature owns, and it is not nestable: the submit endpoints find the form on
 * the page they were posted to, and they look at the page's own blocks.
 */

/**
 * The form the website offers anyone who wants to write to the board.
 *
 * A block with almost nothing in it, and that is the design. The fields are
 * fixed - a name, an address to answer to, and the message - so the board
 * decides where the form sits on the page and never what it asks for. A form
 * whose fields were editable would be a form whose fields could ask for a
 * personal identity number, on a page anybody can read.
 *
 * The intro is the association's own sentence above it, and it is the only
 * content this block carries.
 */
export interface ContactFormBlock {
  type: "contactForm";
  intro?: TextRun[];
}

/**
 * The form a passer-by reports a broken door with.
 *
 * Fixed fields for the same reason as the contact form, plus one the board
 * does configure elsewhere: the issue types, which are offered here filtered to
 * the non-member audience. The block names none of them - which types exist is
 * read when the page is rendered, so a type deactivated this morning is gone
 * from the form this afternoon without anybody editing a page.
 *
 * The block renders as nothing while the association has public issue
 * reporting switched off, which is what lets a page carry it across the switch
 * being turned.
 */
export interface IssueReportFormBlock {
  type: "issueReportForm";
  intro?: TextRun[];
}

/** An intro that carries something, or none at all. */
function withIntro<T extends string>(
  type: T,
  intro: readonly TextRun[],
): { type: T; intro?: TextRun[] } {
  return intro.length === 0 ? { type } : { type, intro: [...intro] };
}

export const contactFormBlock = defineBlock<ContactFormBlock>()({
  type: "contactForm",
  schema: (zod) =>
    zod.strictObject({
      type: zod.literal("contactForm"),
      intro: runsSchema(zod).optional(),
    }),
  read: (stored) => withIntro("contactForm", readRunList(stored["intro"])),
  normalize: (block) => withIntro("contactForm", keptRuns(block.intro ?? [])),
  // The intro only. The labels and the button are chrome, translated rather
  // than written by the board, so they are not the board's text to be scanned
  // or held against them.
  text: (block) => scannableRuns(block.intro ?? []),
  editor: {
    label: "siteAdmin.editor.blocks.contactForm",
    insert: null,
    icon: "form",
    category: "association",
    nestable: false,
    create: () => ({ type: "contactForm" }),
  },
});

export const issueReportFormBlock = defineBlock<IssueReportFormBlock>()({
  type: "issueReportForm",
  schema: (zod) =>
    zod.strictObject({
      type: zod.literal("issueReportForm"),
      intro: runsSchema(zod).optional(),
    }),
  read: (stored) => withIntro("issueReportForm", readRunList(stored["intro"])),
  normalize: (block) =>
    withIntro("issueReportForm", keptRuns(block.intro ?? [])),
  text: (block) => scannableRuns(block.intro ?? []),
  editor: {
    label: "siteAdmin.editor.blocks.issueReportForm",
    insert: null,
    icon: "form",
    category: "association",
    nestable: false,
    create: () => ({ type: "issueReportForm" }),
  },
});
